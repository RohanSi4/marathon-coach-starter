import fs from "fs";
import path from "path";
import { aggregateWeeks } from "./aggregate";
import { FIT_SOURCE_SINCE } from "./config";
import type { AthleteProfile, HistoricalWeek, StoredActivity } from "./types";
import { fillMissingWeeks, weekKey, weekKeyUTCms } from "./weeks";

export const BASELINE_PROFILE_PATH = path.join(
  process.cwd(),
  "data",
  "athlete-profile.strava-baseline-2026-06-29.json"
);

export interface ProfileBuildResult {
  profile: AthleteProfile;
  baselineWeeks: number;
  fitActivities: number;
}

export function loadFrozenBaseline(file: string = BASELINE_PROFILE_PATH): AthleteProfile | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as AthleteProfile;
  } catch {
    return null;
  }
}

// Keep reporting inputs anchored to completed Monday-Sunday weeks. The current
// week's activities are supplied separately to coach-data as the acute workload;
// including them here would put the same partial week in both sides of ACWR and
// in the race predictor's recent-volume baseline.
export function completedActivities(
  activities: StoredActivity[],
  now: Date = new Date()
): StoredActivity[] {
  const currentWeekMs = weekKeyUTCms(weekKey(now));
  return activities.filter((activity) => {
    const activityWeekMs = weekKeyUTCms(weekKey(new Date(activity.start_date)));
    return activityWeekMs < currentWeekMs;
  });
}

export function completedWeeks(
  profile: AthleteProfile,
  now: Date = new Date()
): HistoricalWeek[] {
  const currentWeekMs = weekKeyUTCms(weekKey(now));
  return profile.weeks.filter((week) => weekKeyUTCms(week.weekStarting) < currentWeekMs);
}

// Shared baseline+FIT splice used by the persisted build and by read-only,
// in-memory refreshes in coach-data/status.
export function buildAthleteProfile(
  baseline: AthleteProfile | null,
  activities: StoredActivity[],
  generatedAt: Date = new Date(),
  spliceDate: Date = FIT_SOURCE_SINCE
): ProfileBuildResult {
  const fitActivities = activities.filter(
    (activity) => Date.parse(activity.start_date) >= spliceDate.getTime()
  );
  const fitAgg = aggregateWeeks(fitActivities);

  // Baseline weeks strictly BEFORE the splice date; FIT weeks from it onward.
  const spliceMs = spliceDate.getTime();
  const baselineWeeks: HistoricalWeek[] = (baseline?.weeks ?? []).filter(
    (week) => weekKeyUTCms(week.weekStarting) < spliceMs - 86_400_000 / 2
  );
  const merged = fillMissingWeeks([...baselineWeeks, ...fitAgg.weeks]);

  const fromBaseline = baseline ?? {
    peakWeekMiles: 0,
    peakWeekOf: "",
    longestRun: 0,
    longestRunDate: "",
    injuryLog: [],
    totalActivities: 0,
    sinceDate: FIT_SOURCE_SINCE.toISOString(),
  };
  const peakIsFit = fitAgg.peakWeekMiles > fromBaseline.peakWeekMiles;
  const longestIsFit = fitAgg.longestRun > fromBaseline.longestRun;

  return {
    baselineWeeks: baselineWeeks.length,
    fitActivities: fitActivities.length,
    profile: {
      generatedAt: generatedAt.toISOString(),
      sinceDate: fromBaseline.sinceDate,
      totalActivities: fromBaseline.totalActivities + fitActivities.length,
      weeks: merged,
      peakWeekMiles: peakIsFit ? fitAgg.peakWeekMiles : fromBaseline.peakWeekMiles,
      peakWeekOf: peakIsFit ? fitAgg.peakWeekOf : fromBaseline.peakWeekOf,
      longestRun: longestIsFit ? fitAgg.longestRun : fromBaseline.longestRun,
      longestRunDate: longestIsFit ? fitAgg.longestRunDate : fromBaseline.longestRunDate,
      injuryLog: [...fromBaseline.injuryLog, ...fitAgg.injuryLog],
    },
  };
}

export function buildCompletedAthleteProfile(
  baseline: AthleteProfile | null,
  activities: StoredActivity[],
  now: Date = new Date(),
  spliceDate: Date = FIT_SOURCE_SINCE
): ProfileBuildResult {
  return buildAthleteProfile(baseline, completedActivities(activities, now), now, spliceDate);
}
