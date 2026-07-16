// ─── Weekly aggregation (shared by build-history and verify-migration) ────────
// Extracted from scripts/build-history.ts so the production history and the
// migration-verification diff can never disagree on the math. Works on anything
// StravaActivity-shaped — StoredActivity is structurally assignable (that's the
// whole point of keeping its field names), with TRIMP standing in for the retired
// Strava suffer score in the sufferTotal slot.
import type { StravaActivity, HistoricalWeek } from "./types";
import { weekKey, RUN_TYPES } from "./weeks";
import { coachTZ } from "./config";
import { INJURY_KEYWORDS, hasKeyword } from "./keywords";
import { compactRun, isQuality } from "./run-format";

export const LIFT_TYPES = ["WeightTraining", "Crossfit", "Strength"];

type Aggregatable = StravaActivity & { trimp?: number; description?: string };

export interface AggregateResult {
  weeks: HistoricalWeek[];       // chronological, NOT gap-filled (caller decides)
  injuryLog: string[];
  peakWeekMiles: number;
  peakWeekOf: string;
  longestRun: number;
  longestRunDate: string;
}

export function aggregateWeeks(all: Aggregatable[]): AggregateResult {
  const weekMap = new Map<string, Aggregatable[]>();
  for (const a of all) {
    const k = weekKey(new Date(a.start_date));
    if (!weekMap.has(k)) weekMap.set(k, []);
    weekMap.get(k)!.push(a);
  }

  const sorted = [...weekMap.entries()].sort(
    ([a], [b]) => new Date(a).getTime() - new Date(b).getTime()
  );

  const injuryLog: string[] = [];
  let peakWeekMiles = 0;
  let peakWeekOf = "";
  let longestRun = 0;
  let longestRunDate = "";
  const weeks: HistoricalWeek[] = [];

  for (const [wk, activities] of sorted) {
    const weekRuns = activities.filter(a => RUN_TYPES.includes(a.type));
    const lifts = activities.filter(a => LIFT_TYPES.includes(a.type));
    const cross = activities.filter(a => !RUN_TYPES.includes(a.type) && !LIFT_TYPES.includes(a.type));

    // Unique calendar days (2 sessions same day = 1 day), in the day's coach TZ.
    const toDay = (a: Aggregatable) => {
      const d = new Date(a.start_date);
      return d.toLocaleDateString("en-US", { timeZone: coachTZ(d) });
    };
    const liftUniqueDays = new Set(lifts.map(toDay)).size;
    const crossUniqueDays = new Set(cross.map(toDay)).size;

    const runMiles = weekRuns.reduce((s, r) => s + r.distance / 1609.344, 0);
    const longRun = weekRuns.length > 0
      ? Math.max(...weekRuns.map(r => r.distance / 1609.344))
      : 0;

    const runsWithHR = weekRuns.filter(r => r.average_heartrate);
    const avgRunHR = runsWithHR.length > 0
      ? Math.round(runsWithHR.reduce((s, r) => s + r.average_heartrate!, 0) / runsWithHR.length)
      : undefined;

    // TRIMP (FIT path) or suffer score (legacy Strava rows) — same slot.
    const sufferTotal = activities.reduce((s, a) => s + (a.suffer_score ?? a.trimp ?? 0), 0);
    const qualityRuns = weekRuns.filter(r => isQuality(r)).length;

    // Key runs: longest + quality efforts (up to 4 compact entries).
    const sortedRuns = [...weekRuns].sort((a, b) => b.distance - a.distance);
    const keyRunActivities: Aggregatable[] = [];
    for (const r of sortedRuns) {
      if (keyRunActivities.length >= 4) break;
      if (r.distance / 1609.344 >= 4 || isQuality(r)) keyRunActivities.push(r);
    }
    // StoredActivity carries description inline, so the activity doubles as its own
    // "detail" record for compactRun's note suffix.
    const keyRuns = keyRunActivities.map(a => compactRun(a, a));

    const weekInjuryNotes: string[] = [];
    for (const run of weekRuns) {
      const desc = (run.description ?? "").trim();
      if (hasKeyword(desc, INJURY_KEYWORDS)) {
        const note = `${wk}: "${desc}" (${run.name})`;
        weekInjuryNotes.push(note);
        injuryLog.push(note);
      }
    }

    if (runMiles > peakWeekMiles) { peakWeekMiles = runMiles; peakWeekOf = wk; }
    for (const r of weekRuns) {
      const m = r.distance / 1609.344;
      if (m > longestRun) { longestRun = m; longestRunDate = wk; }
    }

    weeks.push({
      weekStarting: wk,
      runMiles: parseFloat(runMiles.toFixed(1)),
      runDays: new Set(weekRuns.map(toDay)).size, // unique days — a double-run day is 1 day
      longRunMiles: parseFloat(longRun.toFixed(1)),
      liftDays: liftUniqueDays,
      crossTrainingDays: crossUniqueDays,
      sufferTotal,
      avgRunHR,
      qualityRuns,
      keyRuns,
      injuryNotes: weekInjuryNotes,
    });
  }

  return {
    weeks,
    injuryLog,
    peakWeekMiles: parseFloat(peakWeekMiles.toFixed(1)),
    peakWeekOf,
    longestRun: parseFloat(longestRun.toFixed(1)),
    longestRunDate,
  };
}
