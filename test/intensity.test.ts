import { test } from "node:test";
import assert from "node:assert/strict";
import { weeklyIntensity, specificityWeeks, paceSeconds, MGP_BAND_SEC } from "../lib/intensity";
import { GOAL_PACE } from "../lib/config";
import type { StoredActivity, HRZoneSplit, MileSplit } from "../lib/types";

const act = (over: Partial<StoredActivity>): StoredActivity =>
  ({
    schemaVersion: 1,
    source: "fit",
    sourceFile: "x.fit",
    key: "k",
    id: "t",
    name: "Run",
    type: "Run",
    sport_type: "Run",
    start_date: "2026-07-01T12:00:00.000Z",
    distance: 9656,
    moving_time: 3300,
    elapsed_time: 3300,
    average_speed: 2.9,
    ...over,
  }) as StoredActivity;

const zones = (z1: number, z2: number, z3: number, z4: number, z5 = 0): HRZoneSplit[] =>
  [z1, z2, z3, z4, z5].map((seconds, i) => ({ zone: i + 1, minBpm: 0, maxBpm: 0, seconds }));

test("weeklyIntensity buckets Z1-2 easy, Z3 threshold, Z4-5 hard", () => {
  const [w] = weeklyIntensity([act({ hrZones: zones(600, 2400, 600, 300, 100) })]);
  assert.equal(w.easyMin, 50);
  assert.equal(w.thresholdMin, 10);
  assert.equal(w.hardMin, Math.round(400 / 60));
  assert.equal(w.easyPct, 75);
});

test("weeklyIntensity sums multiple runs into one week and splits across weeks", () => {
  const weeks = weeklyIntensity([
    act({ start_date: "2026-07-01T12:00:00.000Z", hrZones: zones(0, 3600, 0, 0) }),
    act({ start_date: "2026-07-02T12:00:00.000Z", hrZones: zones(0, 1800, 0, 0) }),
    act({ start_date: "2026-07-09T12:00:00.000Z", hrZones: zones(0, 600, 0, 0) }),
  ]);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].easyMin, 90);
  assert.equal(weeks[1].easyMin, 10);
});

// The 80/20 policy is a RUNNING-load policy. Folding a basketball game's Z4 minutes
// into it would make a hoops week look like a threshold week and mask the real ratio.
test("weeklyIntensity ignores non-run activities", () => {
  const weeks = weeklyIntensity([
    act({ hrZones: zones(0, 3600, 0, 0) }),
    act({ type: "Basketball", hrZones: zones(0, 0, 0, 3600) }),
    act({ type: "WeightTraining", hrZones: zones(0, 0, 1800, 0) }),
  ]);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].hardPct, 0, "basketball Z4 must not enter the running ratio");
  assert.equal(weeks[0].easyPct, 100);
});

test("weeklyIntensity skips runs with no stored zones rather than counting them as zero", () => {
  assert.equal(weeklyIntensity([act({})]).length, 0);
});

const split = (mile: number, pace: string): MileSplit => ({ mile, pace, avgHR: 150 });

// Fixtures derive from GOAL_PACE rather than hardcoding one athlete's numbers:
// this is a template, and GOAL_PACE is an onboarding EDIT-ME value, so a test that
// assumed a specific goal pace would fail for every athlete but its author.
const mmss = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}/mi`;
const GOAL = paceSeconds(GOAL_PACE)!;

test("specificityWeeks counts only splits inside the goal band", () => {
  const [w] = specificityWeeks([
    act({
      splits: [
        split(1, mmss(GOAL)),                  // dead on
        split(2, mmss(GOAL - MGP_BAND_SEC)),   // band edge, fast side
        split(3, mmss(GOAL + MGP_BAND_SEC)),   // band edge, slow side
        split(4, mmss(GOAL - MGP_BAND_SEC - 1)), // just faster than the band
        split(5, mmss(GOAL + 55)),             // easy
      ],
    }),
  ]);
  assert.equal(w.mgpMiles, 3);
  assert.equal(w.fasterMiles, 1);
  assert.equal(w.totalMiles, 5);
});

// The unit has to be splits, not sessions: a long run with 2 MGP miles is 2 miles of
// specificity, and counting it as "1 MGP workout" overstates the exposure ~5x.
test("specificityWeeks counts MILES, not sessions", () => {
  const [w] = specificityWeeks([
    act({ splits: [split(1, mmss(GOAL + 55)), split(2, mmss(GOAL + 55)), split(3, mmss(GOAL)), split(4, mmss(GOAL))] }),
  ]);
  assert.equal(w.mgpMiles, 2);
  assert.equal(w.totalMiles, 4);
});

test("paceSeconds parses mm:ss and rejects junk", () => {
  assert.equal(paceSeconds("8:35/mi"), 515);
  assert.equal(paceSeconds("10:07/mi"), 607);
  assert.equal(paceSeconds("N/A"), null);
});

test("the goal band is symmetric", () => {
  const goal = paceSeconds("8:35/mi")!;
  assert.equal(goal - MGP_BAND_SEC, 500); // 8:20
  assert.equal(goal + MGP_BAND_SEC, 530); // 8:50
});
