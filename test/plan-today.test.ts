import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNewestWeekPlan, planForDate, planWeekDays } from "../lib/plan-today";

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
