// Table test for FIT sport/subSport → our activity vocabulary. Both string names
// (SDK-decoded enums) and raw numeric codes must map identically.
import test from "node:test";
import assert from "node:assert/strict";
import { mapSport } from "../lib/fit/sport-map";

const cases: Array<[string | number | undefined, string | number | undefined, string, boolean]> = [
  ["running", undefined, "Run", false],
  ["running", "treadmill", "Run", true],
  ["running", "indoorRunning", "Run", true],      // what HealthFit actually emits (verified Jul 2026)
  [1, 45, "Run", true],
  [1, 1, "Run", true],                            // numeric fallbacks
  ["running", "trail", "TrailRun", false],
  ["training", "strengthTraining", "WeightTraining", false],
  [10, 20, "WeightTraining", false],
  ["basketball", undefined, "Basketball", false],
  [6, undefined, "Basketball", false],
  ["cycling", undefined, "Ride", false],
  ["walking", undefined, "Walk", false],
  ["hiking", undefined, "Hike", false],
  ["golf", undefined, "Golf", false],
  ["swimming", undefined, "Swim", false],
  ["fitnessEquipment", "elliptical", "Elliptical", true],
  ["rockClimbing", undefined, "Workout", false],  // unmapped → catch-all
  [undefined, undefined, "Workout", false],
];

for (const [sport, sub, type, trainer] of cases) {
  test(`${String(sport)}/${String(sub)} → ${type}${trainer ? " (trainer)" : ""}`, () => {
    assert.deepEqual(mapSport(sport, sub), { type, trainer });
  });
}
