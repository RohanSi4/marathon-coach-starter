import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { getWeeksToRace, getCurrentPhase } from "../lib/coach-prompt";
import { RACE_DATE, RACE_NAME } from "../lib/config";
import { loadAthleteProfile } from "../lib/context";
import { loadActivities } from "../lib/store";
import { dataSource } from "../lib/source";
import { buildCompletedAthleteProfile, loadFrozenBaseline } from "../lib/history-profile";

function main() {
  const now = new Date();
  const profile = dataSource() === "fit"
    ? buildCompletedAthleteProfile(loadFrozenBaseline(), loadActivities(), now).profile
    : loadAthleteProfile();
  const weeksToRace = getWeeksToRace();
  const phase = getCurrentPhase().split(" — ")[0]; // "Phase 1" only

  const raceDateStr = RACE_DATE.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  console.log("── Marathon Coach Status ──────────────────────────────────────────");
  console.log(`  Race:     ${RACE_NAME} — ${raceDateStr} (${weeksToRace} weeks away)`);
  console.log(`  Phase:    ${phase}`);

  if (profile && profile.weeks.length > 0) {
    const lastWeek = profile.weeks[profile.weeks.length - 1];
    console.log(`  Latest completed (${lastWeek.weekStarting}): ${lastWeek.runMiles.toFixed(1)}mi | long run ${lastWeek.longRunMiles.toFixed(1)}mi | ${lastWeek.liftDays} lifts | TRIMP ${lastWeek.sufferTotal}`);
    console.log(`  Peak wk:  ${profile.peakWeekMiles.toFixed(1)}mi (${profile.peakWeekOf}) | longest run ${profile.longestRun.toFixed(1)}mi`);
    if (profile.injuryLog.length > 0) {
      console.log(`  Injuries: ${profile.injuryLog[profile.injuryLog.length - 1]}`);
    }
  } else {
    console.log("  Profile:  not built — run npm run build-history");
  }

  console.log("  Plans:    tracked in COACHING-LOG.md — run npm run coach-data to write next week's");
  console.log("──────────────────────────────────────────────────────────────────");
}

main();
