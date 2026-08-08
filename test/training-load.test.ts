// The weekly suffer-score fitness/fatigue lens (coach-prompt) vs the daily Banister
// PMC (lib/load.ts). Both print "CTL/ATL/TSB" on different scales, and the weekly
// one carried a structural mid-week bias: CTL is a whole-week AVERAGE while ATL was
// the CURRENT week's PARTIAL running total, so early in any week TSB was always
// hugely positive and the status line read "FRESH (consider adding volume/intensity)"
// regardless of real form.
import test from "node:test";
import assert from "node:assert/strict";
import { computeTrainingLoad } from "../lib/coach-prompt";
import type { AthleteProfile, HistoricalWeek } from "../lib/types";

function week(weekStarting: string, sufferTotal: number): HistoricalWeek {
  return {
    weekStarting, runMiles: 30, runDays: 5, longRunMiles: 10, liftDays: 3,
    crossTrainingDays: 0, sufferTotal, qualityRuns: 1, keyRuns: [], injuryNotes: [],
  };
}

function profile(weeks: HistoricalWeek[]): AthleteProfile {
  return {
    generatedAt: "2026-08-06T00:00:00Z", sinceDate: "2026-01-01T00:00:00Z",
    totalActivities: 0, weeks, peakWeekMiles: 40, peakWeekOf: "Jul 6, 2026",
    longestRun: 12, longestRunDate: "Jul 25, 2026", injuryLog: [],
  };
}

// Four completed weeks averaging 500 TRIMP, then a current week only part-run.
const history = profile([
  week("Jul 6, 2026", 480),
  week("Jul 13, 2026", 500),
  week("Jul 20, 2026", 520),
  week("Jul 27, 2026", 500),
  week("Aug 3, 2026", 277), // current, partial — excluded from the chronic window
]);

test("a partly-run week is not reported as freshness", () => {
  // 277 TRIMP partway into a ~500 TRIMP week is a week ON PACE, not a rest week.
  const midWeek = computeTrainingLoad(history, 277, "Aug 3, 2026");
  assert.equal(midWeek.ctl, 500);
  assert.equal(midWeek.atl, 277);
  assert.ok(
    !/FRESH/.test(midWeek.status),
    `a partial week must not read as FRESH, got: ${midWeek.status}`,
  );
});

test("a genuinely light completed week still reads as fresh", () => {
  // Same 277, but the week is DONE — that is a real step-back and should show.
  const full = computeTrainingLoad(history, 277, undefined);
  assert.ok(/FRESH/.test(full.status), `got: ${full.status}`);
});

test("a completed week at chronic load reads neutral, not fresh", () => {
  const steady = computeTrainingLoad(history, 500, undefined);
  assert.ok(!/FRESH/.test(steady.status), `got: ${steady.status}`);
});

test("no TRIMP baseline is still reported as meaningless rather than fresh", () => {
  const bare = computeTrainingLoad(profile([week("Jul 27, 2026", 0)]), 0, undefined);
  assert.equal(bare.ctl, 0);
  assert.match(bare.status, /NO TRIMP BASELINE/);
});
