import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { HEALTHFIT_DIR } from "../lib/config";
import { decodeFit } from "../lib/fit/decode";
import { normalizeFit } from "../lib/fit/normalize";
import {
  fingerprintSource,
  findNearDuplicate,
  importIndexKey,
  indexRecord,
  loadActivities,
  loadIndex,
  newestActivityAgeDays,
  replaceActivity,
  saveActivity,
  saveIndex,
  shouldImportSource,
  type ImportIndexEntry,
  type SourceFingerprint,
} from "../lib/store";
import type { StoredActivity } from "../lib/types";
import { fmtPace } from "../lib/weeks";
import { currentRestingHR, loadRecovery, restingHRAsOf, syncExternalRecovery } from "../lib/recovery";
import { temperatureAt } from "../lib/weather";
import { RUN_TYPES } from "../lib/weeks";

// ─── import ───────────────────────────────────────────────────────────────────
// Scans the HealthFit iCloud folder for FIT files, materializes dataless iCloud
// placeholders, CRC-validates, normalizes, dedupes, and writes data/activities/.
// Idempotent: processed files are recorded in .import-index.json; CRC failures are
// quarantined (NOT indexed) so a partially-synced file is retried next run.
//
// Usage: npm run import [dir]     (dir defaults to HEALTHFIT_DIR in lib/config.ts)

const PLACEHOLDER_RE = /^\.(.+\.fit)\.icloud$/i;

function candidateFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir);
  const names = new Set<string>();
  for (const e of entries) {
    if (/\.fit$/i.test(e)) names.add(e);
    const m = e.match(PLACEHOLDER_RE);
    if (m) names.add(m[1]); // evicted file — visible name it will have once downloaded
  }
  return [...names].sort();
}

function withIndexKey(entry: ImportIndexEntry, key: string): ImportIndexEntry {
  return typeof entry === "string" ? key : { ...entry, key };
}

// Force-download an evicted iCloud file and wait for it to land.
function materialize(p: string, timeoutMs = 30_000): boolean {
  try {
    execFileSync("brctl", ["download", p], { stdio: "ignore" });
  } catch {
    // brctl missing/failed — reading the file may still trigger materialization.
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = fs.statSync(p);
      if (st.size > 0) return true;
    } catch { /* not yet */ }
    execFileSync("sleep", ["1"]);
  }
  return false;
}

async function main() {
  const dir = process.argv[2] ?? HEALTHFIT_DIR;
  if (!fs.existsSync(dir)) {
    console.error(`HealthFit folder not found: ${dir}`);
    console.error("Install HealthFit, enable FIT auto-export → iCloud Drive, then re-run.");
    console.error("(Override the location with HEALTHFIT_DIR in .env.local.)");
    process.exit(1);
  }

  // Sweep iCloud for recovery rows the phone automation dropped off (HRV/RHR/sleep).
  const newRecoveryRows = syncExternalRecovery();
  if (newRecoveryRows > 0) console.log(`[import] merged ${newRecoveryRows} new recovery day(s) into data/recovery.csv\n`);

  const index = loadIndex();
  const files = candidateFiles(dir);
  const pending: string[] = [];

  for (const name of files) {
    const p = path.join(dir, name);
    let fingerprint: SourceFingerprint | undefined;
    try {
      const stat = fs.statSync(p);
      if (stat.size > 0) {
        fingerprint = fingerprintSource(fs.readFileSync(p));
      }
    } catch {
      // A new/changed iCloud placeholder is materialized in the processing loop.
    }

    const entry = index[name];
    if (shouldImportSource(entry, fingerprint)) {
      pending.push(name);
    } else if (entry != null && fingerprint != null &&
      (typeof entry === "string" || entry.fingerprint == null)) {
      // One-time, no-replay migration from the legacy filename → key index.
      index[name] = indexRecord(importIndexKey(entry)!, fingerprint);
    }
  }

  console.log(`[import] ${files.length} FIT file(s) in ${dir}`);
  console.log(`[import] ${pending.length} new or changed (${files.length - pending.length} unchanged)\n`);

  const imported: string[] = [];
  const quarantined: string[] = [];
  const skipped: string[] = [];
  let overwrites = 0;
  // Load recovery once, then choose only readings available as of each workout.
  const recoveryDays = loadRecovery();
  // In-memory store snapshot for near-duplicate checks (kept in sync as the batch
  // saves/replaces) — reloading the whole store per pending file is O(files × store).
  const stored = loadActivities();

  for (const name of pending) {
    const p = path.join(dir, name);

    if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
      if (!materialize(p)) {
        skipped.push(`${name} (iCloud download timed out — will retry next run)`);
        continue;
      }
    }

    let buf: Buffer;
    try {
      buf = fs.readFileSync(p);
    } catch (e) {
      skipped.push(`${name} (unreadable: ${(e as Error).message})`);
      continue;
    }
    // Fingerprint the exact bytes being decoded in case iCloud replaced the file
    // between the initial scan and this read.
    const fingerprint = fingerprintSource(buf);

    const decoded = decodeFit(new Uint8Array(buf));
    if (!decoded.ok) {
      quarantined.push(`${name} — ${decoded.reason}`);
      continue; // not indexed → retried next run
    }

    const sessionStart = decoded.messages.sessionMesgs?.[0]?.startTime;
    const hrRest = sessionStart instanceof Date
      ? restingHRAsOf(sessionStart, recoveryDays)
      : currentRestingHR(recoveryDays); // normalizeFit will reject a missing/invalid start
    const activity = normalizeFit(decoded.messages, name, { hrRest });
    if (!activity) {
      index[name] = indexRecord("skipped:no-session", fingerprint);
      skipped.push(`${name} (no session message — not a workout file)`);
      continue;
    }

    // Same workout arriving twice under slightly different start times (watch
    // recording + a Strava/third-party echo in Apple Health). Keep the richer copy:
    // GPS beats no-GPS; otherwise first-in wins.
    const dupe = findNearDuplicate(activity, stored);
    let replacesNearDuplicate: StoredActivity | null = null;
    if (dupe) {
      const newHasGps = activity.start_latlng?.length === 2;
      const oldHasGps = dupe.start_latlng?.length === 2;
      if (newHasGps && !oldHasGps) {
        // Defer removal until the richer copy has been written successfully.
        replacesNearDuplicate = dupe;
      } else {
        index[name] = indexRecord(`skipped:duplicate-of-${dupe.key}`, fingerprint);
        skipped.push(`${name} (near-duplicate of ${dupe.key} — same type/start/duration)`);
        continue;
      }
    }

    // Outdoor runs: true ambient temperature at the run's midpoint (Open-Meteo,
    // cached) OVERRIDES the wrist sensor, which skin heat skews outdoors. On
    // lookup failure the watch value stays — never clobber data with undefined.
    if (RUN_TYPES.includes(activity.type) && activity.start_latlng?.length === 2) {
      const midpoint = new Date(Date.parse(activity.start_date) + (activity.elapsed_time * 1000) / 2);
      const ambient = await temperatureAt(activity.start_latlng[0], activity.start_latlng[1], midpoint);
      if (ambient != null) activity.average_temp = ambient;
    }

    const result = replacesNearDuplicate
      ? replaceActivity(replacesNearDuplicate.key, activity)
      : saveActivity(activity);
    const { overwrote } = result;
    if (overwrote) overwrites++;
    if (replacesNearDuplicate) {
      stored.splice(stored.indexOf(replacesNearDuplicate), 1);
      for (const [src, entry] of Object.entries(index)) {
        if (src !== name && importIndexKey(entry) === replacesNearDuplicate.key) {
          index[src] = withIndexKey(entry, `skipped:duplicate-of-${result.activity.key}`);
        }
      }
      skipped.push(`(replaced near-duplicate ${replacesNearDuplicate.key} with GPS-bearing ${name})`);
    }
    const existingPosition = stored.findIndex(a => a.key === result.activity.key);
    if (existingPosition >= 0) stored.splice(existingPosition, 1);
    stored.push(result.activity);
    index[name] = indexRecord(result.activity.key, fingerprint);

    if (result.retainedExisting) {
      skipped.push(`${name} (same-key re-export contained less data; kept richer stored activity)`);
      continue;
    }

    const saved = result.activity;
    const mi = saved.distance > 0 ? `${(saved.distance / 1609.344).toFixed(2)}mi` : "—";
    const pace = saved.distance > 0 ? fmtPace(saved.average_speed) : "—";
    const hr = saved.average_heartrate ? `HR ${Math.round(saved.average_heartrate)}` : "no HR";
    const trimp = saved.trimp != null ? `TRIMP ${saved.trimp}` : "";
    imported.push(
      `  ${saved.start_date.slice(0, 10)} | ${saved.type.padEnd(14)} | ${mi.padStart(8)} | ${pace.padStart(9)} | ${hr} ${trimp}${overwrote ? " (overwrote)" : ""}`
    );
  }

  saveIndex(index);

  if (imported.length > 0) {
    console.log(`Imported ${imported.length} activit${imported.length === 1 ? "y" : "ies"}:`);
    imported.forEach(l => console.log(l));
  } else {
    console.log("Nothing new to import.");
  }
  if (overwrites > 0) console.log(`\n(${overwrites} re-export(s) overwrote an existing activity)`);
  if (quarantined.length > 0) {
    console.log(`\n⚠ QUARANTINED ${quarantined.length} (failed integrity — retried next run):`);
    quarantined.forEach(q => console.log(`  ${q}`));
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length}:`);
    skipped.forEach(s => console.log(`  ${s}`));
  }

  const age = newestActivityAgeDays();
  if (age != null) {
    const label = age < 1 ? "today" : `${age.toFixed(1)} days ago`;
    console.log(`\nFreshness: newest stored activity is from ${label}.`);
    if (age > 2.5) {
      console.log("  (!) Over 2.5 days old — if he's trained since, check that HealthFit");
      console.log("      auto-export is running (open the app once) and iCloud has synced.");
    }
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
