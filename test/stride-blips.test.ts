import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStrideBlips, describeStrideBlips, type RecordPoint } from "../lib/fit/compute";

// 1 Hz synthetic HR series → RecordPoint[] (the shape the detector sees).
function series(seconds: number, hrAt: (t: number) => number): RecordPoint[] {
  const pts: RecordPoint[] = [];
  for (let t = 0; t <= seconds; t++) {
    pts.push({ t: t * 1000, hr: Math.round(hrAt(t)) });
  }
  return pts;
}

// A stride-shaped bump: sharp 15s rise to +peak, ~45s decay back to baseline.
function bump(t: number, at: number, peak: number): number {
  const dt = t - at;
  if (dt < 0 || dt > 60) return 0;
  if (dt <= 15) return peak * (dt / 15);
  return peak * (1 - (dt - 15) / 45);
}

test("detects 4 stride bumps on a flat easy run", () => {
  const strideTimes = [1200, 1320, 1440, 1560]; // 4 strides, 2min apart, late in the run
  const pts = series(1700, t => 142 + strideTimes.reduce((s, at) => s + bump(t, at, 13), 0));
  const blips = detectStrideBlips(pts);
  assert.ok(blips, "expected blips");
  assert.equal(blips!.length, 4);
  for (let i = 0; i < 4; i++) {
    // peak lands ~15s after the bump start
    assert.ok(Math.abs(blips![i].atSec - (strideTimes[i] + 15)) <= 10, `blip ${i} at ${blips![i].atSec}`);
    assert.ok(blips![i].peakHR >= 150, `peak ${blips![i].peakHR}`);
  }
});

test("a warmup ramp is not a stride", () => {
  // steady climb 100→145 over 10min, then flat — the classic early-run shape
  const pts = series(1200, t => (t < 600 ? 100 + (t / 600) * 45 : 145));
  assert.equal(detectStrideBlips(pts), undefined);
});

test("a 3-minute hill/surge is too long to be a stride", () => {
  const pts = series(1500, t => (t >= 900 && t < 1080 ? 154 : 142));
  assert.equal(detectStrideBlips(pts), undefined);
});

test("a stride that ends with the recording still counts", () => {
  // final stride: sharp rise starting 15s before the watch stops
  const pts = series(1500, t => 142 + (t > 1485 ? ((t - 1485) / 15) * 16 : 0));
  const blips = detectStrideBlips(pts);
  assert.ok(blips);
  assert.equal(blips!.length, 1);
  assert.ok(blips![0].peakHR >= 150);
});

test("small wiggles under the rise threshold are ignored", () => {
  const pts = series(1500, t => 142 + bump(t, 1200, 6)); // only +6bpm
  assert.equal(detectStrideBlips(pts), undefined);
});

test("too-short streams return undefined", () => {
  assert.equal(detectStrideBlips(series(60, () => 140)), undefined);
});

test("describeStrideBlips formats a readable one-liner", () => {
  const s = describeStrideBlips([
    { atSec: 2010, peakHR: 153, baseHR: 142, durationSec: 55 },
    { atSec: 2130, peakHR: 157, baseHR: 142, durationSec: 50 },
  ]);
  assert.match(s, /2 short HR spikes/);
  assert.match(s, /153\/157 bpm/);
  assert.match(s, /33:30, 35:30/);
});
