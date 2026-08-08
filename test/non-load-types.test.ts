import { test } from "node:test";
import assert from "node:assert/strict";
import { countsAsLoad, dailyLoadSeries, NON_LOAD_TYPES } from "../lib/load";
import { aggregateWeeks } from "../lib/aggregate";
import { buildCoachingUserMessage } from "../lib/coach-prompt";
import type { ActivitySummary, AthleteProfile, StoredActivity } from "../lib/types";

const act = (over: Partial<StoredActivity>): StoredActivity =>
  ({
    schemaVersion: 1,
    source: "fit",
    sourceFile: "x.fit",
    key: "k",
    id: "t",
    name: "x",
    type: "Run",
    sport_type: "Run",
    start_date: "2026-07-31T18:00:00.000Z",
    distance: 8046,
    moving_time: 2700,
    elapsed_time: 2700,
    average_speed: 3.0,
    ...over,
  }) as StoredActivity;

test("runs, lifts and cutting sports all count as training load", () => {
  for (const type of ["Run", "TrailRun", "WeightTraining", "Basketball", "Soccer", "Ride", "Swim"]) {
    assert.equal(countsAsLoad({ type }), true, `${type} should count`);
  }
});

test("golf, walks and hikes do not count as training load", () => {
  for (const type of NON_LOAD_TYPES) {
    assert.equal(countsAsLoad({ type }), false, `${type} should not count`);
  }
});

// The real 2026-07-31 round: 4.5 hours at avg HR 112 scored TRIMP 144 — fourth
// highest of the preceding two months, above a 10.7mi long run at 132 — on a day
// he rode a cart. TRIMP multiplies duration by intensity, so all-day low-intensity
// activity accumulates a training-stress number it never earned.
test("a 4.5-hour cart golf round contributes ZERO daily load", () => {
  const series = dailyLoadSeries([
    act({ type: "Run", start_date: "2026-07-31T01:43:00.000Z", trimp: 35 }),
    act({ type: "Golf", start_date: "2026-07-31T15:42:00.000Z", moving_time: 16200, trimp: 144 }),
  ]);
  const day = series.find((d) => d.date === "2026-07-30" || d.date === "2026-07-31");
  assert.ok(day);
  const total = series.reduce((s, d) => s + d.trimp, 0);
  assert.equal(total, 35, "only the treadmill run should register");
});

test("excluding golf does not blank the series when it is the only activity", () => {
  assert.deepEqual(dailyLoadSeries([act({ type: "Golf", trimp: 144 })]), []);
});

test("weekly sufferTotal excludes non-load activities too", () => {
  const { weeks } = aggregateWeeks([
    act({ type: "Run", trimp: 50 }),
    act({ type: "Golf", trimp: 144 }),
    act({ type: "Walk", trimp: 12 }),
  ]);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].sufferTotal, 50);
});

// Excluded from STRESS is not excluded from existence: golf is still time-on-feet
// context and still shows up as a cross-training day in the week.
test("a golf day is still counted as a cross-training day", () => {
  const { weeks } = aggregateWeeks([act({ type: "Golf", trimp: 144 })]);
  assert.equal(weeks[0].crossTrainingDays, 1);
  assert.equal(weeks[0].sufferTotal, 0);
});

// THE THIRD PATH. Three separate places sum TRIMP: dailyLoadSeries (PMC),
// aggregateWeeks (weekly history), and buildCoachingUserMessage's ATL. The first
// two were filtered on 2026-07-31 and this one was missed, so the Jul 27 week
// reported ATL 469 (golf 144 + walks 12 included) against a CTL built from the
// already-clean weekly sufferTotal — a dirty acute over a clean chronic, which
// understates TSB by the full contaminated amount and can fake a fatigued athlete.
test("the ATL in the coaching report excludes golf and walks", () => {
  const day = (type: string, trimp: number, distanceMiles = 0): ActivitySummary => ({
    type, name: type, dayOfWeek: "Friday", date: "Jul 31",
    distanceMiles, durationFormatted: "1h", paceFormatted: "10:00/mi", elevationFt: 0,
    sufferScore: trimp,
  });
  const p: AthleteProfile = {
    generatedAt: "2026-07-01T00:00:00Z",
    sinceDate: "2026-01-01T00:00:00Z",
    totalActivities: 0,
    weeks: [{
      weekStarting: "Jul 20, 2026", runMiles: 30, runDays: 5, longRunMiles: 10,
      liftDays: 3, crossTrainingDays: 0, sufferTotal: 400, qualityRuns: 1,
      keyRuns: [], injuryNotes: [],
    }],
    peakWeekMiles: 30, peakWeekOf: "Jul 20, 2026", longestRun: 10,
    longestRunDate: "Jul 20, 2026", injuryLog: [],
  };
  const at = new Date("2026-07-31T12:00:00-07:00");
  const report = buildCoachingUserMessage(
    [day("Run", 200, 20), day("Golf", 144), day("Walk", 12)], null, null, at, p, at,
  );
  assert.match(report, /ATL \(this week so far\): 200\b/, "only the run's 200 TRIMP is acute load");
  assert.doesNotMatch(report, /ATL \(this week so far\): 356\b/);
});
