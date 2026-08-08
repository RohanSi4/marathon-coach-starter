import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNewestWeekPlan, parseWeekPlans, plannedDayFor, planForDate, planWeekDays } from "../lib/plan-today";

const LOG = `# Coaching Log

## DATA CORRECTION (Feb 20, 2027 — no day lines here)
Some prose about a correction.

## Week of Mar 8–14, 2027 — Phase 1 (Base)
**Tier: GREEN**

**Prescribed (25.0mi):**
- Sun 3/7: Rest from running + **upper lift** + circuit
- Mon 3/8: Easy 4mi ≤145 + 4×20s strides
- Sat 3/13 🎯: **LR 9mi easy, outdoors** · gel ~45min

## WEEK CLOSE-OUT Mar 1–7 (no day lines)
Prose close-out.

## Week of Mar 1–7, 2027 — older entry
- Sun 2/28: Rest + upper lift
- Mon 3/1: Easy 4mi ≤145
`;

test("parses the newest week section with day lines", () => {
  const plan = parseNewestWeekPlan(LOG);
  assert.ok(plan);
  assert.match(plan!.heading, /Week of Mar 8–14, 2027/);
  assert.equal(plan!.weekStart, "2027-03-08");
  assert.equal(plan!.weekEnd, "2027-03-14");
  assert.equal(plan!.prescribedMiles, 25);
  assert.equal(plan!.days.length, 3);
});

test("skips heading-only sections without day lines", () => {
  const plan = parseNewestWeekPlan(LOG)!;
  assert.equal(plan.days[0].date, "2027-03-07");
  assert.equal(plan.days[0].dayLabel, "Sun 3/7");
});

test("strips markdown bold and keeps the prescription text", () => {
  const plan = parseNewestWeekPlan(LOG)!;
  assert.equal(plan.days[0].text, "Rest from running + upper lift + circuit");
  assert.ok(!plan.days[2].text.includes("**"));
});

test("flags the 🎯 key day and resolves a date lookup", () => {
  const plan = parseNewestWeekPlan(LOG)!;
  const lr = planForDate(plan, "2027-03-13");
  assert.ok(lr);
  assert.equal(lr!.isKeyDay, true);
  assert.equal(planForDate(plan, "2027-03-09"), undefined);
});

test("does not leak days from older sections", () => {
  const plan = parseNewestWeekPlan(LOG)!;
  assert.ok(plan.days.every(d => d.date >= "2027-03-07"));
});

test("limits the public week to the dates in its heading", () => {
  const plan = parseNewestWeekPlan(LOG)!;
  assert.deepEqual(planWeekDays(plan).map((day) => day.date), [
    "2027-03-08",
    "2027-03-13",
  ]);
});

test("returns null when no section has day lines", () => {
  assert.equal(parseNewestWeekPlan("# empty\n\n## Week of Jan 1, 2026\nprose only\n"), null);
});

// The bug this guards: a coach writes NEXT week's plan before the current week
// ends (correct practice). Parsing only the newest section then leaves every
// remaining day of the CURRENT week with no prescription at all.
const TWO_WEEK_LOG = `
## Week of Mar 8–14, 2027 — Phase 2

**Prescribed (~30mi)**

- Mon 3/8: Easy 5mi
- Tue 3/9 🎯: Threshold 6mi
- Wed 3/10: Rest

## Week of Mar 1–7, 2027 — Phase 2

**Prescribed (~28mi)**

- Fri 3/5: Easy 4mi
- Sat 3/6 🎯: Long run 12mi
- Sun 3/7: Rest
`;

test("parseWeekPlans returns several weeks, newest first", () => {
  const plans = parseWeekPlans(TWO_WEEK_LOG);
  assert.equal(plans.length, 2);
  assert.match(plans[0].heading, /Mar 8/);
  assert.match(plans[1].heading, /Mar 1/);
});

test("a day in the PREVIOUS week still resolves once next week is written", () => {
  const plans = parseWeekPlans(TWO_WEEK_LOG);
  // Sat 3/6 lives in the older section; the newest section starts 3/8.
  const day = plannedDayFor(plans, "2027-03-06");
  assert.equal(day?.text, "Long run 12mi");
  assert.equal(day?.isKeyDay, true);
  // And the newest week still resolves normally.
  assert.equal(plannedDayFor(plans, "2027-03-09")?.text, "Threshold 6mi");
});

test("parseNewestWeekPlan still returns just the newest section", () => {
  const plan = parseNewestWeekPlan(TWO_WEEK_LOG)!;
  assert.match(plan.heading, /Mar 8/);
  assert.equal(plan.days.length, 3);
});
