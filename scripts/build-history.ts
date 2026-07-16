/**
 * Build athlete-profile.json — the weekly training history.
 *
 * SPLICE architecture (post-Strava-API, Jul 2026):
 *   - Weeks BEFORE FIT_SOURCE_SINCE (Jun 29, 2026) come VERBATIM from the frozen
 *     Strava-era baseline (data/athlete-profile.strava-baseline-2026-06-29.json).
 *     That preserves the Strava-description-derived injury log and key-run note
 *     fragments, which FIT files can never reproduce.
 *   - Weeks FROM that date are aggregated from the local FIT store
 *     (data/activities/, fed by `npm run import`).
 *
 * Fully offline — run `npm run import` first to pull in new workouts.
 *
 * Usage: npm run build-history
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { saveAthleteProfile } from "../lib/context";
import { FIT_SOURCE_SINCE } from "../lib/config";
import { getRawSince } from "../lib/source";
import {
  BASELINE_PROFILE_PATH,
  buildAthleteProfile,
  loadFrozenBaseline,
} from "../lib/history-profile";

function main() {
  console.log("[build-history] Building athlete profile (baseline splice + FIT store)...");

  const baseline = loadFrozenBaseline();
  if (baseline) {
    console.log(`  Baseline: ${BASELINE_PROFILE_PATH} (${baseline.weeks.length} weeks, Strava era)`);
  } else {
    console.warn(`  (!) No frozen baseline at ${BASELINE_PROFILE_PATH} — history will be FIT-store only.`);
  }

  const fitActivities = getRawSince(FIT_SOURCE_SINCE);
  console.log(`  FIT store: ${fitActivities.length} activities since ${FIT_SOURCE_SINCE.toDateString()}`);
  if (fitActivities.length === 0) {
    console.warn("  (!) FIT store has nothing since the splice date — run `npm run import`.");
  }

  const built = buildAthleteProfile(baseline, fitActivities);
  const { profile } = built;
  const merged = profile.weeks;

  saveAthleteProfile(profile);

  console.log("\n  ── Profile Built ──");
  console.log(`  Weeks tracked: ${merged.length} (${built.baselineWeeks} baseline + ${merged.length - built.baselineWeeks} FIT-era incl. gap fill)`);
  console.log(`  Peak week:     ${profile.peakWeekMiles.toFixed(1)}mi (${profile.peakWeekOf})`);
  console.log(`  Longest run:   ${profile.longestRun.toFixed(1)}mi (${profile.longestRunDate})`);
  console.log(`  Injury flags:  ${profile.injuryLog.length}`);
  console.log(`  Saved → data/athlete-profile.json\n`);

  const header = "  Week          | Miles | Long | Runs | Lifts | Q | TRIMP";
  const div    = "  " + "─".repeat(header.length - 2);
  console.log(header);
  console.log(div);
  for (const w of merged) {
    const cols = [
      w.weekStarting.padEnd(14),
      w.runMiles.toFixed(1).padStart(5) + "mi",
      (w.longRunMiles || 0).toFixed(1).padStart(4) + "mi",
      String(w.runDays).padStart(4),
      String(w.liftDays).padStart(5),
      String(w.qualityRuns).padStart(2),
      String(w.sufferTotal).padStart(6),
    ];
    console.log("  " + cols.join(" | "));
  }
}

main();
