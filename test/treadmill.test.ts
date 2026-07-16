import test from "node:test";
import assert from "node:assert/strict";
import { isQualityEffort, isTreadmillRun } from "../lib/config";

test("isTreadmillRun: Strava trainer flag wins", () => {
  assert.equal(isTreadmillRun({ trainer: true }), true);
});

test("isTreadmillRun: no GPS + zero elevation = treadmill (heuristic)", () => {
  assert.equal(isTreadmillRun({ hasGps: false, elevationGain: 0 }), true);
});

test("isTreadmillRun: outdoor run with GPS is not treadmill", () => {
  assert.equal(isTreadmillRun({ hasGps: true, elevationGain: 120 }), false);
});

test("treadmill quality pace is now TRUSTED (GymKit) — counts like outdoor", () => {
  // GymKit belt-speed sync makes treadmill pace accurate, so a genuine sub-9:00
  // effort counts as quality on pace, exactly like an outdoor run. HR 150 is below
  // QUALITY_HR_BPM (155), so this isolates the pace branch.
  const opts = { avgHR: 150, paceSecondsPerMile: 520, distanceMiles: 5 };
  assert.equal(isQualityEffort({ ...opts, isTreadmill: false }), true, "outdoor: pace counts");
  assert.equal(isQualityEffort({ ...opts, isTreadmill: true }),  true, "treadmill: pace now trusted");
});

test("treadmill easy run stays easy — slow pace + low HR is not quality", () => {
  // A genuinely easy treadmill run (10:00/mi, HR 138) must not flag as quality.
  assert.equal(isQualityEffort({ avgHR: 138, paceSecondsPerMile: 600, distanceMiles: 6, isTreadmill: true }), false);
});

test("treadmill run still counts as quality if HR is genuinely high", () => {
  // HR is chest-strap accurate indoors, so a real hard treadmill effort flags.
  assert.equal(isQualityEffort({ avgHR: 165, paceSecondsPerMile: 529, distanceMiles: 5, isTreadmill: true }), true);
});

test("heat pace loosening applies outdoors only, never on a treadmill", () => {
  // 8:55/mi (535s) on an 85°F day: outdoors the threshold loosens to 9:10/mi so it
  // counts as quality; on a (climate-controlled) treadmill the 85°F is ignored —
  // but the base 9:00 threshold still makes 8:55 quality, so to prove the heat
  // branch is skipped we use a pace that ONLY qualifies under the loosened bar.
  const heatOpts = { avgHR: 140, paceSecondsPerMile: 545, distanceMiles: 5, avgTempF: 85 };
  assert.equal(isQualityEffort({ ...heatOpts, isTreadmill: false }), true,  "outdoor 85°F: loosened threshold (9:10) → quality");
  assert.equal(isQualityEffort({ ...heatOpts, isTreadmill: true }),  false, "treadmill: no heat loosening, 9:05 > 9:00 base → not quality");
});
