// ─── Local activity store (data/activities/) ─────────────────────────────────
// One JSON per activity, filename derived deterministically from the dedupe key so
// a HealthFit re-export of an edited workout overwrites its own file. The directory
// is committed to git — it IS the training archive now, and git is its backup.
// `.import-index.json` maps processed source filenames → keys/content fingerprints
// for fast idempotent re-runs that still notice an edited HealthFit export.
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type { StoredActivity } from "./types";

export const DEFAULT_ACTIVITIES_DIR = path.join(process.cwd(), "data", "activities");
const INDEX_FILE = ".import-index.json";

export interface SourceFingerprint {
  algorithm: "sha256";
  size: number;
  digest: string;
}

export interface ImportIndexRecord {
  key: string;
  fingerprint?: SourceFingerprint;
}

// Older indexes map filenames directly to keys. Keep accepting that shape while
// writing fingerprinted records for files seen by newer importer versions.
export type ImportIndexEntry = string | ImportIndexRecord;

export interface ImportIndex {
  [sourceFile: string]: ImportIndexEntry; // source FIT filename → import result
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// "2026-07-01T13:00:00.000Z_Run" → "2026-07-01T130000Z_Run.json" (filesystem-safe,
// sorts chronologically in `ls`).
export function activityFilename(key: string): string {
  return key.replace(/:/g, "").replace(/\.\d{3}Z/, "Z").replace(/[^\w.-]/g, "_") + ".json";
}

export function loadIndex(dir: string = DEFAULT_ACTIVITIES_DIR): ImportIndex {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), "utf-8")) as ImportIndex;
  } catch {
    return {};
  }
}

export function saveIndex(index: ImportIndex, dir: string = DEFAULT_ACTIVITIES_DIR): void {
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify(index, null, 2));
}

export function importIndexKey(entry: ImportIndexEntry | undefined): string | undefined {
  return typeof entry === "string" ? entry : entry?.key;
}

export function fingerprintSource(data: Uint8Array): SourceFingerprint {
  return {
    algorithm: "sha256",
    size: data.byteLength,
    digest: createHash("sha256").update(data).digest("hex"),
  };
}

export function fingerprintsEqual(a: SourceFingerprint, b: SourceFingerprint): boolean {
  return a.algorithm === b.algorithm && a.size === b.size && a.digest === b.digest;
}

// Legacy string entries have no baseline fingerprint. The importer upgrades them
// in place without replaying the full archive; once upgraded, content changes are
// detected even if HealthFit reuses the same filename.
export function shouldImportSource(
  entry: ImportIndexEntry | undefined,
  currentFingerprint: SourceFingerprint | undefined
): boolean {
  if (entry == null) return true;
  if (typeof entry === "string" || entry.fingerprint == null || currentFingerprint == null) return false;
  return !fingerprintsEqual(entry.fingerprint, currentFingerprint);
}

export function indexRecord(key: string, fingerprint: SourceFingerprint): ImportIndexRecord {
  return { key, fingerprint };
}

// Returns true if this exact activity key already exists (from any source file).
export function hasActivity(key: string, dir: string = DEFAULT_ACTIVITIES_DIR): boolean {
  return fs.existsSync(path.join(dir, activityFilename(key)));
}

export interface SaveActivityResult {
  overwrote: boolean;
  retainedExisting: boolean;
  activity: StoredActivity;
}

function validGps(a: StoredActivity): boolean {
  return a.start_latlng?.length === 2;
}

// Scores data coverage, not the values themselves, so a same-shape edited export
// can still update distance/time/etc. GPS is weighted most heavily because it
// unlocks weather and route-aware analysis; derived arrays and sensor channels
// account for the rest.
export function activityRichness(a: StoredActivity): number {
  let score = validGps(a) ? 100 : 0;
  if (a.splits?.length) score += 2 + Math.min(a.splits.length, 20) / 20;
  if (a.hrZones?.length) score += 2;
  const optional: Array<unknown> = [
    a.average_heartrate, a.max_heartrate, a.average_watts, a.weighted_average_watts,
    a.calories, a.average_cadence, a.average_temp, a.perceivedExertion, a.description,
    a.hrDriftBpm, a.trimp, a.decouplingPct, a.fitSport,
  ];
  score += optional.filter(value => value != null && value !== "").length;
  return score;
}

function writeActivityAtomic(file: string, a: StoredActivity): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(a, null, 2));
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function saveActivity(a: StoredActivity, dir: string = DEFAULT_ACTIVITIES_DIR): SaveActivityResult {
  ensureDir(dir);
  const file = path.join(dir, activityFilename(a.key));
  const overwrote = fs.existsSync(file);
  if (overwrote) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, "utf-8")) as StoredActivity;
      if (existing.key === a.key && activityRichness(existing) > activityRichness(a)) {
        return { overwrote: false, retainedExisting: true, activity: existing };
      }
    } catch {
      // An unreadable destination should be repaired by the valid candidate.
    }
  }
  writeActivityAtomic(file, a);
  return { overwrote, retainedExisting: false, activity: a };
}

// Replacements are ordered so the new activity is durably present before the old
// file is removed. Keys within the same second can produce the same legacy-safe
// filename; in that case the atomic rename is the replacement and no unlink runs.
export function replaceActivity(
  oldKey: string,
  replacement: StoredActivity,
  dir: string = DEFAULT_ACTIVITIES_DIR
): SaveActivityResult {
  const oldFile = path.join(dir, activityFilename(oldKey));
  const newFile = path.join(dir, activityFilename(replacement.key));
  const result = saveActivity(replacement, dir);
  if (oldFile !== newFile) deleteActivity(oldKey, dir);
  return result;
}

// Near-duplicate detector: the same workout can reach Apple Health twice (watch
// recording + a third-party echo, e.g. Strava writing its copy back), producing two
// FIT files whose start times differ by seconds — which slips past the exact-key
// dedupe. (Found 2026-07-03: a half-marathon once existed as both "…-Apple
// Watch.fit" and "…-Strava.fit", 4s apart, double-counting 13.1mi.) Same type,
// starts within `toleranceSec`, durations within 10% ⇒ same physical workout.
export function findNearDuplicate(
  candidate: StoredActivity,
  existing: StoredActivity[],
  toleranceSec = 120
): StoredActivity | null {
  const t = Date.parse(candidate.start_date);
  for (const a of existing) {
    if (a.key === candidate.key || a.type !== candidate.type) continue;
    if (Math.abs(Date.parse(a.start_date) - t) > toleranceSec * 1000) continue;
    const d1 = candidate.moving_time || candidate.elapsed_time;
    const d2 = a.moving_time || a.elapsed_time;
    if (d1 > 0 && d2 > 0 && Math.abs(d1 - d2) / Math.max(d1, d2) > 0.10) continue;
    return a;
  }
  return null;
}

export function deleteActivity(key: string, dir: string = DEFAULT_ACTIVITIES_DIR): void {
  const file = path.join(dir, activityFilename(key));
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// All stored activities, sorted chronologically. `sinceUnix` (seconds) filters by
// start time — pass getWeekStartUnix() for "this week".
export function loadActivities(sinceUnix?: number, dir: string = DEFAULT_ACTIVITIES_DIR): StoredActivity[] {
  if (!fs.existsSync(dir)) return [];
  const out: StoredActivity[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f === INDEX_FILE) continue;
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as StoredActivity;
      if (sinceUnix != null && Date.parse(a.start_date) / 1000 < sinceUnix) continue;
      out.push(a);
    } catch {
      console.warn(`  (!) Skipping unreadable activity file: ${f}`);
    }
  }
  return out.sort((a, b) => Date.parse(a.start_date) - Date.parse(b.start_date));
}

// Age (days) of the newest stored activity — the freshness signal coach-data prints
// so a silent HealthFit/iCloud stall is always visible.
export function newestActivityAgeDays(dir: string = DEFAULT_ACTIVITIES_DIR): number | null {
  const all = loadActivities(undefined, dir);
  if (all.length === 0) return null;
  const newest = Date.parse(all[all.length - 1].start_date);
  return (Date.now() - newest) / 86_400_000;
}
