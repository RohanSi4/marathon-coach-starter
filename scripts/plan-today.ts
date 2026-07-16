// ─── npm run plan-today — today's prescription, straight from COACHING-LOG ────
// Usage: npm run plan-today            → today's workout + the rest of the week
//        npm run plan-today -- --week  → the full week
import fs from "fs";
import path from "path";
import { getWeeksToRace, getCurrentPhase } from "../lib/coach-prompt";
import { RACE_NAME } from "../lib/config";
import {
  parseNewestWeekPlan,
  planForDate,
  planWeekDays,
  todayKey,
} from "../lib/plan-today";

const LOG_PATH = path.join(process.cwd(), "COACHING-LOG.md");

function main(): void {
  let content: string;
  try {
    content = fs.readFileSync(LOG_PATH, "utf-8");
  } catch {
    console.error("[plan-today] COACHING-LOG.md not found — run from the repo root.");
    process.exit(1);
  }

  const plan = parseNewestWeekPlan(content);
  if (!plan) {
    console.error("[plan-today] no week section with day lines found in COACHING-LOG.md.");
    process.exit(1);
  }

  const today = todayKey();
  const todayPlan = planForDate(plan, today);
  const weekDays = planWeekDays(plan);
  const fullWeek = process.argv.includes("--week");

  console.log(`${RACE_NAME} — ${getWeeksToRace()} weeks out · ${getCurrentPhase()}`);
  console.log(`Newest plan: ${plan.heading}\n`);

  if (todayPlan) {
    console.log(`TODAY  ${todayPlan.dayLabel}${todayPlan.isKeyDay ? " 🎯" : ""}:`);
    console.log(`  ${todayPlan.text}\n`);
  } else if (weekDays.length > 0 && today < weekDays[0].date) {
    console.log(`TODAY (${today}): nothing prescribed. The newest plan starts ${weekDays[0].dayLabel}.\n`);
  } else {
    console.log(`TODAY (${today}) is past the newest logged plan — time to write the next week's entry.\n`);
  }

  const rest = fullWeek ? weekDays : weekDays.filter(d => d.date > today);
  if (rest.length > 0) {
    console.log(fullWeek ? "THE WEEK:" : "REST OF THE WEEK:");
    for (const d of rest) {
      const mark = d.date === today ? "→" : " ";
      console.log(`${mark} ${d.dayLabel}${d.isKeyDay ? " 🎯" : ""}: ${d.text}`);
    }
  }
}

main();
