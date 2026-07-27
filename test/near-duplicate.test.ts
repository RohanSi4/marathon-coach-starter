// Near-duplicate guard: the same physical workout arriving twice (watch recording
// + a Strava echo written back into Apple Health) with start times seconds apart.
// Left unguarded this silently double-counts a long run, which inflates weekly
// mileage and every load metric derived from it.
import test from "node:test";
import assert from "node:assert/strict";
import { findNearDuplicate } from "../lib/store";
import type { StoredActivity } from "../lib/types";

function act(over: Partial<StoredActivity>): StoredActivity {
  return {
    key: `${over.start_date}_${over.type ?? "Run"}`,
    start_date: "2027-03-14T15:10:41.000Z",
    type: "Run",
    distance: 16093,
    moving_time: 5400,
    elapsed_time: 5460,
    average_speed: 2.94,
    ...over,
  } as StoredActivity;
}

test("catches the classic echo: 4s apart, ~same duration, same type", () => {
  const watch = act({ start_date: "2027-03-14T15:10:41.000Z", moving_time: 5400 });
  const strava = act({ start_date: "2027-03-14T15:10:37.000Z", moving_time: 5401, distance: 16050 });
  assert.equal(findNearDuplicate(strava, [watch]), watch);
});

test("different type or far-apart starts are NOT duplicates", () => {
  const run = act({});
  const lift = act({ type: "WeightTraining", start_date: "2027-03-14T15:11:00.000Z" });
  assert.equal(findNearDuplicate(lift, [run]), null);
  const laterRun = act({ start_date: "2027-03-14T15:18:00.000Z" });
  assert.equal(findNearDuplicate(laterRun, [run]), null); // 7+ min apart
});

test("same start but very different duration (restarted watch) is NOT a duplicate", () => {
  const full = act({ moving_time: 5400 });
  const stub = act({ start_date: "2027-03-14T15:10:50.000Z", moving_time: 600, distance: 1600 });
  assert.equal(findNearDuplicate(stub, [full]), null);
});

test("identical key is skipped (that's overwrite territory, not near-dupe)", () => {
  const a = act({});
  assert.equal(findNearDuplicate(a, [a]), null);
});
