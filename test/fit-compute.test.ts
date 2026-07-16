// Pure-math tests for the FIT stream computations — synthetic RecordPoint arrays,
// no FIT decoding needed. These encode the coaching semantics: moving-time splits
// (pauses excluded), our own 5-zone HR buckets, Banister TRIMP, Coggan NP.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RecordPoint,
  computeMileSplits,
  computeHRZones,
  computeTrimp,
  computeHRDriftFromSplits,
  computeNormalizedPower,
  computeDecoupling,
} from "../lib/fit/compute";

const MILE = 1609.344;
const T0 = Date.parse("2026-07-01T13:00:00Z");

// Constant-pace run: `secPerMile` seconds per mile, 1s records.
function steadyRun(miles: number, secPerMile: number, hr: number): RecordPoint[] {
  const speed = MILE / secPerMile; // m/s
  const totalSec = Math.round(miles * secPerMile);
  const pts: RecordPoint[] = [];
  for (let s = 0; s <= totalSec; s++) {
    pts.push({ t: T0 + s * 1000, dist: s * speed, hr, power: 200 });
  }
  return pts;
}

test("steady 2mi @ 9:00/mi yields two 9:00 splits with correct HR", () => {
  const splits = computeMileSplits(steadyRun(2, 540, 145))!;
  assert.equal(splits.length, 2);
  assert.equal(splits[0].pace, "9:00/mi");
  assert.equal(splits[1].pace, "9:00/mi");
  assert.equal(splits[0].avgHR, 145);
  assert.equal(splits[0].mile, 1);
  assert.equal(splits[1].mile, 2);
});

test("a 60s pause mid-run is excluded from split pace (moving time)", () => {
  const pts = steadyRun(1, 540, 140);
  // Shift the second half 60s later in time — a stopped-at-a-light gap in records
  // (Apple auto-pause stops recording, so a pause IS a timestamp gap).
  const shifted = pts.map(p => (p.t - T0 > 270_000 ? { ...p, t: p.t + 60_000 } : p));
  const splits = computeMileSplits(shifted)!;
  // The gap interval's own second of movement is unmeasurable inside the gap, so the
  // moving pace may read 1s fast — but never the 60s-slower polluted pace.
  assert.match(splits[0].pace, /^(8:59|9:00)\/mi$/);
});

test("partial final split is included at its true pace", () => {
  const splits = computeMileSplits(steadyRun(1.5, 600, 150))!;
  assert.equal(splits.length, 2);
  assert.equal(splits[1].pace, "10:00/mi"); // partial half-mile still reads 10:00/mi pace
});

test("sub-quarter-mile activities produce no splits", () => {
  assert.equal(computeMileSplits(steadyRun(0.2, 540, 140)), undefined);
});

test("HR zones: exactly 5 sorted zones; steady Z2 run lands its time in Z2", () => {
  const zones = computeHRZones(steadyRun(1, 540, 140))!; // HR 140 → Z2 (131-150)
  assert.equal(zones.length, 5);
  for (let i = 1; i < 5; i++) assert.ok(zones[i].minBpm > zones[i - 1].minBpm);
  assert.equal(zones[1].zone, 2);
  assert.ok(Math.abs(zones[1].seconds - 540) <= 2);
  assert.equal(zones[0].seconds + zones[2].seconds + zones[3].seconds + zones[4].seconds, 0);
});

test("TRIMP: ~30min @ HR 140 lands in the mid-30s and scales with HR", () => {
  const easy = computeTrimp(steadyRun(3.33, 540, 140))!;  // ~30min
  assert.ok(easy >= 33 && easy <= 38, `expected mid-30s, got ${easy}`);
  const hard = computeTrimp(steadyRun(3.33, 540, 175))!;  // same duration, threshold HR
  assert.ok(hard > easy * 1.5, `hard (${hard}) should dwarf easy (${easy})`);
});

test("TRIMP: no HR data → undefined", () => {
  const noHR = steadyRun(1, 540, 140).map(p => ({ ...p, hr: undefined }));
  assert.equal(computeTrimp(noHR), undefined);
});

test("HR drift: fading run reports positive drift, steady run reports none", () => {
  const fading = [
    { mile: 1, pace: "9:00/mi", avgHR: 135 }, { mile: 2, pace: "9:00/mi", avgHR: 138 },
    { mile: 3, pace: "9:00/mi", avgHR: 150 }, { mile: 4, pace: "9:00/mi", avgHR: 152 },
  ];
  assert.equal(computeHRDriftFromSplits(fading), 15);
  const steady = fading.map(s => ({ ...s, avgHR: 140 }));
  assert.equal(computeHRDriftFromSplits(steady), undefined);
});

test("decoupling: steady run ~0%; second-half HR fade reads positive; short runs skip", () => {
  const speed = MILE / 540;
  const mk = (totalSec: number, hrAt: (s: number) => number): RecordPoint[] => {
    const pts: RecordPoint[] = [];
    for (let s = 0; s <= totalSec; s++) {
      pts.push({ t: T0 + s * 1000, dist: s * speed, speed, hr: hrAt(s) });
    }
    return pts;
  };

  const steady = computeDecoupling(mk(3600, () => 140))!;          // 60min, flat HR
  assert.ok(Math.abs(steady) < 0.5, `steady should be ~0%, got ${steady}`);

  const faded = computeDecoupling(mk(3600, s => (s < 1800 ? 140 : 154)))!; // +10% HR late
  assert.ok(faded > 8 && faded < 12, `expected ~10% fade, got ${faded}`);

  assert.equal(computeDecoupling(mk(1200, () => 140)), undefined); // 20min: too short
});

test("normalized power: constant 200W → NP 200; surging beats steady", () => {
  assert.equal(computeNormalizedPower(steadyRun(2, 540, 140)), 200);
  const surgy = steadyRun(2, 540, 140).map((p, i) =>
    ({ ...p, power: Math.floor(i / 60) % 2 === 0 ? 280 : 120 })); // 1min on/off, avg 200
  const np = computeNormalizedPower(surgy)!;
  assert.ok(np > 205, `NP of surges (${np}) must exceed the 200W average`);
});
