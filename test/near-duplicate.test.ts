// Near-duplicate guard: the same physical workout arriving twice (watch recording
// + a Strava echo written back into Apple Health) with start times seconds apart.
// Found live 2026-07-03: Apr 26 half double-counted as 26.3mi. Never again.
import test from "node:test";
import assert from "node:assert/strict";
import { findNearDuplicate } from "../lib/store";
import type { StoredActivity } from "../lib/types";

function act(over: Partial<StoredActivity>): StoredActivity {
  return {
    key: `${over.start_date}_${over.type ?? "Run"}`,
    start_date: "2026-04-27T01:32:41.000Z",
    type: "Run",
    distance: 21151,
    moving_time: 7204,
    elapsed_time: 7300,
    average_speed: 2.94,
    ...over,
  } as StoredActivity;
}

test("catches the real Apr 26 case: 4s apart, ~same duration, same type", () => {
  const watch = act({ start_date: "2026-04-27T01:32:41.000Z", moving_time: 7204 });
  const strava = act({ start_date: "2026-04-27T01:32:37.000Z", moving_time: 7205, distance: 20966 });
  assert.equal(findNearDuplicate(strava, [watch]), watch);
});

test("different type or far-apart starts are NOT duplicates", () => {
  const run = act({});
  const lift = act({ type: "WeightTraining", start_date: "2026-04-27T01:33:00.000Z" });
  assert.equal(findNearDuplicate(lift, [run]), null);
  const laterRun = act({ start_date: "2026-04-27T01:40:00.000Z" });
  assert.equal(findNearDuplicate(laterRun, [run]), null); // 7+ min apart
});

test("same start but very different duration (restarted watch) is NOT a duplicate", () => {
  const full = act({ moving_time: 7204 });
  const stub = act({ start_date: "2026-04-27T01:32:50.000Z", moving_time: 600, distance: 1600 });
  assert.equal(findNearDuplicate(stub, [full]), null);
});

test("identical key is skipped (that's overwrite territory, not near-dupe)", () => {
  const a = act({});
  assert.equal(findNearDuplicate(a, [a]), null);
});
