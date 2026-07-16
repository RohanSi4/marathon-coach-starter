import test from "node:test";
import assert from "node:assert/strict";
import { estimateCurrentVDOT, isQualityRun } from "../lib/coach-prompt";
import { raceVDOT, vdotFromHRPace, predictRaceSeconds, equivalentRaces } from "../lib/vdot";
import { compactRun } from "../lib/run-format";
import { MAX_HR } from "../lib/config";
import type { AthleteProfile, HistoricalWeek, ActivitySummary, StravaActivity } from "../lib/types";

// ─── Daniels model: validate against known VDOT anchors ───────────────────────

test("raceVDOT: sub-20 5K ≈ VDOT 50 (the canonical anchor)", () => {
  assert.equal(Math.round(raceVDOT(5000, 20 * 60)), 50);
});

test("raceVDOT: 1:59 half marathon ≈ VDOT 37", () => {
  const v = Math.round(raceVDOT(21097.5, 1 * 3600 + 59 * 60));
  assert.ok(v >= 36 && v <= 38, `expected ~37, got ${v}`);
});

test("raceVDOT: 3:45 marathon ≈ VDOT 41 (== the goal)", () => {
  const v = Math.round(raceVDOT(42195, 3 * 3600 + 45 * 60));
  assert.equal(v, 41);
});

test("raceVDOT: 3:00 marathon ≈ VDOT 53 (faster time = higher VDOT)", () => {
  const v = Math.round(raceVDOT(42195, 3 * 3600));
  assert.ok(v >= 52 && v <= 54, `expected ~53, got ${v}`);
});

test("predictRaceSeconds is the inverse of raceVDOT", () => {
  const t = predictRaceSeconds(45, 10000);
  assert.equal(Math.round(raceVDOT(10000, t)), 45);
});

test("equivalentRaces at VDOT 41 predicts a ~3:45 marathon", () => {
  assert.match(equivalentRaces(41).m, /^3:4[45]/);
});

test("vdotFromHRPace: 8:03/mi at HR 163 (84% of 195 max) reads ~50, not 41", () => {
  // He holds back, so HR (not an assumed threshold) sets effort: 163/195 = 84% max
  // is marathon effort, so his engine is ~50 — NOT the ~41 you'd get by pretending
  // that run was a maximal threshold effort.
  const v = Math.round(vdotFromHRPace(8 * 60 + 3, 163, 195));
  assert.ok(v >= 48 && v <= 52, `expected ~50, got ${v}`);
});

test("vdotFromHRPace: same pace at a HIGHER HR reads LOWER (he was working harder for it)", () => {
  const easier = vdotFromHRPace(8 * 60 + 3, 160, 195); // 82% max
  const harder = vdotFromHRPace(8 * 60 + 3, 180, 195); // 92% max
  assert.ok(harder < easier, "same pace at higher HR = less fit");
});

// ─── estimateCurrentVDOT: only trusts sustained hard efforts ──────────────────

function week(keyRuns: string[]): HistoricalWeek {
  return {
    weekStarting: "Jun 1, 2026", runMiles: 20, runDays: 4, longRunMiles: 8,
    liftDays: 0, crossTrainingDays: 0, sufferTotal: 0,
    qualityRuns: keyRuns.length, keyRuns, injuryNotes: [],
  };
}
function profile(weeks: HistoricalWeek[]): AthleteProfile {
  return {
    generatedAt: "2026-06-01T00:00:00Z", sinceDate: "2026-01-01T00:00:00Z",
    totalActivities: 0, weeks, peakWeekMiles: 20, peakWeekOf: "Jun 1, 2026",
    longestRun: 8, longestRunDate: "Jun 1, 2026", injuryLog: [],
  };
}

test("estimateCurrentVDOT returns null for a null profile", () => {
  assert.equal(estimateCurrentVDOT(null), null);
});

test("estimateCurrentVDOT ignores pace-only (no-HR) runs — needs HR to trust it", () => {
  // A fast run with no HR is NOT a trustworthy threshold signal.
  const p = profile([week(["★6.7mi@8:03/mi", "★5.7mi@8:16/mi"])]);
  assert.equal(estimateCurrentVDOT(p), null);
});

test("estimateCurrentVDOT ignores easy runs (HR below 80% of max)", () => {
  // 142 and 150 are both < 80% of 195 (156) — easy runs, and the HR→VO2max method
  // is unreliable there anyway.
  const p = profile([week(["7.6mi@9:47/mi(HR142)", "5.0mi@9:30/mi(HR150)"])]);
  assert.equal(estimateCurrentVDOT(p), null);
});

test("estimateCurrentVDOT ignores sprints under 2mi", () => {
  const p = profile([week(["★1.0mi@6:30/mi(HR185)"])]);
  assert.equal(estimateCurrentVDOT(p), null);
});

test("estimateCurrentVDOT reads a sustained hard effort as his real engine (~50, not 41)", () => {
  const p = profile([week(["★9.3mi@8:03/mi(HR163)"])]);
  const r = estimateCurrentVDOT(p);
  assert.notEqual(r, null);
  assert.ok(r!.vdot >= 48 && r!.vdot <= 52, `expected ~50, got ${r!.vdot}`);
});

test("estimateCurrentVDOT counts a short-but-hard effort (≥2mi, ≥80% max)", () => {
  const p = profile([week(["★3.1mi@7:50/mi(HR172)"])]);
  const r = estimateCurrentVDOT(p);
  assert.notEqual(r, null, "3.1mi at 88% max is a valid VO2max signal");
});

test("estimateCurrentVDOT includes GymKit treadmill (tm) hard efforts", () => {
  const p = profile([week(["★9.3mi@8:03/mi(tm)(HR163)"])]);
  const r = estimateCurrentVDOT(p);
  assert.notEqual(r, null, "(tm) run with HR + distance should count");
  assert.ok(r!.vdot >= 48 && r!.vdot <= 52);
});

// ─── WRITE→READ coupling guard ────────────────────────────────────────────────
// estimateCurrentVDOT parses keyRuns strings with regexes; those strings are
// PRODUCED by compactRun (lib/run-format.ts, used by build-history). These two
// sides can silently drift — a format tweak in compactRun would make the parse
// return null and quietly zero out the engine estimate with no error. This test
// pins the roundtrip: real compactRun output must parse back to the right VDOT.

function stravaRun(over: Partial<StravaActivity>): StravaActivity {
  return {
    id: 1, name: "Run", type: "Run", sport_type: "Run",
    start_date: "2026-06-01T15:00:00Z",
    distance: 4.0 * 1609.344, moving_time: 4 * 480, elapsed_time: 4 * 480,
    average_speed: 1609.344 / 480, max_speed: 5, total_elevation_gain: 0,
    ...over,
  };
}

test("compactRun → estimateCurrentVDOT roundtrips (guards the write/read format)", () => {
  // A real 4mi hard treadmill effort: HR 165 (~85-87% of MAX_HR), 8:00/mi.
  const a = stravaRun({ average_heartrate: 165, trainer: true, start_latlng: [] });
  const key = compactRun(a, null);
  // Sanity: the produced string has the shape the parser expects.
  assert.match(key, /4\.0mi@8:00\/mi\(tm\)\(HR165\)/, `unexpected compactRun format: ${key}`);

  const r = estimateCurrentVDOT(profile([week([key])]));
  assert.notEqual(r, null, `compactRun output "${key}" failed to parse in estimateCurrentVDOT`);
  assert.equal(r!.vdot, Math.round(vdotFromHRPace(480, 165, MAX_HR)));
});

test("compactRun with a description note still parses (note can't shadow the fields)", () => {
  // A note containing digits/@ must not be picked up before the real pace/distance.
  const a = stravaRun({ average_heartrate: 168, description: "felt 8/10 @ tempo, 2mi in" });
  const key = compactRun(a, a);
  const r = estimateCurrentVDOT(profile([week([key])]));
  assert.notEqual(r, null, `note-bearing compactRun output "${key}" failed to parse`);
  assert.equal(r!.vdot, Math.round(vdotFromHRPace(480, 168, MAX_HR)));
});

// ─── isQualityRun ─────────────────────────────────────────────────────────────

function activity(over: Partial<ActivitySummary>): ActivitySummary {
  return {
    type: "Run", name: "Run", dayOfWeek: "Monday", date: "Jun 1",
    distanceMiles: 6, durationFormatted: "60m", paceFormatted: "9:30/mi",
    elevationFt: 0, ...over,
  };
}

test("isQualityRun: high-HR run (avgHR 165) is quality", () => {
  assert.equal(isQualityRun(activity({ avgHR: 165, paceFormatted: "9:30/mi" })), true);
});

test("isQualityRun: slow easy run (10:30/mi, low HR) is not quality", () => {
  assert.equal(isQualityRun(activity({ avgHR: 138, paceFormatted: "10:30/mi" })), false);
});
