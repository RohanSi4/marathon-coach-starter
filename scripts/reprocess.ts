import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import fs from "fs";
import path from "path";
import { HEALTHFIT_DIR } from "../lib/config";
import { decodeFit, type FitMessages } from "../lib/fit/decode";
import { normalizeFit } from "../lib/fit/normalize";
import { loadActivities, saveActivity } from "../lib/store";
import { loadRecovery, restingHRAsOf, type RecoveryDay } from "../lib/recovery";
import type { StoredActivity } from "../lib/types";

// ─── reprocess ─────────────────────────────────────────────────────────────────
// Derived fields (HR zones, TRIMP, splits, drift, decoupling) are baked into
// data/activities/ at import time, so a config change (e.g. HR_ZONE_BOUNDS,
// MAX_HR) silently leaves the archive scored against the OLD bands. This script
// re-runs the importer's own decode → normalize path over every FIT-backed
// activity and rewrites just the derived fields — config changes become
// retroactive. Strava-era activities (no FIT file) are never touched; identity,
// notes-channel joins, shoe logic, and the Open-Meteo temperature enrichment all
// live outside these fields and are preserved exactly.
//
// Usage: npm run reprocess [dir] [--dry-run]   (dir defaults to HEALTHFIT_DIR)

// The fields normalizeFit computes from the raw record stream + config. Everything
// else on the stored activity (identity, session stats, temperature, RPE) is kept.
export const DERIVED_FIELDS = ["splits", "hrZones", "hrDriftBpm", "trimp", "decouplingPct", "strideBlips"] as const;
type DerivedField = (typeof DERIVED_FIELDS)[number];

export function shouldReprocess(a: StoredActivity): boolean {
  return a.source === "fit" && !!a.sourceFile;
}

// Recompute the derived fields from decoded FIT messages via the importer's own
// normalizeFit, merge them onto the stored activity, and report what changed.
// Undefined fresh values delete the key (mirrors import: absent, not null).
export function recomputeDerived(
  stored: StoredActivity,
  messages: FitMessages,
  recoveryDays: RecoveryDay[]
): { updated: StoredActivity; changedFields: DerivedField[] } | { error: string } {
  const hrRest = restingHRAsOf(stored.start_date, recoveryDays);
  const fresh = normalizeFit(messages, stored.sourceFile, { hrRest });
  if (!fresh) return { error: "no session message" };

  const updated: StoredActivity = { ...stored };
  const changedFields: DerivedField[] = [];
  for (const f of DERIVED_FIELDS) {
    const before = JSON.stringify(stored[f] ?? null);
    const after = JSON.stringify(fresh[f] ?? null);
    if (fresh[f] === undefined) delete updated[f];
    else (updated as unknown as Record<string, unknown>)[f] = fresh[f];
    if (before !== after) changedFields.push(f);
  }
  return { updated, changedFields };
}

// One-line description of a change for the dry-run sample, e.g.
//   trimp 41→43 · hrZones Z1<131→<135 (Z1 112s→98s, Z2 2103s→2117s)
function describeChange(field: DerivedField, before: StoredActivity, after: StoredActivity): string {
  if (field === "hrZones") {
    const b = before.hrZones ?? [];
    const a = after.hrZones ?? [];
    const parts: string[] = [];
    for (const za of a) {
      const zb = b.find(z => z.zone === za.zone);
      if (!zb) { parts.push(`Z${za.zone} —→${za.seconds}s`); continue; }
      if (zb.seconds !== za.seconds) parts.push(`Z${za.zone} ${zb.seconds}s→${za.seconds}s`);
      else if (zb.minBpm !== za.minBpm || zb.maxBpm !== za.maxBpm) {
        parts.push(`Z${za.zone} bounds ${zb.minBpm}-${zb.maxBpm}→${za.minBpm}-${za.maxBpm}`);
      }
    }
    return `hrZones ${parts.join(", ") || "(rebucketed)"}`;
  }
  if (field === "splits") {
    return `splits recomputed (${before.splits?.length ?? 0}→${after.splits?.length ?? 0} miles)`;
  }
  if (field === "strideBlips") {
    return `strideBlips ${before.strideBlips?.length ?? 0}→${after.strideBlips?.length ?? 0}`;
  }
  const bv = before[field];
  const av = after[field];
  return `${field} ${bv ?? "—"}→${av ?? "—"}`;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dir = args.find(a => !a.startsWith("--")) ?? HEALTHFIT_DIR;

  const all = loadActivities();
  const recoveryDays = loadRecovery();
  console.log(`[reprocess] ${all.length} stored activities · date-specific resting HR · bounds from lib/config.ts${dryRun ? " · DRY RUN" : ""}\n`);

  let recomputed = 0;
  let changed = 0;
  let skippedStrava = 0;
  let skippedNoFit = 0;
  let errors = 0;
  const samples: string[] = [];

  for (const a of all) {
    if (!shouldReprocess(a)) { skippedStrava++; continue; }

    const fitPath = path.join(dir, a.sourceFile!);
    if (!fs.existsSync(fitPath) || fs.statSync(fitPath).size === 0) { skippedNoFit++; continue; }

    let buf: Buffer;
    try {
      buf = fs.readFileSync(fitPath);
    } catch { skippedNoFit++; continue; }

    const decoded = decodeFit(new Uint8Array(buf));
    if (!decoded.ok) { errors++; console.warn(`  (!) ${a.key}: ${decoded.reason}`); continue; }

    const result = recomputeDerived(a, decoded.messages, recoveryDays);
    if ("error" in result) { errors++; console.warn(`  (!) ${a.key}: ${result.error}`); continue; }
    recomputed++;

    if (result.changedFields.length > 0) {
      changed++;
      if (samples.length < 5) {
        const detail = result.changedFields.map(f => describeChange(f, a, result.updated)).join(" · ");
        samples.push(`  ${a.start_date.slice(0, 10)} ${a.type.padEnd(14)} ${detail}`);
      }
      if (!dryRun) saveActivity(result.updated);
    }
  }

  if (samples.length > 0) {
    console.log(`${dryRun ? "Would change" : "Changed"} (first ${samples.length} of ${changed}):`);
    samples.forEach(s => console.log(s));
    console.log();
  }
  console.log(`Summary: ${all.length} scanned · ${recomputed} recomputed · ${changed} ${dryRun ? "would change" : "changed"} · ` +
    `${skippedStrava} strava-era (untouched) · ${skippedNoFit} no FIT file (kept as-is) · ${errors} errors`);
  if (dryRun && changed > 0) console.log("\nRe-run without --dry-run to write.");
}

// Run only when executed directly (tsx scripts/reprocess.ts) — the test imports
// the pure helpers above without triggering a store-wide pass. Exact-basename
// match: a prefix test also matched "reprocess.test.ts" when the test runner
// spawned it as its own process, and main() fired mid-test-suite.
if (process.argv[1] && path.basename(process.argv[1]) === "reprocess.ts") {
  main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
}
