// fillMissingWeeks guards the ACWR chronic window: a calendar week with zero
// Strava activities produces no week key when grouping, so without zero-fill the
// trailing-4-week average silently spans extra weeks and understates injury risk
// right after a layoff — the riskiest moment to understate it.
import test from "node:test";
import assert from "node:assert/strict";
import { fillMissingWeeks, nextWeekKey } from "../lib/strava";
import type { HistoricalWeek } from "../lib/types";

function wk(weekStarting: string, runMiles: number): HistoricalWeek {
  return {
    weekStarting, runMiles, runDays: 1, longRunMiles: runMiles, liftDays: 0,
    crossTrainingDays: 0, sufferTotal: 0, qualityRuns: 0, keyRuns: [], injuryNotes: [],
  };
}

test("nextWeekKey crosses a month boundary", () => {
  assert.equal(nextWeekKey("Jun 29, 2026"), "Jul 6, 2026");
});

test("nextWeekKey crosses a year boundary", () => {
  assert.equal(nextWeekKey("Dec 28, 2026"), "Jan 4, 2027");
});

test("consecutive weeks pass through unchanged", () => {
  const input = [wk("Jun 22, 2026", 27), wk("Jun 29, 2026", 4)];
  assert.deepEqual(fillMissingWeeks(input), input);
});

test("a fully-empty calendar week is filled with a zero row", () => {
  const filled = fillMissingWeeks([wk("Jun 8, 2026", 14), wk("Jun 22, 2026", 27)]);
  assert.equal(filled.length, 3);
  assert.equal(filled[1].weekStarting, "Jun 15, 2026");
  assert.equal(filled[1].runMiles, 0);
  assert.equal(filled[1].runDays, 0);
  assert.deepEqual(filled[1].keyRuns, []);
});

test("a multi-week gap fills every missing Monday", () => {
  const filled = fillMissingWeeks([wk("May 4, 2026", 10), wk("Jun 1, 2026", 12)]);
  assert.deepEqual(
    filled.map(w => w.weekStarting),
    ["May 4, 2026", "May 11, 2026", "May 18, 2026", "May 25, 2026", "Jun 1, 2026"]
  );
  assert.deepEqual(filled.slice(1, 4).map(w => w.runMiles), [0, 0, 0]);
});

test("a gap spanning the November DST fall-back fills exactly the missing weeks", () => {
  // Nov 1, 2026 is the US DST fall-back date; UTC-normalized week math must not
  // double-fill or skip around it.
  const filled = fillMissingWeeks([wk("Oct 26, 2026", 28), wk("Nov 16, 2026", 12)]);
  assert.deepEqual(
    filled.map(w => w.weekStarting),
    ["Oct 26, 2026", "Nov 2, 2026", "Nov 9, 2026", "Nov 16, 2026"]
  );
});
