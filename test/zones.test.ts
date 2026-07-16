import { test } from "node:test";
import assert from "node:assert";
import {
  decouplingObservations,
  estimateLt1,
  bestSustained,
  maxHrObservations,
  STEADY_MAX_OVER_AVG,
} from "../lib/zones";
import type { StoredActivity } from "../lib/types";

const run = (over: Partial<StoredActivity>): StoredActivity =>
  ({
    schemaVersion: 1,
    source: "fit",
    sourceFile: "x.fit",
    key: over.start_date + "_Run",
    id: "t",
    name: "Run",
    type: "Run",
    sport_type: "Run",
    start_date: "2026-07-01T12:00:00.000Z",
    distance: 9656, // 6mi
    moving_time: 3300,
    elapsed_time: 3300,
    average_speed: 2.9,
    ...over,
  }) as StoredActivity;

test("decouplingObservations: excludes short runs, flags surge runs as not steady", () => {
  const acts = [
    run({ start_date: "2026-07-01T12:00:00.000Z", average_heartrate: 140, max_heartrate: 148, decouplingPct: 3.5 }),
    // interval run: max towers over avg by more than STEADY_MAX_OVER_AVG
    run({ start_date: "2026-07-02T12:00:00.000Z", average_heartrate: 142, max_heartrate: 142 + STEADY_MAX_OVER_AVG + 5, decouplingPct: 8.9 }),
    // too short (<40min)
    run({ start_date: "2026-07-03T12:00:00.000Z", average_heartrate: 150, max_heartrate: 155, decouplingPct: 2.0, moving_time: 1200 }),
  ];
  const obs = decouplingObservations(acts);
  assert.strictEqual(obs.length, 2);
  assert.strictEqual(obs.find((o) => o.avgHR === 140)!.steady, true);
  assert.strictEqual(obs.find((o) => o.avgHR === 142)!.steady, false);
});

test("estimateLt1: brackets LT1 between highest coupled and lowest decoupled steady run", () => {
  const acts = [
    run({ start_date: "2026-06-20T12:00:00.000Z", average_heartrate: 140, max_heartrate: 150, decouplingPct: 4.0 }),
    run({ start_date: "2026-06-22T12:00:00.000Z", average_heartrate: 148, max_heartrate: 158, decouplingPct: 4.8 }),
    run({ start_date: "2026-06-25T12:00:00.000Z", average_heartrate: 156, max_heartrate: 166, decouplingPct: 10.5 }),
  ];
  const est = estimateLt1(decouplingObservations(acts));
  assert.strictEqual(est.highestCoupled!.avgHR, 148);
  assert.strictEqual(est.lowestDecoupled!.avgHR, 156);
  assert.strictEqual(est.lt1, 152);
});

test("estimateLt1: surge-poisoned decoupled run does NOT set the upper bracket", () => {
  const acts = [
    run({ start_date: "2026-06-20T12:00:00.000Z", average_heartrate: 140, max_heartrate: 148, decouplingPct: 4.0 }),
    // decoupled but NOT steady (strides artifact) — must be ignored
    run({ start_date: "2026-06-25T12:00:00.000Z", average_heartrate: 152, max_heartrate: 189, decouplingPct: 10.6 }),
  ];
  const est = estimateLt1(decouplingObservations(acts));
  assert.strictEqual(est.lt1, null);
  assert.strictEqual(est.highestCoupled!.avgHR, 140);
  assert.strictEqual(est.lowestDecoupled, undefined);
});

test("bestSustained: time-weights consecutive splits and picks the hottest window", () => {
  const acts = [
    run({
      start_date: "2026-04-26T12:00:00.000Z",
      splits: [
        { mile: 1, pace: "9:00/mi", avgHR: 150 },
        { mile: 2, pace: "9:00/mi", avgHR: 170 },
        { mile: 3, pace: "9:00/mi", avgHR: 174 },
        { mile: 4, pace: "9:00/mi", avgHR: 176 },
      ],
    }),
  ];
  const b = bestSustained(acts, 2)!;
  assert.strictEqual(b.avgHR, 175); // miles 3-4, not 1-2
  assert.strictEqual(b.fromMile, 3);
  assert.strictEqual(b.minutes, 18);
});

test("bestSustained: returns null when no run is long enough", () => {
  const acts = [run({ splits: [{ mile: 1, pace: "9:00/mi", avgHR: 150 }] })];
  assert.strictEqual(bestSustained(acts, 2), null);
});

test("maxHrObservations: sorts descending and flags H10 era", () => {
  const acts = [
    run({ start_date: "2023-09-01T12:00:00.000Z", max_heartrate: 199 }),
    run({ start_date: "2026-06-25T12:00:00.000Z", max_heartrate: 189 }),
  ];
  const obs = maxHrObservations(acts);
  assert.strictEqual(obs[0].maxHR, 199);
  assert.strictEqual(obs[0].h10Era, false);
  assert.strictEqual(obs[1].maxHR, 189);
  assert.strictEqual(obs[1].h10Era, true);
});
