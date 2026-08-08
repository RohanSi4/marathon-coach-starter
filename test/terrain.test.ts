import { test } from "node:test";
import assert from "node:assert/strict";
import { terrainRuns, weeklyTerrain, formatTerrainBlock, HILLY_FT_PER_MI } from "../lib/terrain";
import type { StoredActivity } from "../lib/types";

// total_elevation_gain is stored in METERS; the block reports feet per mile.
const run = (over: Partial<StoredActivity>): StoredActivity =>
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
    distance: 16093, // 10mi
    moving_time: 5400,
    elapsed_time: 5400,
    average_speed: 3.0,
    total_elevation_gain: 0,
    ...over,
  }) as StoredActivity;

test("terrainRuns converts meters of gain to feet per mile", () => {
  // 152.4m = 500ft over 10mi = 50 ft/mi.
  const [r] = terrainRuns([run({ total_elevation_gain: 152.4 })]);
  assert.equal(r.climbFt, 500);
  assert.equal(r.ftPerMile, 50);
});

// ft/mi is the unit precisely because total gain rewards length over steepness.
test("a short steep run out-rates a long flat one despite less total climb", () => {
  const [steep, flat] = terrainRuns([
    run({ distance: 4828, total_elevation_gain: 91.44 }), // 3mi, 300ft
    run({ distance: 22530, total_elevation_gain: 121.92 }), // 14mi, 400ft
  ]);
  assert.ok(steep.climbFt < flat.climbFt, "the long run climbed more in total");
  assert.ok(steep.ftPerMile > flat.ftPerMile, "but the short run is the hillier terrain");
});

test("a treadmill run contributes a structural zero", () => {
  const [r] = terrainRuns([run({ trainer: true, total_elevation_gain: 0 })]);
  assert.equal(r.ftPerMile, 0);
  assert.equal(r.treadmill, true);
});

test("weeklyTerrain aggregates climb across a week and flags hilly long runs", () => {
  const [w] = weeklyTerrain([
    run({ start_date: "2026-07-01T12:00:00.000Z", total_elevation_gain: 152.4 }), // 10mi @ 50ft/mi
    run({ start_date: "2026-07-02T12:00:00.000Z", distance: 8046, total_elevation_gain: 0 }), // 5mi flat
  ]);
  assert.equal(w.miles, 15);
  assert.equal(w.climbFt, 500);
  assert.equal(w.hillyLongRuns, 1);
  assert.ok(w.ftPerMile > 33 && w.ftPerMile < 34);
});

test("a hilly SHORT run does not satisfy the long-run course requirement", () => {
  const [w] = weeklyTerrain([
    run({ distance: 4828, total_elevation_gain: 91.44 }), // 3mi at 100 ft/mi
  ]);
  assert.ok(w.ftPerMile >= HILLY_FT_PER_MI, "the terrain is hilly");
  assert.equal(w.hillyLongRuns, 0, "but 3mi is not a long run");
});

// The bug this block exists to catch: the count can be satisfied entirely by runs
// from months ago while the athlete has been on flat ground the whole build.
test("a met requirement still reports STALE when the last hilly long run is old", () => {
  const out = formatTerrainBlock(
    [
      run({ start_date: "2026-06-09T12:00:00.000Z", total_elevation_gain: 152.4 }),
      run({ start_date: "2026-06-10T12:00:00.000Z", total_elevation_gain: 152.4 }),
      run({ start_date: "2026-07-25T12:00:00.000Z", distance: 23000, total_elevation_gain: 30 }),
    ],
    8,
    new Date("2026-07-31T12:00:00.000Z"),
  );
  assert.match(out, /count met/);
  assert.match(out, /STALE/);
});

test("a recent hilly long run is not flagged stale", () => {
  const out = formatTerrainBlock(
    [
      run({ start_date: "2026-07-20T12:00:00.000Z", total_elevation_gain: 152.4 }),
      run({ start_date: "2026-07-25T12:00:00.000Z", total_elevation_gain: 152.4 }),
    ],
    8,
    new Date("2026-07-31T12:00:00.000Z"),
  );
  assert.match(out, /count met/);
  assert.doesNotMatch(out, /STALE/);
});

test("the requirement reports NOT MET when there are no hilly long runs", () => {
  const out = formatTerrainBlock([run({ total_elevation_gain: 10 })], 8, new Date("2026-07-31T12:00:00.000Z"));
  assert.match(out, /NOT MET/);
});

// ─── Treadmill incline is not hill exposure ───────────────────────────────────
// The real 2026-07-02 session: 4.82mi indoors on an inclined belt, which the watch
// recorded as 128m (420ft) of ascent. Counting that as climb told the coach he had
// run a hilly route indoors, which is the precise claim this block exists to catch.
// Belt incline is real calf work but it carries no descent, no eccentric loading
// and no camber — it is not course specificity.
test("an inclined treadmill run contributes no climb, but its miles still count", () => {
  const weeks = weeklyTerrain([
    run({ start_date: "2026-07-02T23:44:50.000Z", distance: 4.82 * 1609.344, total_elevation_gain: 128, trainer: true }),
    run({ start_date: "2026-07-03T15:00:00.000Z", distance: 5 * 1609.344, total_elevation_gain: 61, start_latlng: [37.3, -121.9] }),
  ]);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].climbFt, Math.round(61 * 3.28084), "only the outdoor run's climb");
  assert.equal(weeks[0].miles, 9.8, "the indoor miles still dilute ft/mi");
});

// The course requirement is ≥2 LONG runs on hilly ground. A steep belt must never
// be able to tick that box.
test("a long inclined treadmill run cannot count as a hilly long run", () => {
  const weeks = weeklyTerrain([
    run({ start_date: "2026-07-02T23:44:50.000Z", distance: 10 * 1609.344, total_elevation_gain: 250, trainer: true }),
  ]);
  assert.equal(weeks[0].hillyLongRuns, 0);
  assert.equal(weeks[0].climbFt, 0);
});

test("an outdoor hilly long run still counts", () => {
  const weeks = weeklyTerrain([
    run({ start_date: "2026-06-09T15:00:00.000Z", distance: 9.3 * 1609.344, total_elevation_gain: 141, start_latlng: [37.3, -121.9] }),
  ]);
  assert.equal(weeks[0].hillyLongRuns, 1);
});
