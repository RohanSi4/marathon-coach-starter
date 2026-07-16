import test from "node:test";
import assert from "node:assert/strict";
import {
  matchKeyword, hasKeyword,
  INJURY_KEYWORDS, FUELING_KEYWORDS, ILLNESS_KEYWORDS,
} from "../lib/keywords";

// ─── Word-boundary matching: the false positives that used to fire ────────────

test("‘finishing strong’ is NOT an injury (no bare ‘shin’ substring match)", () => {
  assert.equal(hasKeyword("finishing strong, felt great", INJURY_KEYWORDS), false);
});

test("‘reached a new PR’ is NOT an injury (no ‘ache’ inside ‘reached’)", () => {
  assert.equal(hasKeyword("reached a new PR today", INJURY_KEYWORDS), false);
});

test("‘chipped away at it’ is NOT an injury (no ‘hip’ inside ‘chipped’)", () => {
  assert.equal(hasKeyword("chipped away at the miles", INJURY_KEYWORDS), false);
});

test("‘ate a bagel’ is NOT fueling (no ‘gel’ inside ‘bagel’)", () => {
  assert.equal(hasKeyword("ate a bagel before the run", FUELING_KEYWORDS), false);
});

// ─── Real signals still match ─────────────────────────────────────────────────

test("real injury words match", () => {
  assert.equal(matchKeyword("my right knee felt off", INJURY_KEYWORDS), "knee");
  assert.equal(matchKeyword("left hip flexor tight", INJURY_KEYWORDS), "hip");
  assert.ok(hasKeyword("shin splints acting up", INJURY_KEYWORDS));
});

test("real fueling words match", () => {
  assert.equal(matchKeyword("took a gel at mile 5", FUELING_KEYWORDS), "gel");
  assert.ok(hasKeyword("bonked hard at the end", FUELING_KEYWORDS));
});

test("‘cramp’ routes to fueling only, not injury (no double-flagging)", () => {
  assert.equal(hasKeyword("calf cramp late", FUELING_KEYWORDS), true);
  // (note "calf" is a real injury word, so this specific note flags both — but a
  // pure cramp note does not double-route)
  assert.equal(hasKeyword("stomach cramp", INJURY_KEYWORDS), false);
  assert.equal(hasKeyword("stomach cramp", FUELING_KEYWORDS), true);
});

test("illness matches whole words", () => {
  assert.ok(hasKeyword("lingering cold, breathing off", ILLNESS_KEYWORDS));
  assert.equal(hasKeyword("scolded myself for going out fast", ILLNESS_KEYWORDS), false); // 'cold' in 'scolded'
});
