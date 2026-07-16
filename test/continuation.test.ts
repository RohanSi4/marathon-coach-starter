import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateContinuations } from "../lib/summarize";
import type { ActivitySummary } from "../lib/types";

function run(startMin: number, elapsedMin: number, miles: number, type = "Run"): ActivitySummary {
  return {
    type,
    name: type,
    dayOfWeek: "Monday",
    date: "Jul 13",
    distanceMiles: miles,
    durationFormatted: `${elapsedMin}min`,
    paceFormatted: "9:30/mi",
    elevationFt: 0,
    startMs: startMin * 60000,
    elapsedSec: elapsedMin * 60,
  };
}

test("a run starting 2min after the previous ended is a continuation", () => {
  const a = [run(0, 19, 2.0), run(21, 40, 4.33)];
  annotateContinuations(a);
  assert.equal(a[0].continuation, undefined);
  assert.ok(a[1].continuation);
  assert.equal(a[1].continuation!.gapMin, 2);
  assert.equal(a[1].continuation!.leg, 2);
  assert.equal(a[1].continuation!.combinedMiles, 6.33);
});

test("a 30min gap is a separate session", () => {
  const a = [run(0, 19, 2.0), run(49, 40, 4.33)];
  annotateContinuations(a);
  assert.equal(a[1].continuation, undefined);
});

test("three legs chain with a running combined total", () => {
  const a = [run(0, 20, 2.0), run(22, 20, 2.0), run(44, 20, 2.5)];
  annotateContinuations(a);
  assert.equal(a[1].continuation!.leg, 2);
  assert.equal(a[2].continuation!.leg, 3);
  assert.equal(a[2].continuation!.combinedMiles, 6.5);
});

test("non-run activities neither chain nor break a chain", () => {
  const a = [run(0, 19, 2.0), run(5, 60, 0, "WeightTraining"), run(21, 40, 4.33)];
  annotateContinuations(a);
  assert.equal(a[1].continuation, undefined);
  assert.ok(a[2].continuation, "run after a lift still chains to the previous run");
});

test("slight clock overlap still chains; missing timestamps do not", () => {
  const overlap = [run(0, 20, 3.0), run(19.5, 10, 1.0)];
  annotateContinuations(overlap);
  assert.ok(overlap[1].continuation);
  const noTs = [run(0, 19, 2.0), { ...run(21, 40, 4.33), startMs: undefined }];
  annotateContinuations(noTs);
  assert.equal(noTs[1].continuation, undefined);
});
