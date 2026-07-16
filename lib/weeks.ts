// ─── Week math + shared formatters (source-agnostic) ─────────────────────────
// Extracted from lib/strava.ts so the FIT ingestion path (lib/fit/*, lib/store.ts)
// can use them without touching the dormant Strava client. lib/strava.ts re-exports
// everything here for backward compatibility.
import type { HistoricalWeek } from "./types";
import { coachTZ } from "./config";

export const RUN_TYPES = ["Run", "TrailRun", "VirtualRun"];

export function fmtPace(metersPerSecond: number): string {
  if (!metersPerSecond || metersPerSecond <= 0) return "N/A";
  // Round TOTAL seconds first so seconds never land on 60 ("7:60/mi").
  const total = Math.round(1609.344 / metersPerSecond);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}/mi`;
}

export function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Day of week (0=Sun … 6=Sat) as observed in the coaching TZ for that date,
// regardless of machine TZ.
export function zonedDayOfWeek(date: Date, tz: string = coachTZ(date)): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
  return WEEKDAYS.indexOf(wd);
}

// Monday-based week key — computed in the coaching TZ for that date regardless of
// machine TZ, so a run logged late at night lands on the day it was actually run
// (not shifted by a UTC/ET midnight crossing) and in the correct Monday week.
export function weekKey(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: coachTZ(date),
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10);
  const tzDay = WEEKDAYS.indexOf(parts.find(p => p.type === "weekday")!.value);
  const daysBack = tzDay === 0 ? 6 : tzDay - 1;
  const wall = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  wall.setUTCDate(wall.getUTCDate() - daysBack);
  return wall.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Epoch ms of a week key's calendar date, normalized to UTC midnight so week
// arithmetic is exact (no DST wobble from local-midnight parsing).
export function weekKeyUTCms(key: string): number {
  const d = new Date(key); // "Jun 29, 2026" — parses reliably in V8
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

// Advance a week key (e.g. "Jun 29, 2026") by 7 days to the next Monday's key.
export function nextWeekKey(key: string): string {
  const utc = new Date(weekKeyUTCms(key));
  utc.setUTCDate(utc.getUTCDate() + 7);
  return utc.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Insert zero rows for calendar weeks with NO activities at all (a full travel/off
// week produces no week key when grouping activities). Without them, ACWR's
// trailing-4-week chronic window silently spans extra calendar weeks and never
// averages in the true zero — understating injury risk exactly when it matters
// most: a mileage spike right after a layoff.
export function fillMissingWeeks(weeks: HistoricalWeek[]): HistoricalWeek[] {
  const out: HistoricalWeek[] = [];
  const WEEK_MS = 7 * 86_400_000;
  for (const week of weeks) {
    while (
      out.length > 0 &&
      weekKeyUTCms(out[out.length - 1].weekStarting) + WEEK_MS < weekKeyUTCms(week.weekStarting)
    ) {
      out.push({
        weekStarting: nextWeekKey(out[out.length - 1].weekStarting),
        runMiles: 0, runDays: 0, longRunMiles: 0, liftDays: 0,
        crossTrainingDays: 0, sufferTotal: 0, qualityRuns: 0,
        keyRuns: [], injuryNotes: [],
      });
    }
    out.push(week);
  }
  return out;
}

// Unix timestamp (seconds) for the most recent Monday 00:00:00 in the current
// coaching TZ. The zone offset is derived from Intl so DST is handled without a
// third-party library.
export function getWeekStartUnix(now: Date = new Date()): number {
  const tz = coachTZ(now);
  // Zone's wall-clock reading of an instant, reconstructed as a UTC Date so we
  // can do arithmetic; offset(t) = t − wall(t).
  const wallOf = (d: Date): Date => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(d);
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);
    let hour = get("hour");
    if (hour === 24) hour = 0; // some ICU builds emit 24 for midnight
    return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second")));
  };

  const wall = wallOf(now);
  const offsetNowMs = now.getTime() - wall.getTime();

  const day = wall.getUTCDay();
  const daysBack = day === 0 ? 6 : day - 1;
  const mondayWallUTC = new Date(wall);
  mondayWallUTC.setUTCDate(wall.getUTCDate() - daysBack);
  mondayWallUTC.setUTCHours(0, 0, 0, 0);

  // A DST transition between Monday 00:00 and now means Monday's offset differs
  // from the current one — re-derive the offset AT the Monday-midnight guess so
  // the week boundary lands on the true local midnight (US transitions happen
  // Sunday 02:00, so Monday 00:00 itself is never skipped/ambiguous).
  const guess = new Date(mondayWallUTC.getTime() + offsetNowMs);
  const offsetAtMondayMs = guess.getTime() - wallOf(guess).getTime();

  return Math.floor((mondayWallUTC.getTime() + offsetAtMondayMs) / 1000);
}
