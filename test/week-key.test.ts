// Set a non-US machine TZ BEFORE importing, to prove weekKey() derives its
// buckets from the coach TZ (lib/config.ts coachTZ — America/New_York by
// default), not the local clock.
process.env.TZ = "Asia/Tokyo";

import test from "node:test";
import assert from "node:assert/strict";
import { weekKey } from "../lib/strava";
import { getWeekStartUnix } from "../lib/weeks";

test("Sunday evening (coach TZ) buckets into the PREVIOUS Monday's week", () => {
  // 2026-06-07T22:30:00Z = Sun Jun 7, 6:30pm ET → week of Mon Jun 1.
  assert.equal(weekKey(new Date("2026-06-07T22:30:00Z")), "Jun 1, 2026");
});

test("Late-night run that already crossed midnight UTC stays on its coach-TZ day", () => {
  // 2026-06-08T02:30:00Z = Sun Jun 7, 10:30pm ET — still the athlete's Sunday.
  // Coach-TZ bucketing keeps it in the week of Jun 1 instead of jumping to Jun 8
  // the way UTC would. This is the late-night-run midnight-crossing bug the
  // coach-TZ design exists to prevent.
  assert.equal(weekKey(new Date("2026-06-08T02:30:00Z")), "Jun 1, 2026");
});

test("Monday morning buckets to that Monday", () => {
  // 2026-06-08T13:00:00Z = Mon Jun 8 9:00am ET.
  assert.equal(weekKey(new Date("2026-06-08T13:00:00Z")), "Jun 8, 2026");
});

test("Mid-week (Wednesday) buckets to that week's Monday", () => {
  // 2026-06-10T16:00:00Z = Wed Jun 10 12:00pm ET.
  assert.equal(weekKey(new Date("2026-06-10T16:00:00Z")), "Jun 8, 2026");
});

test("result is independent of machine TZ (Asia/Tokyo set above)", () => {
  assert.equal(process.env.TZ, "Asia/Tokyo");
  assert.equal(weekKey(new Date("2026-06-08T02:30:00Z")), "Jun 1, 2026");
});

// ─── getWeekStartUnix across a DST transition ─────────────────────────────────
// The offset must be derived AT Monday 00:00, not at the current instant — a DST
// change between them (US transitions are Sunday 02:00) used to shift the week
// boundary by an hour, mis-bucketing Sunday-night runs near the edge.

test("fall-back week: Monday boundary uses Monday's EDT offset, not Sunday-night EST", () => {
  // Sun Nov 1 2026, 8pm EST (after the 2am fall-back). Week began Mon Oct 26,
  // 00:00 EDT = 04:00Z — NOT 05:00Z as the current (EST) offset would compute.
  const t = getWeekStartUnix(new Date("2026-11-02T01:00:00Z")); // Sun Nov 1, 20:00 EST
  assert.equal(t, Date.parse("2026-10-26T04:00:00Z") / 1000);
});

test("no transition in the week: boundary matches the current offset", () => {
  // Wed Jul 8 2026, noon ET → week of Mon Jul 6, 00:00 EDT = 04:00Z.
  const t = getWeekStartUnix(new Date("2026-07-08T16:00:00Z"));
  assert.equal(t, Date.parse("2026-07-06T04:00:00Z") / 1000);
});
