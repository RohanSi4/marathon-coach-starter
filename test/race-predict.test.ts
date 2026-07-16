import { test } from "node:test";
import assert from "node:assert/strict";
import { predictMarathon, marathonShape, tandaMarathonSeconds, fmtHMS, formatRaceBlock } from "../lib/race-predict";
import type { RacePredictInput } from "../lib/race-predict";

const HM_M = 21097.5;

const base: RacePredictInput = {
  engineVDOT: 50,
  benchmark: { distanceMeters: HM_M, timeSeconds: 2 * 3600 + 4, label: "HM 2:00:04", submaximal: true },
  recentWeeklyKm: 34, // ~21 mpw
  longestRecentKm: 13,
  meanTrainingPaceSecPerKm: 354, // ~9:30/mi
  goalSeconds: 3 * 3600 + 45 * 60,
};

test("marathonShape rises with volume and long-run distance, capped at 1", () => {
  assert.ok(marathonShape(20, 8) < marathonShape(60, 28));
  assert.equal(marathonShape(200, 200), 1); // clamped
  assert.ok(marathonShape(0, 0) === 0);
});

test("Tanda predicts a FASTER marathon as weekly volume climbs (on-thesis)", () => {
  const low = tandaMarathonSeconds(30, 354);
  const high = tandaMarathonSeconds(80, 354);
  assert.ok(high < low, "more volume should predict a faster marathon");
});

test("engine ceiling is faster than the on-today's-fitness estimate for a low-volume athlete", () => {
  const p = predictMarathon(base);
  assert.ok(p.engineCeilingSeconds < p.currentCenterSeconds,
    "a big engine on thin base: ceiling faster than current estimate");
});

test("the range brackets the center and reflects confidence", () => {
  const p = predictMarathon(base);
  assert.ok(p.rangeLowSeconds < p.currentCenterSeconds && p.currentCenterSeconds < p.rangeHighSeconds);
  assert.ok(["wide", "narrowing", "tight"].includes(p.confidence));
});

test("building volume raises Marathon Shape and narrows the range", () => {
  const thin = predictMarathon(base);
  const built = predictMarathon({ ...base, recentWeeklyKm: 68, longestRecentKm: 30 });
  assert.ok(built.shapePct > thin.shapePct);
  const thinWidth = thin.rangeHighSeconds - thin.rangeLowSeconds;
  const builtWidth = built.rangeHighSeconds - built.rangeLowSeconds;
  assert.ok(builtWidth < thinWidth, "more shape → tighter range");
});

test("shape-adjusted time approaches the engine ceiling as shape → 100%", () => {
  const built = predictMarathon({ ...base, recentWeeklyKm: 75, longestRecentKm: 34 });
  const vdotEquiv = built.models.find((m) => m.name === "VDOT-equivalent")!.seconds;
  // near-full shape → shape-adjusted within ~5% of the raw engine equivalent
  assert.ok(Math.abs(built.shapeAdjustedSeconds - vdotEquiv) / vdotEquiv < 0.06);
});

test("fmtHMS formats H:MM", () => {
  assert.equal(fmtHMS(3 * 3600 + 45 * 60), "3:45");
  assert.equal(fmtHMS(3 * 3600 + 5 * 60), "3:05");
});

test("formatted output labels the range as heuristic and submaximal evidence as conservative", () => {
  const block = formatRaceBlock(base);
  assert.match(block, /not a calibrated probability forecast/i);
  assert.match(block, /conservative extrapolation/i);
  assert.doesNotMatch(block, /most likely/i);
});
