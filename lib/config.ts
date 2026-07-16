// ─── Central configuration ────────────────────────────────────────────────────
// Single source of truth for race, goal, and training-classification constants.
//
// ⚙️ ONBOARDING: the values marked "EDIT ME" get filled in during the first
// coaching session (see ONBOARDING.md). Sensible placeholders are provided so
// every script runs out of the box — but the coaching is only as good as these
// numbers, so set them early and update them as real data arrives.

// Race — EDIT ME during onboarding.
export const RACE_NAME = "Your Race";
export const RACE_DATE = new Date("2027-04-01T07:00:00-05:00"); // race morning, local time

// Coaching timezone — where the athlete trains. All day-of-week labels, dates, and
// Monday week-bucketing are computed in this zone so runs land on the day they were
// actually run (not shifted by a UTC midnight crossing). EDIT ME.
export function coachTZ(_date: Date = new Date()): string {
  return "America/New_York";
}

// Goal — EDIT ME during onboarding.
export const GOAL_TIME = "sub-4:00";
export const GOAL_PACE = "9:09/mi";
export const FLOOR_TIME = "finish strong"; // the fallback / B-goal
export const GOAL_MARATHON_SECONDS = 4 * 3600; // goal time in seconds

// ─── Known race / time-trial benchmarks ───────────────────────────────────────
// Real performances the VDOT estimate can anchor on. A single genuine benchmark
// beats any number inferred from training runs — add a 5K TT or race here and the
// estimate becomes trustworthy. distanceMeters: 5K=5000, 10K=10000, HM=21097.5,
// M=42195. Keep newest first. EDIT ME: add the athlete's real races/TTs.
export interface Benchmark {
  label: string;
  distanceMeters: number;
  timeSeconds: number;
  date: string; // approximate is fine; update when known
}
export const KNOWN_BENCHMARKS: Benchmark[] = [
  // Example (delete and replace):
  // { label: "5K road race", distanceMeters: 5000, timeSeconds: 24 * 60 + 30, date: "2027-01-15" },
];

// Physiology — the easy-run HR band. Easy runs are governed by HR + the talk test,
// not a fixed pace: hold the band, let pace float. EDIT ME once MAX_HR is set —
// a reasonable starting ceiling is ~77% of max HR; refine it from the athlete's own
// decoupling data with `npm run zones` after a few weeks of running.
export const EASY_HR_FLOOR = 130;
export const AEROBIC_THRESHOLD_BPM = 146; // the easy-run ceiling / talk-test cap

// Resting HR estimate — used by the Banister TRIMP computation (lib/fit/compute.ts).
// A config estimate until recovery metrics deliver the real daily value. EDIT ME.
export const HR_REST = 60;

// HR zone boundaries as fractions of MAX_HR. These start as the standard 5-zone
// model; once the athlete has a few weeks of runs, re-derive them from their own
// data with `npm run zones` (decoupling reveals the true aerobic threshold).
//   Z1 recovery · Z2 aerobic base (the bulk) · Z3 marathon/tempo ·
//   Z4 threshold · Z5 VO2max.
export const HR_ZONE_BOUNDS = [0.68, 0.77, 0.87, 0.93];

// ─── FIT ingestion (HealthFit → iCloud Drive → npm run import) ────────────────
import os from "os";
import path from "path";

// Where HealthFit auto-exports FIT files. HealthFit uses its own iCloud app
// container (shows as "HealthFit" in the Files app), NOT a folder under the
// general iCloud Drive root. Override with the HEALTHFIT_DIR env var.
export const HEALTHFIT_DIR =
  process.env.HEALTHFIT_DIR ??
  path.join(os.homedir(), "Library", "Mobile Documents", "iCloud~com~altifondo~HealthFit", "Documents");

// The splice date for an optional pre-existing history baseline (see
// lib/history-profile.ts). With no baseline file, all history comes from the FIT
// store and this date is effectively ignored — leave it in the past.
export const FIT_SOURCE_SINCE = new Date("2000-01-03T00:00:00-05:00");

// ─── Shoe periods (FIT has no gear field — date-range map, newest first) ──────
// A `shoes: <name>` token in data/notes.md overrides per-day. EDIT ME during
// onboarding with the athlete's rotation; retire trainers around 300-500mi.
export interface ShoePeriod {
  name: string;
  from: string; // ISO date, inclusive
  to?: string;  // ISO date, exclusive; open-ended if absent
}
export const SHOE_PERIODS: ShoePeriod[] = [
  // Example (delete and replace):
  // { name: "Nike Pegasus 41", from: "2027-01-01" },
];
export const SHOE_LIFETIME_BASE_MILES: Record<string, number> = {
  // Miles already on each shoe before this system started tracking, e.g.
  // "Nike Pegasus 41": 120,
};

export function shoeForDate(date: Date): string | undefined {
  // Coach-TZ calendar date, not UTC — an evening run can be the next UTC day and
  // would match the wrong period once the rotation has date ranges.
  const iso = date.toLocaleDateString("en-CA", { timeZone: coachTZ(date) });
  for (const p of SHOE_PERIODS) {
    if (iso >= p.from && (!p.to || iso < p.to)) return p.name;
  }
  return undefined;
}

// Max HR — used to gauge how hard a run actually was (HR relative to max, not an
// assumed intensity, sets the effort level in the VDOT estimate). EDIT ME: use a
// real observed max if one exists; otherwise 208 − 0.7×age (Tanaka) is a better
// starting formula than 220 − age. Update the moment a true max is recorded
// (e.g. the end of a hard 5K or hill session).
export const MAX_HR = 190;

// Quality-run classification thresholds (shared by isQualityEffort below).
// EDIT ME relative to the athlete: quality HR ≈ just above their easy ceiling;
// quality pace ≈ clearly faster than their easy pace.
export const QUALITY_HR_BPM = 152;     // avg HR at/above this = quality effort
export const QUALITY_PACE_SECS = 540;  // pace faster than this (9:00/mi) = quality effort

// History window for the optional legacy Strava pull (build-history).
export const HISTORY_SINCE_DATE = new Date("2026-01-01T00:00:00-05:00");

// ─── Shared quality-effort classifier ─────────────────────────────────────────
// One implementation used by both the live pipeline (ActivitySummary) and the
// history builder (raw StravaActivity), so the two can never drift.
//
// A run counts as "quality" if average HR is at/above QUALITY_HR_BPM, OR it was
// run faster than QUALITY_PACE_SECS for at least 2 miles. On hot days the pace
// threshold is loosened by 10 sec/mile per 5°F above 80°F, since the same effort
// yields a slower pace in heat (outdoors only — treadmills are climate-controlled).
//
// Treadmill pace is trusted when the athlete's watch syncs belt speed via GymKit
// (Apple Watch + a GymKit-enabled treadmill); a genuine fast treadmill effort then
// counts as quality on pace, exactly like an outdoor run. `isTreadmill` is still
// passed in, but only to keep the heat adjustment outdoors-only.
export function isQualityEffort(opts: {
  avgHR?: number;
  paceSecondsPerMile?: number;
  distanceMiles: number;
  avgTempF?: number;
  isTreadmill?: boolean;
}): boolean {
  if (opts.avgHR != null && opts.avgHR >= QUALITY_HR_BPM) return true;

  if (opts.paceSecondsPerMile != null && opts.paceSecondsPerMile > 0) {
    let threshold = QUALITY_PACE_SECS;
    // Heat only slows pace outdoors; a treadmill room is climate-controlled.
    if (!opts.isTreadmill && opts.avgTempF != null && opts.avgTempF > 80) {
      threshold += Math.floor((opts.avgTempF - 80) / 5) * 10;
    }
    return opts.paceSecondsPerMile < threshold && opts.distanceMiles >= 2;
  }

  return false;
}

// Treadmill/indoor detection. The `trainer` flag is the primary signal; a run
// with no GPS fix and zero elevation gain is the fallback heuristic. The flag is
// context, not distrust: with GymKit belt-speed sync + a chest strap, indoor
// pace/distance/HR are accurate. A treadmill is still worth knowing about because
// it's flat, wind-free, and climate-controlled (no hill or heat stimulus).
export function isTreadmillRun(opts: {
  trainer?: boolean;
  hasGps?: boolean;
  elevationGain?: number;
}): boolean {
  if (opts.trainer === true) return true;
  return opts.hasGps === false && (opts.elevationGain ?? 0) === 0;
}
