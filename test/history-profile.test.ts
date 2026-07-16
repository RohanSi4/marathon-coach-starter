import test from "node:test";
import assert from "node:assert/strict";
import { computeACWR } from "../lib/coach-prompt";
import {
  buildCompletedAthleteProfile,
  completedActivities,
  completedWeeks,
} from "../lib/history-profile";
import type { AthleteProfile, HistoricalWeek, StoredActivity } from "../lib/types";

// These tests exercise the legacy-baseline splice, so they pin an explicit splice
// date (the default config splice is in the distant past = all-FIT history).
const SPLICE = new Date("2026-06-29T00:00:00-04:00");

function week(weekStarting: string, runMiles: number): HistoricalWeek {
  return {
    weekStarting,
    runMiles,
    runDays: runMiles > 0 ? 1 : 0,
    longRunMiles: runMiles,
    liftDays: 0,
    crossTrainingDays: 0,
    sufferTotal: 0,
    qualityRuns: 0,
    keyRuns: [],
    injuryNotes: [],
  };
}

function baseline(): AthleteProfile {
  return {
    generatedAt: "2026-06-29T12:00:00.000Z",
    sinceDate: "2026-01-01T05:00:00.000Z",
    totalActivities: 100,
    weeks: [
      week("Jun 1, 2026", 20),
      week("Jun 8, 2026", 20),
      week("Jun 15, 2026", 20),
      week("Jun 22, 2026", 20),
    ],
    peakWeekMiles: 20,
    peakWeekOf: "Jun 1, 2026",
    longestRun: 20,
    longestRunDate: "Jun 1, 2026",
    injuryLog: [],
  };
}

function run(start: string, miles: number, suffix: string): StoredActivity {
  const distance = miles * 1609.344;
  return {
    schemaVersion: 1,
    source: "fit",
    key: `${start}_Run_${suffix}`,
    id: Math.floor(Date.parse(start) / 1000),
    name: "Run",
    type: "Run",
    sport_type: "Run",
    start_date: start,
    distance,
    moving_time: Math.round(miles * 600),
    elapsed_time: Math.round(miles * 600),
    average_speed: distance / Math.round(miles * 600),
    max_speed: 3,
    total_elevation_gain: 0,
  };
}

test("in-memory refresh includes late imports from the most recently completed week", () => {
  const now = new Date("2026-07-10T12:00:00-07:00");
  const activities = [
    run("2026-06-30T15:00:00.000Z", 12.8, "early"),
    run("2026-07-05T15:00:00.000Z", 8.3, "late"),
    run("2026-07-08T15:00:00.000Z", 9, "current"),
  ];

  // This mirrors the stale-profile failure: a mid-week persisted row had 12.8mi,
  // but a later import brought the completed Jun 29 week to 21.1mi.
  const stale = baseline();
  stale.weeks.push(week("Jun 29, 2026", 12.8));
  const fresh = buildCompletedAthleteProfile(baseline(), activities, now, SPLICE).profile;

  assert.equal(fresh.weeks.at(-1)?.weekStarting, "Jun 29, 2026");
  assert.equal(fresh.weeks.at(-1)?.runMiles, 21.1);
  assert.notEqual(
    computeACWR(fresh, 9, "Jul 6, 2026").chronic,
    computeACWR(stale, 9, "Jul 6, 2026").chronic
  );
  assert.equal(computeACWR(fresh, 9, "Jul 6, 2026").chronic, 20.3);
});

test("completed history and race windows exclude the current partial week", () => {
  const now = new Date("2026-07-10T12:00:00-07:00");
  const activities = [
    run("2026-07-05T15:00:00.000Z", 8, "completed"),
    run("2026-07-08T15:00:00.000Z", 30, "partial"),
  ];
  const built = buildCompletedAthleteProfile(baseline(), activities, now, SPLICE).profile;

  assert.deepEqual(
    completedActivities(activities, now).map((activity) => activity.key),
    [activities[0].key]
  );
  assert.equal(built.weeks.at(-1)?.weekStarting, "Jun 29, 2026");
  assert.equal(built.weeks.at(-1)?.runMiles, 8);

  const withPartial = {
    ...built,
    weeks: [...built.weeks, week("Jul 6, 2026", 30)],
  };
  assert.deepEqual(
    completedWeeks(withPartial, now).slice(-2).map((entry) => entry.runMiles),
    [20, 8]
  );
});
