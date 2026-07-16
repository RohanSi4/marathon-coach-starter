import test from "node:test";
import assert from "node:assert/strict";
import { buildCoachingUserMessage, computeACWR } from "../lib/coach-prompt";
import type { ActivitySummary, AthleteProfile, HistoricalWeek } from "../lib/types";

// Minimal HistoricalWeek factory — only runMiles matters for computeACWR.
function week(runMiles: number): HistoricalWeek {
  return {
    weekStarting: "Jun 1, 2026",
    runMiles,
    runDays: 4,
    longRunMiles: runMiles / 3,
    liftDays: 0,
    crossTrainingDays: 0,
    sufferTotal: 0,
    qualityRuns: 0,
    keyRuns: [],
    injuryNotes: [],
  };
}

function profile(milesByWeek: number[]): AthleteProfile {
  return {
    generatedAt: "2026-06-01T00:00:00Z",
    sinceDate: "2026-01-01T00:00:00Z",
    totalActivities: 0,
    weeks: milesByWeek.map(week),
    peakWeekMiles: Math.max(...milesByWeek, 0),
    peakWeekOf: "Jun 1, 2026",
    longestRun: 10,
    longestRunDate: "Jun 1, 2026",
    injuryLog: [],
  };
}

test("computeACWR returns null ratio with no chronic history", () => {
  const r = computeACWR(null, 20);
  assert.equal(r.ratio, null);
  assert.equal(r.reliable, false);
  assert.match(r.status, /insufficient/i);
  assert.match(r.status, /comeback/i);
});

test("computeACWR describes 0.8–1.3 as steady relative load", () => {
  // chronic = avg(28,30,30,32) = 30; acute = 33 → ratio 1.1
  const r = computeACWR(profile([28, 30, 30, 32]), 33);
  assert.equal(r.chronic, 30);
  assert.equal(r.ratio, 1.1);
  assert.equal(r.reliable, true);
  assert.match(r.status, /steady relative load/i);
});

test("computeACWR flags a large mileage spike without claiming injury prediction", () => {
  // chronic = 30; acute = 50 → ratio ~1.67 (>1.5)
  const r = computeACWR(profile([30, 30, 30, 30]), 50);
  assert.ok(r.ratio! > 1.5);
  assert.match(r.status, /large workload spike/i);
  assert.match(r.status, /not an injury prediction/i);
});

test("computeACWR marks low chronic base as provisional/unreliable", () => {
  // chronic = 5mi/wk < 8 reliability floor
  const r = computeACWR(profile([4, 5, 6, 5]), 8);
  assert.equal(r.reliable, false);
  assert.match(r.status, /provisional/i);
});

// ─── Trailing-layoff guard (audit fix, Jul 2026) ──────────────────────────────
// A layoff after the last recorded week produces NO week rows (fillMissingWeeks
// only fills gaps BETWEEN active weeks), so the chronic window used to be built
// from pre-layoff mileage — green-lighting a comeback spike, the exact situation
// ACWR exists to catch. computeACWR now appends the missing zero weeks up to the
// current week when currentWeekKey is provided.

function weekAt(weekStarting: string, runMiles: number): HistoricalWeek {
  return { ...week(runMiles), weekStarting };
}

test("computeACWR sees a 2-week trailing layoff in the chronic window", () => {
  const p = profile([20, 20, 20, 20]);
  p.weeks = [
    weekAt("May 4, 2026", 20),
    weekAt("May 11, 2026", 20),
    weekAt("May 18, 2026", 20),
    weekAt("May 25, 2026", 20),
  ];
  // Two fully-off weeks (Jun 1, Jun 8), then a 22mi comeback in the week of Jun 15.
  // Chronic must be avg(20,20,0,0)=10 → ratio 2.2 large spike, not 22/20=1.1 steady.
  const r = computeACWR(p, 22, "Jun 15, 2026");
  assert.equal(r.chronic, 10);
  assert.ok(r.ratio! > 1.5);
  assert.match(r.status, /large workload spike/i);
});

test("computeACWR after a 4+ week full layoff degrades to insufficient, never steady", () => {
  const p = profile([20, 20, 20, 20]);
  p.weeks = [
    weekAt("Apr 6, 2026", 20),
    weekAt("Apr 13, 2026", 20),
    weekAt("Apr 20, 2026", 20),
    weekAt("Apr 27, 2026", 20),
  ];
  const r = computeACWR(p, 22, "Jun 15, 2026");
  assert.equal(r.chronic, 0);
  assert.equal(r.ratio, null);
  assert.doesNotMatch(r.status, /steady relative load/i);
});

test("computeACWR without currentWeekKey keeps legacy behavior (no synthetic weeks)", () => {
  const r = computeACWR(profile([30, 30, 30, 30]), 33);
  assert.equal(r.chronic, 30);
});

test("readiness never green-lights a ≥10mi comeback with no chronic base", () => {
  const p = profile([20, 20, 20, 20]);
  p.weeks = [
    weekAt("Apr 6, 2026", 20),
    weekAt("Apr 13, 2026", 20),
    weekAt("Apr 20, 2026", 20),
    weekAt("Apr 27, 2026", 20),
  ];
  const current: ActivitySummary = {
    type: "Run", name: "Run", dayOfWeek: "Friday", date: "Jul 10",
    distanceMiles: 22, durationFormatted: "3h", paceFormatted: "8:11/mi", elevationFt: 0,
  };
  const report = buildCoachingUserMessage(
    [current], null, null, new Date("2026-07-10T12:00:00-07:00"), p,
    new Date("2026-07-10T12:00:00-07:00")
  );
  assert.match(report, /Suggested tier: YELLOW/i);
  assert.match(report, /without an established chronic base/i);
});
