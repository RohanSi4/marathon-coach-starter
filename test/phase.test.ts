// getCurrentPhase maps weeks-to-race onto the textbook phase arc. These pins
// guard the boundaries so a refactor can't silently drift the phase the weekly
// coach-data dump reports. RACE_DATE-relative, so they hold for any configured race.
import test from "node:test";
import assert from "node:assert/strict";
import { getCurrentPhase, getWeeksToRace } from "../lib/coach-prompt";
import { RACE_DATE } from "../lib/config";

// A date exactly `weeks` weeks (plus a half-day cushion) before the race.
const weeksOut = (weeks: number) =>
  new Date(RACE_DATE.getTime() - weeks * 7 * 86_400_000 - 12 * 3_600_000);

test("deep in the build (20+ weeks out) is base", () => {
  assert.match(getCurrentPhase(weeksOut(22)), /Phase 1 — Base/);
  assert.match(getCurrentPhase(weeksOut(20)), /Phase 1 — Base/);
});

test("14-19 weeks out is threshold development", () => {
  assert.match(getCurrentPhase(weeksOut(19)), /Phase 2 — Threshold/);
  assert.match(getCurrentPhase(weeksOut(14)), /Phase 2 — Threshold/);
});

test("8-13 weeks out is the build + peak", () => {
  assert.match(getCurrentPhase(weeksOut(13)), /Phase 3 — Build/);
  assert.match(getCurrentPhase(weeksOut(8)), /Phase 3 — Build/);
});

test("4-7 weeks out is race-specific prep", () => {
  assert.match(getCurrentPhase(weeksOut(7)), /Phase 4 — Race-Specific/);
  assert.match(getCurrentPhase(weeksOut(4)), /Phase 4 — Race-Specific/);
});

test("1-3 weeks out is the taper", () => {
  assert.match(getCurrentPhase(weeksOut(3)), /Phase 5 — Taper/);
  assert.match(getCurrentPhase(weeksOut(1)), /Phase 5 — Taper/);
});

test("race week reads race week", () => {
  assert.match(getCurrentPhase(weeksOut(0)), /Race Week/);
});

test("getWeeksToRace floors correctly", () => {
  assert.equal(getWeeksToRace(weeksOut(16)), 16);
  assert.equal(getWeeksToRace(weeksOut(0)), 0);
});
