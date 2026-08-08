// isHardCrossTraining flags basketball-style hidden hard sessions (logged as generic
// "Workout") so the READINESS block names them instead of letting a hard day hide as
// an innocuous "X" — the classic failure mode of pickup games stacked on long-run legs.
import test from "node:test";
import assert from "node:assert/strict";
import { isHardCrossTraining } from "../lib/coach-prompt";

test("basketball (Workout, HR 166/183) is hard cross-training", () => {
  assert.equal(isHardCrossTraining({ type: "Workout", avgHR: 166, maxHR: 183 }), true);
});

test("spiky game (avg only 140 but max 189) still flags on max HR", () => {
  assert.equal(isHardCrossTraining({ type: "Workout", avgHR: 140, maxHR: 189 }), true);
});

test("golf walk (HR 108/129) is not", () => {
  assert.equal(isHardCrossTraining({ type: "Golf", avgHR: 108, maxHR: 129 }), false);
});

test("lifting is never hard cross-training even at high HR", () => {
  assert.equal(isHardCrossTraining({ type: "WeightTraining", avgHR: 150, maxHR: 180 }), false);
});

test("runs are excluded (they are counted as runs, not cross-training)", () => {
  assert.equal(isHardCrossTraining({ type: "Run", avgHR: 170, maxHR: 190 }), false);
});

test("no HR data → not flagged (nothing to judge by)", () => {
  assert.equal(isHardCrossTraining({ type: "Workout" }), false);
});

test("Basketball sport type is hard even with no strap/HR data", () => {
  assert.equal(isHardCrossTraining({ type: "Basketball" }), true);
});

// Cutting sports are hard by MECHANISM. Racquet sports in particular sit well below
// both HR thresholds while still loading the knee laterally for over an hour, so
// judging them on heart rate alone silently files them as an ordinary easy day.
test("tennis is hard by mechanism even at easy-run heart rates", () => {
  assert.equal(isHardCrossTraining({ type: "Tennis", avgHR: 122, maxHR: 148 }), true);
});

test("soccer is hard even with no strap data at all", () => {
  assert.equal(isHardCrossTraining({ type: "Soccer" }), true);
});

// Guards the coupling between lib/fit/sport-map.ts and CUTTING_SPORTS: sport-map
// gives these their own activity types, and if this rule does not know the type,
// the mapping silently downgrades a hard session instead of flagging it.
test("a non-cutting sport at the same low HR is NOT flagged", () => {
  assert.equal(isHardCrossTraining({ type: "Swim", avgHR: 122, maxHR: 148 }), false);
});
