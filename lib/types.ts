export interface StravaSplit {
  split: number;
  average_speed: number;
  average_heartrate?: number;
  elevation_difference?: number;
  moving_time: number;
  elapsed_time: number;
}

export interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  start_date: string;
  distance: number;              // meters
  moving_time: number;           // seconds
  elapsed_time: number;          // seconds
  average_speed: number;         // m/s
  max_speed: number;
  total_elevation_gain: number;  // meters
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  weighted_average_watts?: number;
  max_watts?: number;
  device_watts?: boolean;
  kilojoules?: number;
  suffer_score?: number;
  perceived_exertion?: number;   // 1-10 RPE, manually set by athlete
  calories?: number;
  pr_count?: number;
  achievement_count?: number;
  description?: string;
  device_name?: string;
  average_cadence?: number;
  average_temp?: number;         // celsius
  workout_type?: number;         // 0=default, 1=race, 2=long run, 3=workout
  splits_standard?: StravaSplit[];
  trainer?: boolean;             // Strava "indoor trainer" flag (treadmill)
  gear_id?: string;              // Strava gear (shoe) id, e.g. "g12345"
  start_latlng?: number[] | null; // empty/null when run had no GPS (indoor)
}

export interface StravaGear {
  id: string;
  name: string;
  nickname?: string;
  distance: number;              // meters, lifetime
  retired?: boolean;
  primary?: boolean;
}

export interface HRZoneSplit {
  zone: number;    // 1-5
  minBpm: number;
  maxBpm: number;
  seconds: number;
}

export interface MileSplit {
  mile: number;
  pace: string;
  avgHR?: number;
  elevFt?: number;  // signed elevation gain for this mile
}

// A short, sharp HR excursion above the local baseline — the signature strides
// leave in the HR stream. Mile splits average them away, so they're detected
// from the raw record stream at import (lib/fit/compute.ts detectStrideBlips).
export interface StrideBlip {
  atSec: number;       // seconds from run start, at the HR peak
  peakHR: number;      // raw max bpm inside the blip
  baseHR: number;      // local baseline it rose from
  durationSec: number; // length of the excursion (rise + decay)
}

export interface ActivitySummary {
  type: string;
  name: string;
  dayOfWeek: string;
  date: string;
  distanceMiles: number;
  durationFormatted: string;
  paceFormatted: string;
  elevationFt: number;
  avgHR?: number;
  maxHR?: number;
  avgWatts?: number;
  weightedWatts?: number;
  sufferScore?: number;
  perceivedExertion?: number;
  calories?: number;
  prCount?: number;
  notes?: string;
  coachNotes?: string;     // coach-authored daily context; kept separate from athlete reports
  hrZones?: HRZoneSplit[];
  cadence?: number;
  stoppedMinutes?: number;
  avgTempF?: number;
  workoutType?: string;
  splits?: MileSplit[];
  hrDriftBpm?: number;      // positive = HR climbed (fade), negative = HR dropped (good pacing)
  decouplingPct?: number;   // Pa:HR aerobic decoupling % (runs ≥40min; <5% = coupled/base built)
  strideBlips?: StrideBlip[]; // short HR spikes ≈ strides (invisible in mile splits)
  lifestyleNote?: string;   // detected lifestyle keywords (cigarette, alcohol, etc.) from description
  fuelingNote?: string;     // detected fueling keywords (gel, bonk, cramped, etc.) from description
  noWarmup?: boolean;       // true if no warmup detected from split data
  injuryNote?: string;      // description text if injury keywords found
  illnessNote?: string;     // description text if illness keywords found
  shoeNote?: string;        // description text if shoe/gear keywords found
  isTreadmill?: boolean;    // indoor/treadmill — GymKit-accurate pace/distance + H10 HR; flag is context (flat, wind-free)
  shoeName?: string;        // resolved Strava gear (shoe) name, if available
  startMs?: number;         // epoch ms of the recording start (continuation detection)
  elapsedSec?: number;      // wall-clock recording length (continuation detection)
  // Set when this recording started ≤15min after the previous run ended — one
  // continuous session split by a brief stop (bathroom/water), NOT a separate run.
  continuation?: { gapMin: number; leg: number; combinedMiles: number };
}

// ─── Stored activity (the local FIT-backed store, data/activities/) ───────────
// Deliberately reuses StravaActivity field names + units for the shared core so
// build-history aggregation, run-format, and the config classifiers consume it
// unchanged. TRIMP rides in the sufferScore/sufferTotal slots downstream (labels
// change to "TRIMP"; schema doesn't, so the frozen Strava baseline splices cleanly).
export interface StoredActivity {
  schemaVersion: 1;
  source: "fit" | "strava";
  sourceFile?: string;           // originating FIT filename (traceability)
  key: string;                   // dedupe key: `${startISO}_${type}`

  // Strava-compatible core (same names + units as StravaActivity)
  id: number;                    // start-time epoch seconds — stable + unique
  name: string;
  type: string;                  // Strava-style: "Run" | "WeightTraining" | "Basketball" | …
  sport_type: string;
  start_date: string;            // ISO UTC
  distance: number;              // meters
  moving_time: number;           // seconds (FIT totalTimerTime)
  elapsed_time: number;          // seconds (FIT totalElapsedTime)
  average_speed: number;         // m/s
  max_speed: number;
  total_elevation_gain: number;  // meters
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  weighted_average_watts?: number; // 30s-rolling normalized power
  device_watts?: boolean;
  calories?: number;
  average_cadence?: number;      // spm
  average_temp?: number;         // °C — watch sensor (session.avgTemperature) or Open-Meteo override for outdoor
  perceivedExertion?: number;    // 1-10 — Apple's post-workout effort rating (FIT workoutRpe ÷ 10)
  trainer?: boolean;             // FIT subSport === treadmill
  start_latlng?: number[] | null;
  description?: string;          // joined from the notes channel (lib/notes.ts)

  // Computed at import (replaces Strava's zones/splits endpoints)
  splits?: MileSplit[];
  hrZones?: HRZoneSplit[];
  hrDriftBpm?: number;
  trimp?: number;                // Banister TRIMP (suffer-score replacement)
  decouplingPct?: number;        // Pa:HR aerobic decoupling %, runs ≥40min (+ = faded)
  strideBlips?: StrideBlip[];    // short HR spikes ≈ strides, from the raw stream
  fitSport?: { sport: string | number; subSport: string | number }; // raw codes, debugging
}

export interface AdherenceResult {
  score: number;
  summary: string;
  hit: string[];
  missed: string[];
  modified: string[];
}

export interface WeekEntry {
  weekOf: string;
  runMiles: number;
  longRunMiles: number;
  runDays: number;
  liftDays: number;
  qualityWorkouts: number;
  prescribedMiles: number;
  adherenceScore: number;
  adherenceNotes: string;
  keyWorkoutsCompleted: string;
  avgSufferScore?: number;
  avgRunHR?: number;
  peakWatts?: number;
}

export interface TrainingHistory {
  weeks: WeekEntry[];
  lastPrescribedPlan: string;
  lastReportText: string;
}

// ─── Athlete Profile (built from full Strava history) ─────────────────────────

export interface HistoricalWeek {
  weekStarting: string;
  runMiles: number;
  runDays: number;
  longRunMiles: number;
  liftDays: number;
  crossTrainingDays: number;
  sufferTotal: number;
  avgRunHR?: number;
  qualityRuns: number;
  keyRuns: string[];      // compact: "10.2mi@9:15(HR150)", "6mi@8:30(HR165)"
  injuryNotes: string[];
}

export interface AthleteProfile {
  generatedAt: string;
  sinceDate: string;
  totalActivities: number;
  weeks: HistoricalWeek[];
  peakWeekMiles: number;
  peakWeekOf: string;
  longestRun: number;
  longestRunDate: string;
  injuryLog: string[];
}
