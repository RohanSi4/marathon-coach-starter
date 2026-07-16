import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { zonedDayOfWeek } from "../lib/weeks";
import { loadAthleteProfile } from "../lib/context";
import { buildCoachingUserMessage, getWeeksToRace, getCurrentPhase, estimateCurrentVDOT } from "../lib/coach-prompt";
import { coachTZ, KNOWN_BENCHMARKS, GOAL_MARATHON_SECONDS } from "../lib/config";
import { getWeekSummaries, dataSource } from "../lib/source";
import { newestActivityAgeDays, loadActivities } from "../lib/store";
import { formatDurabilityBlock } from "../lib/durability";
import { formatLoadBlock } from "../lib/load";
import { formatHrvBand } from "../lib/hrv-band";
import { loadRecovery } from "../lib/recovery";
import { formatRaceBlock } from "../lib/race-predict";
import type { RacePredictInput } from "../lib/race-predict";
import {
  buildCompletedAthleteProfile,
  completedActivities,
  completedWeeks,
  loadFrozenBaseline,
} from "../lib/history-profile";

const KM = 1.609344;

// Assemble the ensemble-predictor inputs from the profile (weekly volume/long run)
// and the raw activity store (mean training pace over the last 28 days).
function raceInput(
  profile: ReturnType<typeof loadAthleteProfile>,
  activities: ReturnType<typeof loadActivities>,
  now: Date = new Date()
): RacePredictInput | null {
  const vdot = estimateCurrentVDOT(profile);
  if (!vdot || !profile) return null;
  const recent = completedWeeks(profile, now).slice(-4);
  const recentWeeklyKm = recent.length
    ? (recent.reduce((s, w) => s + w.runMiles, 0) / recent.length) * KM
    : 0;
  const longestRecentKm = recent.length ? Math.max(...recent.map((w) => w.longRunMiles)) * KM : 0;

  const cutoff = now.getTime() - 28 * 86_400_000;
  const runs = completedActivities(activities, now)
    .filter((a) => a.type === "Run" && Date.parse(a.start_date) >= cutoff && a.moving_time > 0);
  const totalM = runs.reduce((s, a) => s + a.distance, 0);
  const totalS = runs.reduce((s, a) => s + a.moving_time, 0);
  const meanTrainingPaceSecPerKm = totalM > 0 ? totalS / (totalM / 1000) : 354;

  const bench = KNOWN_BENCHMARKS.find((b) => b.distanceMeters > 15000); // prefer the HM over the 5K
  return {
    engineVDOT: vdot.vdot,
    benchmark: bench
      ? { distanceMeters: bench.distanceMeters, timeSeconds: bench.timeSeconds, label: bench.label, submaximal: /submaximal/i.test(bench.label) }
      : undefined,
    recentWeeklyKm,
    longestRecentKm,
    meanTrainingPaceSecPerKm,
    goalSeconds: GOAL_MARATHON_SECONDS,
  };
}

// ─── coach-data ───────────────────────────────────────────────────────────────
// The weekly data dump for INTERACTIVE coaching. Prints everything Claude needs
// to write the plan: this week's activities (splits, HR zones, power, treadmill
// flags, note-derived injury/fueling flags), the history block, live VDOT
// estimate, ACWR / training-load (TRIMP), and long-run milestones.
//
// Data source: the local FIT store (data/activities/, fed by `npm run import`).
// Run `npm run import` FIRST so this week's workouts are present. Read-only.
//
// Usage:  npm run import && npm run coach-data
//         then in Claude Code: "write this week's plan"

async function main() {
  const now = new Date();
  // Sunday: plan the upcoming Mon–Sun week. Any other day: plan from today.
  const planStartDate = new Date(now);
  if (zonedDayOfWeek(now) === 0) planStartDate.setDate(planStartDate.getDate() + 1);

  console.log("════════════════════════════════════════════════════════════════");
  console.log(`  MARATHON COACH — data dump · ${now.toDateString()}`);
  console.log(`  Weeks to race: ${getWeeksToRace()}`);
  console.log(`  Phase: ${getCurrentPhase()}`);
  console.log(`  Coaching TZ: ${coachTZ(now)} (auto-switches to America/New_York on Aug 29)`);
  console.log(`  Data source: ${dataSource() === "fit" ? "local FIT store (Apple Health via HealthFit)" : "Strava API (legacy fallback)"}`);
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  → Before writing the plan, read COACHING-LOG.md for last week's");
  console.log("    prescription (score adherence) and the multi-week arc.");
  console.log("════════════════════════════════════════════════════════════════\n");

  if (dataSource() === "fit") {
    const age = newestActivityAgeDays();
    if (age == null) {
      console.warn("(!) FIT store is EMPTY — run `npm run import` (and check HealthFit auto-export).\n");
    } else if (age > 2.5) {
      console.warn(`(!) Newest stored activity is ${age.toFixed(1)} days old — run \`npm run import\``);
      console.warn("    and confirm with the athlete that nothing is missing before coaching.\n");
    }
  }

  const activities = await getWeekSummaries();

  const persistedProfile = loadAthleteProfile();
  let profile = persistedProfile;
  let allActivities: ReturnType<typeof loadActivities> | null = null;

  // A persisted profile can predate late-week imports even when its timestamp is
  // only a few days old. Rebuild completed history in memory on every FIT-backed
  // report; this command remains read-only, and this week's partial activity stays
  // solely in the acute side of the coaching calculations.
  if (dataSource() === "fit") {
    allActivities = loadActivities();
    const built = buildCompletedAthleteProfile(loadFrozenBaseline(), allActivities, now);
    profile = built.profile;
    const latest = profile.weeks.at(-1)?.weekStarting ?? "none";
    console.log(`Built current history in memory: ${profile.weeks.length} completed weeks (through ${latest}; persisted profile unchanged).`);
  }

  if (!profile) {
    console.warn("(!) No athlete-profile.json found — run `npm run build-history` to\n" +
      "    build the full historical context before coaching.\n");
  } else if (dataSource() === "fit") {
    console.log("");
  } else {
    const ageDays = (now.getTime() - new Date(profile.generatedAt).getTime()) / 86_400_000;
    const age = ageDays < 1 ? "today" : `${Math.round(ageDays)}d ago`;
    console.log(`Loaded athlete profile: ${profile.weeks.length} weeks of history (refreshed ${age}).`);
    if (ageDays > 8) {
      console.warn("(!) Profile is over a week old — run `npm run build-history` to refresh\n" +
      "    history + workload context before coaching (stale mileage distorts the ramp read).");
    }
    console.log("");
  }

  const context = buildCoachingUserMessage(activities, null, null, planStartDate, profile, now);
  console.log(context);

  // Derived-metric blocks — computed here from the full store/recovery history
  // (they need more than this week's activities, so they aren't threaded through
  // buildCoachingUserMessage). See lib/{durability,load,hrv-band,race-predict}.ts.
  if (dataSource() === "fit") {
    const all = allActivities ?? loadActivities();
    console.log("\n" + formatDurabilityBlock(all));
    console.log("\n" + formatLoadBlock(all));
    console.log("\n" + formatHrvBand(loadRecovery()));
    const ri = raceInput(profile, all, now);
    if (ri) console.log("\n" + formatRaceBlock(ri));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
