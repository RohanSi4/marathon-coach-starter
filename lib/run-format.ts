// ─── Compact run formatting (shared) ─────────────────────────────────────────
// Produces the one-line `keyRuns` string that build-history persists into
// athlete-profile.json AND that estimateCurrentVDOT (coach-prompt.ts) parses back
// out with regexes. Both sides live here so the WRITE format and the READ format
// can be tested together — a change to compactRun that breaks the parse is caught
// by a test instead of silently zeroing out the engine estimate.
//
// Format: `★4.0mi@8:00/mi(tm)(HR165) "note"`  (★=quality, (tm)=treadmill, note optional)
// Parsers in coach-prompt rely on: `([\d.]+)mi@`, `@(\d+):(\d+)/mi`, `\(HR(\d+)\)`.
import type { StravaActivity } from "./types";
import { isQualityEffort, isTreadmillRun } from "./config";
import { fmtPace } from "./strava";

export function isTm(a: StravaActivity): boolean {
  return isTreadmillRun({
    trainer: a.trainer,
    hasGps: Array.isArray(a.start_latlng) && a.start_latlng.length > 0,
    elevationGain: a.total_elevation_gain,
  });
}

export function isQuality(a: StravaActivity): boolean {
  return isQualityEffort({
    avgHR: a.average_heartrate,
    paceSecondsPerMile: a.average_speed > 0 ? 1609.344 / a.average_speed : undefined,
    distanceMiles: a.distance / 1609.344,
    avgTempF: a.average_temp != null ? Math.round(a.average_temp * 9 / 5 + 32) : undefined,
    isTreadmill: isTm(a),
  });
}

export function compactRun(a: StravaActivity, detail: StravaActivity | null): string {
  const miles = (a.distance / 1609.344).toFixed(1);
  const pace = fmtPace(a.average_speed);
  const hr = a.average_heartrate ? `(HR${Math.round(a.average_heartrate)})` : "";
  const q = isQuality(a) ? "★" : "";
  const tm = isTm(a) ? "(tm)" : "";  // treadmill tag (context) — pace is GymKit-accurate, INCLUDED in VDOT
  const note = detail?.description?.trim()?.slice(0, 30);
  return `${q}${miles}mi@${pace}${tm}${hr}${note ? ` "${note}"` : ""}`;
}
