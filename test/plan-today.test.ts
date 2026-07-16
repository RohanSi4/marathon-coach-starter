import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNewestWeekPlan, planForDate, planWeekDays } from "../lib/plan-today";

const LOG = `# Coaching Log

## DATA CORRECTION (Jul 3, 2026 — no day lines here)
Some prose about a correction.

## Week of Jul 13–19, 2026 — Phase 1 (Base) · FIRST 30+ WEEK
**Tier: GREEN**

**Prescribed (32.0mi):**
- Sun 7/12: Rest from running + **LOWER #2** (light) + circuit
- Mon 7/13: Easy 5mi ≤150 + 4×20s strides + **UPPER #1**
- Sat 7/18 🎯: **LR 11.5mi easy, OUTDOORS** · gels ~40min + ~75min

## WEEK CLOSE-OUT Jul 6–12 (no day lines)
Prose close-out.

## Week of Jul 6–12, 2026 — older entry
- Sun 7/5: Rest + UPPER #2
- Mon 7/6: Easy 4mi ≤148
`;

test("parses the newest week section with day lines", () => {
  const plan = parseNewestWeekPlan(LOG);
  assert.ok(plan);
  assert.match(plan!.heading, /Week of Jul 13–19, 2026/);
  assert.equal(plan!.weekStart, "2026-07-13");
  assert.equal(plan!.weekEnd, "2026-07-19");
  assert.equal(plan!.prescribedMiles, 32);
  assert.equal(plan!.days.length, 3);
});

test("skips heading-only sections without day lines", () => {
  const plan = parseNewestWeekPlan(LOG)!;
  assert.equal(plan.days[0].date, "2026-07-12");
  assert.equal(plan.days[0].dayLabel, "Sun 7/12");
});

test("strips markdown bold and keeps the prescription text", () => {
  const plan = parseNewestWeekPlan(LOG)!;
  assert.equal(plan.days[0].text, "Rest from running + LOWER #2 (light) + circuit");
  assert.ok(!plan.days[2].text.includes("**"));
});

test("flags the 🎯 key day and resolves a date lookup", () => {
  const plan = parseNewestWeekPlan(LOG)!;
  const lr = planForDate(plan, "2026-07-18");
  assert.ok(lr);
  assert.equal(lr!.isKeyDay, true);
  assert.equal(planForDate(plan, "2026-07-14"), undefined);
});

test("does not leak days from older sections", () => {
  const plan = parseNewestWeekPlan(LOG)!;
  assert.ok(plan.days.every(d => d.date >= "2026-07-12"));
});

test("limits the public week to the dates in its heading", () => {
  const plan = parseNewestWeekPlan(LOG)!;
  assert.deepEqual(planWeekDays(plan).map((day) => day.date), [
    "2026-07-13",
    "2026-07-18",
  ]);
});

test("returns null when no section has day lines", () => {
  assert.equal(parseNewestWeekPlan("# empty\n\n## Week of Jan 1, 2026\nprose only\n"), null);
});
