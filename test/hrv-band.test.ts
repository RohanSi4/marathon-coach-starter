import { test } from "node:test";
import assert from "node:assert/strict";
import { hrvBand, HRV_BAND_MIN_DAYS } from "../lib/hrv-band";
import type { RecoveryDay } from "../lib/recovery";

const days = (hrvs: (number | undefined)[]): RecoveryDay[] =>
  hrvs.map((hrv, i) => ({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, hrv }));

test("hrvBand: collecting below the minimum days, reports latest only", () => {
  const b = hrvBand(days([100, 105, 98]))!;
  assert.equal(b.status, "collecting");
  assert.equal(b.latest, 98);
});

test("hrvBand: null when there is no HRV at all", () => {
  assert.equal(hrvBand(days([undefined, undefined])), null);
});

test("hrvBand: stable HRV reads 'balanced' within the band", () => {
  // Deterministic mild oscillation around 100; last-7 mean tracks the baseline.
  const stable = days(Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 96 : 104)));
  const b = hrvBand(stable)!;
  assert.equal(b.status, "balanced");
  assert.ok(b.lowerMs < b.baselineMs && b.baselineMs < b.upperMs);
});

test("hrvBand: a sustained recent DROP reads 'suppressed' (below band)", () => {
  const base = Array.from({ length: 25 }, () => 110);
  const drop = Array.from({ length: 7 }, () => 78); // last week well down
  const b = hrvBand(days([...base, ...drop]))!;
  assert.equal(b.status, "suppressed");
});

test("hrvBand: a sustained recent RISE reads 'primed' (above band)", () => {
  const base = Array.from({ length: 25 }, () => 90);
  const rise = Array.from({ length: 7 }, () => 130);
  const b = hrvBand(days([...base, ...rise]))!;
  assert.equal(b.status, "primed");
});

test("hrvBand: needs at least HRV_BAND_MIN_DAYS to form a band", () => {
  const justUnder = days(Array.from({ length: HRV_BAND_MIN_DAYS - 1 }, () => 100));
  assert.equal(hrvBand(justUnder)!.status, "collecting");
  const justEnough = days(Array.from({ length: HRV_BAND_MIN_DAYS }, () => 100));
  assert.notEqual(hrvBand(justEnough)!.status, "collecting");
});
