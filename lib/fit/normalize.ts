// ─── FIT messages → StoredActivity ────────────────────────────────────────────
// Session-level summary + per-record streams → the Strava-field-compatible shape
// the rest of the pipeline consumes. Every optional field degrades to undefined —
// a FIT quirk should never throw away a workout.
import type { StoredActivity } from "../types";
import type { FitMessages } from "./decode";
import { mapSport } from "./sport-map";
import { RUN_TYPES } from "../weeks";
import {
  RecordPoint,
  computeMileSplits,
  computeHRZones,
  computeTrimp,
  computeHRDriftFromSplits,
  computeNormalizedPower,
  computeDecoupling,
  detectStrideBlips,
} from "./compute";

const SEMICIRCLE = 180 / 2 ** 31;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toRecordPoints(recordMesgs: Array<Record<string, unknown>>): RecordPoint[] {
  const pts: RecordPoint[] = [];
  for (const r of recordMesgs) {
    const ts = r.timestamp;
    if (!(ts instanceof Date)) continue;
    pts.push({
      t: ts.getTime(),
      hr: num(r.heartRate),
      dist: num(r.distance),
      alt: num(r.enhancedAltitude) ?? num(r.altitude),
      power: num(r.power),
      speed: num(r.enhancedSpeed) ?? num(r.speed),
    });
  }
  return pts;
}

// Apple reports steps/min; FIT `cadence` is formally rev/min (per-leg). A running
// cadence under 130 is physiologically per-leg (real spm is 150-200) → double it.
// Verified against real HealthFit fixtures in test/fit-normalize.test.ts.
function runCadenceSpm(avgCadence: number | undefined, fractional: number | undefined, isRun: boolean): number | undefined {
  if (avgCadence == null) return undefined;
  const raw = avgCadence + (fractional ?? 0);
  if (!isRun) return Math.round(raw);
  return Math.round(raw < 130 ? raw * 2 : raw);
}

export interface NormalizeOptions {
  hrRest?: number; // recovery-informed resting HR for TRIMP (defaults to config HR_REST)
}

export function normalizeFit(messages: FitMessages, sourceFile?: string, opts: NormalizeOptions = {}): StoredActivity | null {
  const session = messages.sessionMesgs?.[0];
  if (!session) return null;
  const startTime = session.startTime;
  if (!(startTime instanceof Date)) return null;

  const { type, trainer } = mapSport(
    session.sport as string | number | undefined,
    session.subSport as string | number | undefined
  );
  const isRun = RUN_TYPES.includes(type);

  const records = toRecordPoints(messages.recordMesgs ?? []);

  const distance = num(session.totalDistance)
    ?? (records.length > 0 ? records[records.length - 1].dist ?? 0 : 0)
    ?? 0;
  const elapsed = num(session.totalElapsedTime) ?? 0;
  const moving = num(session.totalTimerTime) ?? elapsed;
  const avgSpeed = moving > 0 ? distance / moving : 0;

  // First GPS fix → start_latlng (degrees from semicircles); null for indoor.
  let startLatlng: number[] | null = null;
  for (const r of messages.recordMesgs ?? []) {
    const lat = num(r.positionLat);
    const lng = num(r.positionLong);
    if (lat != null && lng != null) {
      startLatlng = [lat * SEMICIRCLE, lng * SEMICIRCLE];
      break;
    }
  }

  // Stream computations — splits/decoupling only for runs; zones/TRIMP for anything with HR.
  const splits = isRun ? computeMileSplits(records) : undefined;
  const hrZones = computeHRZones(records);
  const trimp = computeTrimp(records, opts.hrRest);
  const hrDriftBpm = computeHRDriftFromSplits(splits);
  const decouplingPct = isRun ? computeDecoupling(records) : undefined;
  const strideBlips = isRun ? detectStrideBlips(records) : undefined;
  const normalizedPower = computeNormalizedPower(records);
  const hasPower = records.some(r => r.power != null);

  const startISO = startTime.toISOString();
  const name = trainer && isRun ? "Treadmill Run"
    : type === "Run" ? "Run"
    : type.replace(/([a-z])([A-Z])/g, "$1 $2"); // "WeightTraining" → "Weight Training"

  return {
    schemaVersion: 1,
    source: "fit",
    sourceFile,
    key: `${startISO}_${type}`,
    id: Math.floor(startTime.getTime() / 1000),
    name,
    type,
    sport_type: type,
    start_date: startISO,
    distance,
    moving_time: Math.round(moving),
    elapsed_time: Math.round(elapsed),
    average_speed: avgSpeed,
    max_speed: num(session.enhancedMaxSpeed) ?? num(session.maxSpeed) ?? 0,
    total_elevation_gain: num(session.totalAscent) ?? 0,
    average_heartrate: num(session.avgHeartRate),
    max_heartrate: num(session.maxHeartRate),
    average_watts: num(session.avgPower),
    weighted_average_watts: normalizedPower ?? num(session.normalizedPower),
    device_watts: hasPower || num(session.avgPower) != null || undefined,
    calories: num(session.totalCalories),
    // Watch temperature sensor (Ultra 2) — real for indoor; outdoor runs get an
    // Open-Meteo override at import (skin heat skews the wrist sensor outside).
    average_temp: num(session.avgTemperature),
    // Apple's post-workout effort rating: FIT stores RPE ×10 (40 = 4/10).
    perceivedExertion: num(session.workoutRpe) != null ? Math.round(num(session.workoutRpe)! / 10) : undefined,
    average_cadence: runCadenceSpm(
      num(session.avgRunningCadence) ?? num(session.avgCadence),
      num(session.avgFractionalCadence),
      isRun
    ),
    trainer: trainer || undefined,
    start_latlng: startLatlng,
    splits,
    hrZones,
    hrDriftBpm,
    trimp,
    decouplingPct,
    strideBlips,
    fitSport: {
      sport: (session.sport as string | number) ?? "unknown",
      subSport: (session.subSport as string | number) ?? "unknown",
    },
  };
}
