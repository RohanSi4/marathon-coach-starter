import { test } from "node:test";
import assert from "node:assert/strict";
import { speedStreamIsTrustworthy, computeDecoupling, type RecordPoint } from "../lib/fit/compute";

// Build a 1Hz stream running at `trueMps`, optionally with a `speed` field that lies.
function stream(opts: { seconds: number; trueMps: number; claimedMps?: number; hr?: (i: number) => number }): RecordPoint[] {
  const pts: RecordPoint[] = [];
  for (let i = 0; i <= opts.seconds; i++) {
    pts.push({
      t: 1_700_000_000_000 + i * 1000,
      dist: i * opts.trueMps,
      hr: opts.hr ? opts.hr(i) : 140,
      ...(opts.claimedMps != null ? { speed: opts.claimedMps } : {}),
    });
  }
  return pts;
}

test("an honest speed stream is trusted", () => {
  assert.equal(speedStreamIsTrustworthy(stream({ seconds: 600, trueMps: 3.0, claimedMps: 3.0 })), true);
});

test("small disagreement between speed and distance is tolerated", () => {
  // GPS smoothing routinely puts these a few percent apart; that must not trip the guard.
  assert.equal(speedStreamIsTrustworthy(stream({ seconds: 600, trueMps: 3.0, claimedMps: 3.2 })), true);
});

// The real GymKit defect observed in the field: mean 16.09 m/s against a distance-derived
// 2.97 m/s — 5.4x, which is 36 mph on a treadmill.
test("the GymKit treadmill speed defect is rejected", () => {
  assert.equal(speedStreamIsTrustworthy(stream({ seconds: 1600, trueMps: 2.97, claimedMps: 16.09 })), false);
});

test("a stream with no speed field at all is not 'trustworthy' (callers use distance)", () => {
  assert.equal(speedStreamIsTrustworthy(stream({ seconds: 600, trueMps: 3.0 })), false);
});

// The bug that mattered: decoupling preferred `speed` and only fell back to distance
// when speed was ABSENT. Treadmill files have a speed field, so they never fell back —
// producing decoupling numbers computed entirely from noise, which then fed the
// LT1 argument in lib/config.ts.
test("decoupling ignores a corrupted speed stream and uses distance instead", () => {
  const seconds = 50 * 60;
  // Constant true pace, HR drifting 130 -> 150: real decoupling should be clearly positive.
  const hr = (i: number) => 130 + Math.floor((i / seconds) * 20);
  const honest = computeDecoupling(stream({ seconds, trueMps: 3.0, hr }));
  const corrupted = computeDecoupling(stream({ seconds, trueMps: 3.0, claimedMps: 16.09, hr }));
  assert.ok(honest != null && corrupted != null);
  assert.equal(
    corrupted, honest,
    "a lying speed field must not change the answer when distance is available",
  );
  assert.ok(honest > 5, `expected real drift to show, got ${honest}%`);
});

test("decoupling still works normally when the speed stream is honest", () => {
  const seconds = 50 * 60;
  const flat = computeDecoupling(stream({ seconds, trueMps: 3.0, claimedMps: 3.0, hr: () => 140 }));
  assert.ok(flat != null);
  assert.ok(Math.abs(flat) < 1, `steady pace + steady HR should be ~0% decoupled, got ${flat}%`);
});
