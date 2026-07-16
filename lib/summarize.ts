// ─── StoredActivity → ActivitySummary (offline, zero network) ─────────────────
// The FIT-path equivalent of lib/strava.ts summarizeActivities(): same output
// contract, so lib/coach-prompt.ts consumes it unchanged. Splits/zones/drift/TRIMP
// were already computed at import time; this layer adds date/TZ labels, keyword
// scanning of the joined note, shoe lookup, and the no-warmup read.
// TRIMP rides in the sufferScore slot (display label changes, schema doesn't).
import type { StoredActivity, ActivitySummary } from "./types";
import { isTreadmillRun, coachTZ, shoeForDate } from "./config";
import { RUN_TYPES, fmtPace, fmtDuration } from "./weeks";
import { INJURY_KEYWORDS, ILLNESS_KEYWORDS, FUELING_KEYWORDS, LIFESTYLE_KEYWORDS, SHOE_KEYWORDS, hasKeyword } from "./keywords";
import { DayNote, noteDateKey } from "./notes";

function parsePaceSecs(pace: string): number | undefined {
  const match = pace.match(/^(\d+):(\d{2})\/mi$/);
  if (!match) return undefined;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

export function summarize(a: StoredActivity, notes?: Map<string, DayNote>): ActivitySummary {
  const date = new Date(a.start_date);
  const isRun = RUN_TYPES.includes(a.type);
  const tz = coachTZ(date);

  const isTreadmill = isRun && isTreadmillRun({
    trainer: a.trainer,
    hasGps: Array.isArray(a.start_latlng) && a.start_latlng.length > 0,
    elevationGain: a.total_elevation_gain,
  });

  const note = notes?.get(noteDateKey(date));
  const athleteDesc = note?.athleteText.trim() || a.description?.trim() || undefined;
  const coachDesc = note?.coachText.trim() || undefined;
  // Keyword scans (injury/illness/fueling/lifestyle/shoe) run on ATHLETE-authored
  // text only — a note with a note is scanned by its athleteText (coach lines
  // stripped); with no note we fall back to the activity's own (athlete) description.
  const scanText = athleteDesc;
  const shoeName = isRun ? (note?.shoes ?? shoeForDate(date)) : undefined;

  // noWarmup: first mile HR > 150 AND first mile NOT ≥30s/mi slower than overall
  // avg pace (same semantics as the legacy Strava path).
  let noWarmup: boolean | undefined;
  const splits = a.splits;
  if (splits && splits.length > 0 && splits[0].avgHR !== undefined && splits[0].avgHR > 150) {
    const split1Secs = parsePaceSecs(splits[0].pace);
    const avgSecs = a.average_speed > 0 ? 1609.344 / a.average_speed : undefined;
    if (split1Secs !== undefined && avgSecs !== undefined && split1Secs - avgSecs < 30) {
      noWarmup = true;
    }
  }

  const stoppedSecs = (a.elapsed_time ?? 0) - (a.moving_time ?? 0);

  return {
    type: a.type,
    name: a.name,
    dayOfWeek: date.toLocaleDateString("en-US", { weekday: "long", timeZone: tz }),
    date: date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz }),
    distanceMiles: isRun ? parseFloat((a.distance / 1609.344).toFixed(2)) : 0,
    durationFormatted: fmtDuration(a.moving_time),
    paceFormatted: isRun ? fmtPace(a.average_speed) : "N/A",
    elevationFt: Math.round((a.total_elevation_gain ?? 0) * 3.28084),
    avgHR: a.average_heartrate != null ? Math.round(a.average_heartrate) : undefined,
    maxHR: a.max_heartrate != null ? Math.round(a.max_heartrate) : undefined,
    avgWatts: a.average_watts != null ? Math.round(a.average_watts) : undefined,
    weightedWatts: a.weighted_average_watts != null ? Math.round(a.weighted_average_watts) : undefined,
    sufferScore: a.trimp,          // TRIMP in the suffer slot (label changes downstream)
    perceivedExertion: note?.rpe ?? a.perceivedExertion, // athlete note wins over the watch prompt
    calories: a.calories,
    notes: athleteDesc,
    coachNotes: coachDesc,
    hrZones: a.hrZones,
    cadence: a.average_cadence != null ? Math.round(a.average_cadence) : undefined,
    stoppedMinutes: stoppedSecs > 120 ? Math.round(stoppedSecs / 60) : undefined,
    avgTempF: a.average_temp != null ? Math.round(a.average_temp * 9 / 5 + 32) : undefined,
    splits: a.splits,
    hrDriftBpm: a.hrDriftBpm,
    decouplingPct: a.decouplingPct,
    strideBlips: a.strideBlips,
    lifestyleNote: hasKeyword(scanText, LIFESTYLE_KEYWORDS) ? athleteDesc : undefined,
    fuelingNote: hasKeyword(scanText, FUELING_KEYWORDS) ? athleteDesc : undefined,
    noWarmup,
    injuryNote: hasKeyword(scanText, INJURY_KEYWORDS) ? athleteDesc : undefined,
    illnessNote: hasKeyword(scanText, ILLNESS_KEYWORDS) ? athleteDesc : undefined,
    shoeNote: hasKeyword(scanText, SHOE_KEYWORDS) ? athleteDesc : undefined,
    isTreadmill,
    shoeName,
    startMs: date.getTime(),
    elapsedSec: a.elapsed_time,
  };
}

// ─── Continuation detection (split recordings = one session) ───────────────────
// The athlete sometimes stops the watch mid-run (bathroom/water) and starts a NEW
// recording — two files, one run. Reading them as separate sessions distorts the
// coaching read (a "2mi run" that was really the first leg of a 6mi run). A run
// that starts within CONTINUATION_MAX_GAP_MIN of the previous run's END (start +
// elapsed) is the same session; later legs get `continuation` with the running
// combined mileage. Pure + in-place; non-runs and bigger gaps break the chain.
export const CONTINUATION_MAX_GAP_MIN = 15;

export function annotateContinuations(summaries: ActivitySummary[]): void {
  let prev: ActivitySummary | null = null;
  let combined = 0;
  let leg = 1;
  for (const s of summaries) {
    const isRun = RUN_TYPES.includes(s.type);
    if (!isRun || s.startMs == null || s.elapsedSec == null) {
      if (isRun) { prev = null; combined = 0; leg = 1; } // un-timestamped run breaks the chain
      continue; // non-runs (a lift between recordings) don't break a run chain
    }
    if (prev != null) {
      const prevEndMs = prev.startMs! + prev.elapsedSec! * 1000;
      const gapMin = (s.startMs - prevEndMs) / 60000;
      if (gapMin >= -1 && gapMin <= CONTINUATION_MAX_GAP_MIN) {
        leg++;
        combined += s.distanceMiles;
        s.continuation = {
          gapMin: Math.max(0, Math.round(gapMin * 10) / 10),
          leg,
          combinedMiles: Math.round(combined * 100) / 100,
        };
      } else {
        combined = s.distanceMiles;
        leg = 1;
      }
    } else {
      combined = s.distanceMiles;
      leg = 1;
    }
    prev = s;
  }
}
