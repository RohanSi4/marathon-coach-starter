import type { ActivitySummary, AdherenceResult, TrainingHistory, AthleteProfile } from "./types";
import { RACE_DATE, isQualityEffort, GOAL_MARATHON_SECONDS, GOAL_TIME, GOAL_PACE, KNOWN_BENCHMARKS, MAX_HR, coachTZ, EASY_HR_FLOOR, AEROBIC_THRESHOLD_BPM } from "./config";
import { raceVDOT, equivalentRaces, vdotFromHRPace, trainingPaces, fmtPaceMMSS } from "./vdot";
import { weekKey, zonedDayOfWeek, weekKeyUTCms, nextWeekKey } from "./weeks";
import { loadRecovery, recoveryReadiness, recoveryDetail, vo2maxTrend } from "./recovery";
import { describeStrideBlips } from "./fit/compute";
import { annotateContinuations } from "./summarize";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function getWeeksToRace(now: Date = new Date()): number {
  return Math.floor((RACE_DATE.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 7));
}

// Generic weeks-to-race phase mapping (Pfitzinger/Daniels hybrid). Once the
// athlete's build is underway, the COACH may re-anchor these to their real
// calendar (edit the thresholds below or replace with explicit dates) — the
// textbook boundaries are the starting point, not a contract; the adaptive
// tiers in CLAUDE.md always outrank the label printed here.
const PHASES: { minWeeksOut: number; label: string }[] = [
  { minWeeksOut: 20, label: "Phase 1 — Base Building: ALL easy running, zero threshold — build frequency + mileage ≤10-15%/wk, grow the long run" },
  { minWeeksOut: 14, label: "Phase 2 — Threshold Development: ONE tempo/cruise-interval session per week, long run keeps growing" },
  { minWeeksOut: 8,  label: "Phase 3 — Build + Peak: 2 quality/wk, long runs with goal-pace miles at the back, peak mileage, gut-train fueling" },
  { minWeeksOut: 4,  label: "Phase 4 — Race-Specific Prep: race-sim long runs at goal pace, last longest run ~3.5-4 weeks out" },
  { minWeeksOut: 1,  label: "Phase 5 — Taper: volume −10/−35/−50%, INTENSITY UNCHANGED, last quality 10-12 days out" },
  { minWeeksOut: -Infinity, label: "Race Week — trust the training, strides only, rest" },
];

export function getCurrentPhase(now: Date = new Date()): string {
  const w = getWeeksToRace(now);
  return PHASES.find(p => w >= p.minWeeksOut)!.label;
}

function getNextSunday(from: Date): Date {
  const d = new Date(from);
  const daysUntilSunday = (7 - zonedDayOfWeek(d)) % 7 || 7;
  d.setDate(d.getDate() + daysUntilSunday);
  return d;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: coachTZ(d) });
}

// ─── VDOT ESTIMATOR ──────────────────────────────────────────────────────────
// Daniels model lives in lib/vdot.ts. Estimates CURRENT VO2max fitness from his
// hardest efforts, HR-adjusted: because he deliberately holds back, a run's avg HR
// (relative to MAX_HR) sets how hard it was, and VDOT = VO2(pace) / %VO2max(HR).
// Only uses genuinely hard runs (avg HR ≥ 80% max, ≥2mi, with HR) — the band where
// the HR→VO2max relationship is reliable. Median across runs. NOTE: this is VO2max /
// engine fitness, NOT marathon readiness — the marathon is endurance/volume-limited.
// A real race/TT in KNOWN_BENCHMARKS beats this and the caller shows it alongside.

const HARD_EFFORT_PCT_MAX = 0.80; // avg HR ≥ 80% max = a real effort (below is easy/noisy)
const MIN_VDOT_DISTANCE_MI = 2;

export function estimateCurrentVDOT(profile: AthleteProfile | null): { vdot: number; basis: string } | null {
  if (!profile) return null;

  const hrFloor = HARD_EFFORT_PCT_MAX * MAX_HR;
  const estimates: { vdot: number; label: string }[] = [];
  for (const week of profile.weeks.slice(-8)) {
    for (const run of week.keyRuns) {
      const paceMatch = run.match(/@(\d+):(\d+)\/mi/);
      const hrMatch = run.match(/\(HR(\d+)\)/);
      const distMatch = run.match(/([\d.]+)mi@/);
      if (!paceMatch || !hrMatch || !distMatch) continue; // need pace AND HR AND distance

      const paceSeconds = parseInt(paceMatch[1]) * 60 + parseInt(paceMatch[2]);
      const hr = parseInt(hrMatch[1]);
      const dist = parseFloat(distMatch[1]);
      if (hr < hrFloor || dist < MIN_VDOT_DISTANCE_MI) continue;

      estimates.push({
        vdot: Math.round(vdotFromHRPace(paceSeconds, hr, MAX_HR)),
        label: `${dist.toFixed(1)}mi@${paceMatch[1]}:${paceMatch[2]} HR${hr} (${Math.round((hr / MAX_HR) * 100)}%max)`,
      });
    }
  }

  if (estimates.length === 0) return null;

  const sorted = [...estimates].sort((a, b) => a.vdot - b.vdot);
  const median = sorted[Math.floor(sorted.length / 2)];
  const basis =
    `${estimates.length} hard effort${estimates.length > 1 ? "s" : ""} HR-adjusted to max ${MAX_HR} ` +
    `(median ${median.label}); VO2max/engine fitness — confirm with a race/TT`;
  return { vdot: median.vdot, basis };
}

// ─── LONG RUN MILESTONE PROJECTIONS ─────────────────────────────────────────
// Textbook weeks-out targets, derived from RACE_DATE. The COACH should re-anchor
// these to the athlete's real build once it's underway (a detrained athlete's
// milestones land later than a stock plan; a fit one's may land earlier) — edit
// the weeksOut values below when the build calendar is set during onboarding.

const LR_MILESTONES = [
  { miles: 12, weeksOut: 16, note: "base — long run growing" },
  { miles: 14, weeksOut: 12, note: "threshold phase mid" },
  { miles: 16, weeksOut: 9, note: "build phase — first goal-pace miles at the back" },
  { miles: 18, weeksOut: 7, note: "build phase peak stretch" },
  { miles: 20, weeksOut: 5, note: "peak long run — last longest run ~3.5-4 wks out" },
];

function buildLongRunMilestones(now: Date = new Date()): string {
  // Keep milestones from the current week forward (a milestone stays visible
  // through its own week, then drops off).
  const milestones = LR_MILESTONES
    .map(m => ({ ...m, weekOf: new Date(RACE_DATE.getTime() - m.weeksOut * 7 * 86_400_000) }))
    .filter(m => m.weekOf.getTime() >= now.getTime() - 7 * 86_400_000);

  if (milestones.length === 0) return "";

  const lines = milestones.map(m => {
    const dateStr = m.weekOf.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: coachTZ(m.weekOf) });
    return `  ${m.miles}mi → week of ${dateStr} (${m.note}, ~${m.weeksOut} weeks out)`;
  });
  return `LONG RUN MILESTONES (textbook targets from RACE_DATE — re-anchor to the athlete's real build):\n${lines.join("\n")}`;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

// Validate HR zones from Strava: must have exactly 5 zones, sorted by minBpm ascending.
// Strava does not guarantee ordering and may return incomplete arrays.
// Returns the validated + sorted array, or undefined if invalid.
function validateHRZones(zones: ActivitySummary["hrZones"]): ActivitySummary["hrZones"] {
  if (!zones || zones.length !== 5) return undefined;
  const sorted = [...zones].sort((a, b) => a.minBpm - b.minBpm);
  return sorted;
}

function fmtZones(zones: ActivitySummary["hrZones"]): string {
  const validZones = validateHRZones(zones);
  if (!validZones) return "";
  const total = validZones.reduce((s, z) => s + z.seconds, 0);
  if (total === 0) return "";
  return validZones
    .filter((z) => z.seconds > 0)
    .map((z) => `Z${z.zone}:${Math.round(z.seconds / 60)}min(${Math.round((z.seconds / total) * 100)}%)`)
    .join(" ");
}

function parsePaceMins(pace: string): number {
  const m = pace.match(/^(\d+):(\d+)/);
  if (!m) return 999;
  return parseInt(m[1]) + parseInt(m[2]) / 60;
}

function detectWarmupMile(splits: ActivitySummary["splits"]): boolean {
  if (!splits || splits.length < 3) return false;
  const firstPace = parsePaceMins(splits[0].pace);
  const restPaces = splits.slice(1).map(s => parsePaceMins(s.pace));
  const median = restPaces.sort((a, b) => a - b)[Math.floor(restPaces.length / 2)];
  return firstPace - median >= 1.0;
}

function fmtActivity(a: ActivitySummary, includeDayContext = true): string {
  const header = a.workoutType ? `[${a.workoutType.toUpperCase()}] ` : "";
  const parts: string[] = [`${header}${a.dayOfWeek} ${a.date} | ${a.type} | ${a.name}`];

  if (a.continuation) parts.push(`↳ CONTINUATION (leg ${a.continuation.leg})`);
  if (a.distanceMiles > 0) parts.push(`${a.distanceMiles.toFixed(2)}mi${a.isTreadmill ? " (tm)" : ""}`);
  parts.push(a.durationFormatted);
  if (a.paceFormatted !== "N/A") parts.push(a.paceFormatted);
  if (a.cadence) parts.push(`${a.cadence}spm`);
  if (a.avgHR) parts.push(`HR ${Math.round(a.avgHR)}avg${a.maxHR != null ? `/${Math.round(a.maxHR)}max` : ""}`);
  // Show BOTH avg and weighted watts so the coach can apply the fade rule
  // (weighted > avg by 10%+ = positive split; weighted < avg = negative split).
  if (a.avgWatts != null || a.weightedWatts != null) {
    const w = a.avgWatts != null && a.weightedWatts != null
      ? `${a.avgWatts}avg/${a.weightedWatts}wtd W`
      : `${a.avgWatts ?? a.weightedWatts}W`;
    parts.push(w);
  }
  if (a.elevationFt > 0) parts.push(`+${a.elevationFt}ft`);
  if (a.avgTempF != null) parts.push(`${a.avgTempF}°F`);
  if (a.stoppedMinutes) parts.push(`stopped:${a.stoppedMinutes}min`);
  if (a.perceivedExertion) parts.push(`RPE:${a.perceivedExertion}/10`);
  if (a.sufferScore) parts.push(`TRIMP:${a.sufferScore}`);
  if (a.prCount) parts.push(`${a.prCount}PR`);
  if (a.calories) parts.push(`${a.calories}cal`);

  let line = parts.join(" | ");

  const zones = fmtZones(a.hrZones);
  if (zones) line += `\n  HR zones: ${zones}`;

  if (a.splits && a.splits.length > 0) {
    const hasWarmup = detectWarmupMile(a.splits);
    const splitStr = a.splits.map((s, i) => {
      const hrPart = s.avgHR ? `@${s.avgHR}` : "";
      const elevPart = s.elevFt != null && s.elevFt !== 0
        ? `(${s.elevFt > 0 ? "+" : ""}${s.elevFt}ft)`
        : "";
      const warmupTag = (i === 0 && hasWarmup) ? "[wu]" : "";
      return `M${s.mile}:${s.pace}${hrPart}${elevPart}${warmupTag}`;
    }).join(" ");
    line += `\n  Splits: ${splitStr}`;
  }

  if (a.hrDriftBpm != null) {
    const sign = a.hrDriftBpm > 0 ? "+" : "";
    const label = a.hrDriftBpm > 0 ? "(cardiac drift — possible heat/fatigue)" : "(HR dropped — strong pacing)";
    line += `\n  HR drift: ${sign}${a.hrDriftBpm}bpm first→last half ${label}`;
  }
  if (a.decouplingPct != null) {
    const d = a.decouplingPct;
    const label = d < 5 ? "(<5% = aerobically COUPLED — the base is holding)"
      : d < 10 ? "(5-10% = moderate fade — endurance still building; fine in base)"
      : "(>10% = big second-half fade — too fast, too hot, or beyond current endurance)";
    line += `\n  Aerobic decoupling (Pa:HR): ${d > 0 ? "+" : ""}${d}% ${label}`;
  }
  if (a.strideBlips && a.strideBlips.length > 0) {
    line += `\n  Stride check: ${describeStrideBlips(a.strideBlips)} — mile splits hide these; this is the raw-stream read`;
  }
  if (a.continuation) {
    line += `\n  ↳ CONTINUATION: started ${a.continuation.gapMin}min after the previous run ended — ` +
      `ONE continuous session split by a brief stop (bathroom/water), not a separate run. ` +
      `Combined so far: ${a.continuation.combinedMiles}mi. Judge pacing/HR/decoupling across the whole session.`;
  }

  if (a.isTreadmill) line += `\n  TREADMILL (indoor) — pace & distance are accurate: the Apple Watch syncs belt speed via GymKit and HR is from a chest strap (if worn). Trust the numbers and treat a fast effort as a real quality run. Context that still matters: it's flat, wind-free, and climate-controlled, so it lacks the hill specificity of the race course and the heat-adaptation stimulus of an outdoor summer run. Sanity check: if pace looks fast but HR is easy (the two disagree sharply), GymKit may not have synced that session — judge by HR.`;
  if (a.shoeName) line += `\n  Shoe: ${a.shoeName}`;
  if (includeDayContext && a.notes) line += `\n  Athlete note: "${a.notes}"`;
  if (includeDayContext && a.coachNotes) line += `\n  Coach context: "${a.coachNotes}"`;
  if (includeDayContext && a.lifestyleNote) line += `\n  Lifestyle note: "${a.lifestyleNote}"`;
  if (includeDayContext && a.fuelingNote) line += `\n  Fueling note: "${a.fuelingNote}"`;
  if (a.noWarmup && !a.isTreadmill) line += `\n  ⚠ NO WARMUP — started at full pace from mile 1`;
  if (includeDayContext && a.injuryNote) line += `\n  ⚠ INJURY NOTED: "${a.injuryNote}"`;
  if (includeDayContext && a.illnessNote) line += `\n  ⚠ RUNNING SICK: "${a.illnessNote}"`;
  if (includeDayContext && a.shoeNote) line += `\n  ⚠ SHOE/GEAR ISSUE: "${a.shoeNote}"`;

  return line;
}

function detectInjuryFlags(activities: ActivitySummary[]): string[] {
  // Reuse the per-activity injuryNote (already decided on athlete-authored text in
  // summarize) rather than re-scanning a.notes, which includes coach annotations and
  // would re-introduce false flags from negated mentions like "no knee pain".
  const seen = new Set<string>();
  const flags: string[] = [];
  for (const a of activities) {
    if (a.injuryNote == null) continue;
    const key = `${a.dayOfWeek}|${a.injuryNote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push(`${a.dayOfWeek}: "${a.injuryNote}"`);
  }
  return flags;
}

// ─── Hidden hard cross-training (basketball etc.) ─────────────────────────────
// Basketball logs as a generic "Workout" but is a HARD session (HR 165-190, cutting/
// jumping on fatigued legs — his biggest non-running injury risk, right knee side).
// Detect any non-run, non-lift activity that was cardio-hard so it's named in the
// READINESS block instead of hiding as an innocuous "X" in the history table.
const LIFT_TYPES = ["WeightTraining", "Crossfit", "Strength"];
const HARD_XT_AVG_HR = 145;
const HARD_XT_MAX_HR = 175;

export function isHardCrossTraining(a: Pick<ActivitySummary, "type" | "avgHR" | "maxHR">): boolean {
  if (a.type.toLowerCase().includes("run") || LIFT_TYPES.includes(a.type)) return false;
  // FIT-era basketball carries its own sport type: hard by nature (cutting/jumping),
  // so flag it even when the strap wasn't worn and there's no HR to judge by.
  if (a.type === "Basketball") return true;
  return (a.avgHR ?? 0) >= HARD_XT_AVG_HR || (a.maxHR ?? 0) >= HARD_XT_MAX_HR;
}

// Thin wrapper over the shared isQualityEffort classifier (lib/config.ts) so the
// live pipeline and build-history can never drift on what counts as "quality".
export function isQualityRun(a: ActivitySummary): boolean {
  const m = a.paceFormatted.match(/^(\d+):(\d+)/);
  const paceSecondsPerMile = m ? parseInt(m[1]) * 60 + parseInt(m[2]) : undefined;
  return isQualityEffort({
    avgHR: a.avgHR,
    paceSecondsPerMile,
    distanceMiles: a.distanceMiles,
    avgTempF: a.avgTempF,
    isTreadmill: a.isTreadmill,
  });
}

// ─── Training load (CTL/ATL/TSB approximation from suffer scores) ─────────────

function computeTrainingLoad(profile: AthleteProfile | null, thisWeekSuffer: number, currentWeekKey?: string): {
  ctlWeeks: number;
  zeroWeeks: number;
  ctl: number;
  atl: number;
  tsb: number;
  status: string;
} {
  // Exclude the current (partial) week from the chronic window — otherwise, when
  // build-history is rebuilt mid-week, this week's partial load sits in BOTH the
  // chronic baseline and the acute (thisWeekSuffer) figure, skewing TSB.
  const weeks = (profile?.weeks ?? []).filter(w => w.weekStarting !== currentWeekKey);
  const recent = weeks.slice(-6);
  // Average only weeks that HAVE load data — Strava-era weeks carry sufferTotal 0
  // (never backfilled), and mixing them in dilutes CTL toward 0, which makes any
  // normal FIT-era week read as a massive TSB deficit ("OVERREACHED" false alarm).
  const withLoad = recent.filter(w => w.sufferTotal > 0);
  const ctl = withLoad.length > 0
    ? Math.round(withLoad.reduce((s, w) => s + w.sufferTotal, 0) / withLoad.length)
    : 0;
  const zeroWeeks = recent.length - withLoad.length;
  const atl = thisWeekSuffer;
  const tsb = ctl - atl;
  let status: string;
  if (withLoad.length === 0) status = "NO TRIMP BASELINE YET (zero weeks with load data — TSB is meaningless; judge by mileage, symptoms, and HR trends)";
  else if (tsb > 15) status = "FRESH (consider adding volume/intensity)";
  else if (tsb > -10) status = "NEUTRAL";
  else if (tsb > -25) status = "MODERATELY FATIGUED (normal training load)";
  else if (tsb > -40) status = "FATIGUED (consider easy week)";
  else status = "OVERREACHED — recovery week mandatory";
  return { ctlWeeks: withLoad.length, zeroWeeks, ctl, atl, tsb, status };
}

// ─── ACWR: Acute:Chronic Workload Ratio (mileage-change heuristic) ─────────────
//
// More reliable than the suffer-score CTL/ATL above, because Strava never
// backfills suffer scores (historical weeks are all 0) but mileage is always
// present. Acute = this week's run mileage. Chronic = average weekly run mileage
// over the trailing 4 weeks (a 28-day rolling load proxy). Ratio = acute/chronic.
//
// ACWR is useful for surfacing a large change relative to recent mileage, but its
// thresholds are not calibrated injury probabilities and the causal evidence is
// contested—especially for runners. It can prompt review; it must not diagnose
// injury risk or overrule symptoms, recovery, and the actual training context.
export function computeACWR(profile: AthleteProfile | null, thisWeekMiles: number, currentWeekKey?: string): {
  acute: number;
  chronic: number;
  ratio: number | null;
  status: string;
  reliable: boolean;
} {
  // Chronic = trailing 4 COMPLETED weeks. Exclude the current week so a mid-week
  // build-history rebuild doesn't put this week's partial mileage into both the
  // acute figure and the chronic baseline (which would distort the ratio).
  const weeks = (profile?.weeks ?? []).filter(w => w.weekStarting !== currentWeekKey);
  // A trailing layoff never produces week rows (fillMissingWeeks only fills gaps
  // BETWEEN active weeks), so without this the chronic average is computed from
  // pre-layoff weeks and green-lights a comeback spike — the highest-risk moment
  // for a returning runner. Append the missing zero weeks up to the current week.
  if (currentWeekKey && weeks.length > 0) {
    const WEEK_MS = 7 * 86_400_000;
    const currentMs = weekKeyUTCms(currentWeekKey);
    while (
      !Number.isNaN(currentMs) &&
      weekKeyUTCms(weeks[weeks.length - 1].weekStarting) + WEEK_MS < currentMs
    ) {
      weeks.push({
        weekStarting: nextWeekKey(weeks[weeks.length - 1].weekStarting),
        runMiles: 0, runDays: 0, longRunMiles: 0, liftDays: 0,
        crossTrainingDays: 0, sufferTotal: 0, qualityRuns: 0,
        keyRuns: [], injuryNotes: [],
      });
    }
  }
  const last4 = weeks.slice(-4);
  const chronic = last4.length > 0
    ? last4.reduce((s, w) => s + w.runMiles, 0) / last4.length
    : 0;
  const acute = thisWeekMiles;
  const ratio = chronic > 0 ? acute / chronic : null;
  // Need a few weeks of non-trivial chronic load for the ratio to mean anything.
  const reliable = last4.length >= 3 && chronic >= 8;

  let status: string;
  if (ratio == null) status = acute > 0
    ? "insufficient history (current load has no established chronic base — review as a comeback)"
    : "insufficient history (no chronic base yet)";
  else if (!reliable) status = `provisional (chronic base only ${chronic.toFixed(0)}mi/wk — ratio noisy until base is established)`;
  else if (ratio < 0.8) status = "LOW relative load (<0.8 — step-back/detraining context)";
  else if (ratio <= 1.3) status = "STEADY relative load (0.8–1.3)";
  else if (ratio <= 1.5) status = "ELEVATED change (1.3–1.5 — review recovery and symptoms)";
  else status = "LARGE workload spike (>1.5 — hold progression and review context; not an injury prediction)";

  return {
    acute: parseFloat(acute.toFixed(1)),
    chronic: parseFloat(chronic.toFixed(1)),
    ratio: ratio != null ? parseFloat(ratio.toFixed(2)) : null,
    status,
    reliable,
  };
}

// ─── Athlete profile block ────────────────────────────────────────────────────

function buildProfileBlock(profile: AthleteProfile | null): string {
  if (!profile || profile.weeks.length === 0) {
    return "FULL TRAINING HISTORY: Not yet built. Run `npm run build-history` to initialize.\n";
  }

  const MAX_HISTORY_WEEKS = 20;
  const totalWeeks = profile.weeks.length;
  const displayWeeks = totalWeeks > MAX_HISTORY_WEEKS
    ? profile.weeks.slice(-MAX_HISTORY_WEEKS)
    : profile.weeks;
  const truncationNote = totalWeeks > MAX_HISTORY_WEEKS
    ? ` — showing last ${MAX_HISTORY_WEEKS} of ${totalWeeks} weeks`
    : "";

  const header = `FULL TRAINING HISTORY — frozen Strava-era baseline + FIT store (${profile.weeks[0].weekStarting} → ${profile.weeks[totalWeeks - 1].weekStarting} | ${totalWeeks} weeks | ${profile.totalActivities} total activities${truncationNote}):`;

  const rows = displayWeeks.map(w => {
    const keyStr = w.keyRuns.length > 0 ? ` | ${w.keyRuns.slice(0, 2).join(", ")}` : "";
    const hrStr = w.avgRunHR ? ` HR${w.avgRunHR}` : "";
    const injStr = w.injuryNotes.length > 0 ? " ⚠" : "";
    return `  ${w.weekStarting.padEnd(15)} | ${w.runMiles.toFixed(1).padStart(5)}mi | LR${(w.longRunMiles || 0).toFixed(1).padStart(5)}mi | ${w.runDays}R ${w.liftDays}L ${w.crossTrainingDays}X | Q${w.qualityRuns} | TRIMP${w.sufferTotal}${hrStr}${injStr}${keyStr}`;
  }).join("\n");

  const recentWeeks = profile.weeks.slice(-4);
  const recentAvgMiles = recentWeeks.reduce((s, w) => s + w.runMiles, 0) / Math.max(recentWeeks.length, 1);

  const lines = [
    header,
    rows,
    "",
    `  Peak week: ${profile.peakWeekMiles.toFixed(1)}mi (${profile.peakWeekOf})`,
    `  Longest run: ${profile.longestRun.toFixed(1)}mi (${profile.longestRunDate})`,
    `  4-week avg: ${recentAvgMiles.toFixed(1)}mi/week`,
  ];

  if (profile.injuryLog.length > 0) {
    lines.push("");
    lines.push(`INJURY LOG (${profile.injuryLog.length} flagged):`);
    profile.injuryLog.forEach(note => lines.push(`  ${note}`));
  }

  return lines.join("\n");
}

// ─── Main user message builder ────────────────────────────────────────────────

export function buildCoachingUserMessage(
  activities: ActivitySummary[],
  history: TrainingHistory | null,
  adherence: AdherenceResult | null,
  planStartDate: Date,
  athleteProfile: AthleteProfile | null,
  asOfDate: Date = new Date()
): string {
  annotateContinuations(activities); // split recordings (bathroom/water stop) → flagged as one session
  const runs = activities.filter((a) => a.type.toLowerCase().includes("run"));
  const runMiles = runs.reduce((sum, a) => sum + a.distanceMiles, 0);
  // Indoor/outdoor mix (standing rule, Jul 7 2026): the athlete drifts toward
  // all-treadmill weeks. Aerobically fine, but it skips hills (most race courses'
  // half), heat adaptation, and road-surface tissue loading — surface the ratio
  // so the coach prescribes outdoor when the mix tips, LONG RUN OUTDOORS default.
  const indoorRuns = runs.filter((a) => a.isTreadmill).length;
  const indoorLine =
    runs.length > 0 && indoorRuns / runs.length > 0.5
      ? ` | indoor ${indoorRuns}/${runs.length} runs ⚠ mostly treadmill — prescribe outdoor miles (long run outdoors is the default; hills + heat + road surface don't happen on the belt)`
      : runs.length > 0
        ? ` | indoor ${indoorRuns}/${runs.length} runs`
        : "";
  const longRunMiles = runs.length > 0 ? Math.max(...runs.map((a) => a.distanceMiles)) : 0;
  // Unique lift DAYS (2 sessions same day = 1 day) — matches build-history's count.
  const liftDays = [...new Set(
    activities
      .filter((a) => LIFT_TYPES.includes(a.type))
      .map((a) => a.dayOfWeek)
  )];

  const avgRunHR = runs.filter((r) => r.avgHR).length > 0
    ? Math.round(runs.filter((r) => r.avgHR).reduce((s, r) => s + r.avgHR!, 0) / runs.filter((r) => r.avgHR).length)
    : null;

  const thisWeekSuffer = activities.reduce((s, a) => s + (a.sufferScore ?? 0), 0);
  const currentWeekKey = weekKey(asOfDate);
  const load = computeTrainingLoad(athleteProfile, thisWeekSuffer, currentWeekKey);
  const acwr = computeACWR(athleteProfile, runMiles, currentWeekKey);

  const injuryFlags = detectInjuryFlags(activities);

  const nextSunday = getNextSunday(planStartDate);
  const planDays: string[] = [];
  const cursor = new Date(planStartDate);
  while (cursor <= nextSunday) {
    planDays.push(DAYS[zonedDayOfWeek(cursor)]);
    cursor.setDate(cursor.getDate() + 1);
  }

  const planRange = `${fmtDate(planStartDate)} through ${fmtDate(nextSunday)}`;
  const isMidWeek = planDays.length < 7;

  // Live VDOT estimate — VO2max/engine fitness, HR-adjusted from his hard efforts.
  const goalVDOT = Math.round(raceVDOT(42195, GOAL_MARATHON_SECONDS));
  const benchStr = KNOWN_BENCHMARKS
    .map(b => `${b.label} = VDOT ${Math.round(raceVDOT(b.distanceMeters, b.timeSeconds))}`)
    .join(" · ");
  const vdotEstimate = estimateCurrentVDOT(athleteProfile);

  // The engine (VO2max) is NOT marathon readiness. Even a high VDOT can't run its
  // equivalent marathon without the endurance/volume base — that is the whole build.
  const durabilityNote =
    ` NOTE: this is engine/VO2max fitness, not marathon readiness. He can't run a VDOT-${vdotEstimate?.vdot ?? goalVDOT} ` +
    `marathon on a thin base — the marathon is endurance/durability-limited, built by VOLUME + long runs. ` +
    `When the engine is already past the goal requirement (VDOT ${goalVDOT}), the ONLY gap is aerobic base — do NOT add speed work.`;

  // Training paces, keyed per the coaching rules: easy/long/MGP to the GOAL VDOT
  // (the base is built at goal-level aerobic effort, not at his faster engine level);
  // threshold/interval to the ENGINE VDOT (quality must actually stress his real
  // engine — goal-keyed T-pace would be junk for him). Auto-updates as the estimate
  // rises, so prescribed paces never go stale.
  const goalPaces = trainingPaces(goalVDOT);
  const enginePaces = vdotEstimate ? trainingPaces(vdotEstimate.vdot) : null;
  const pacesLine =
    `TRAINING PACES (auto from lib/vdot.ts — re-key after any new benchmark):\n` +
    `  Easy/long (GOAL ${goalVDOT}): ${fmtPaceMMSS(goalPaces.easyFast)}-${fmtPaceMMSS(goalPaces.easySlow)}/mi — but HR GOVERNS easy days: ${EASY_HR_FLOOR}-${AEROBIC_THRESHOLD_BPM} bpm, talk-test, cap ${AEROBIC_THRESHOLD_BPM}.\n` +
    `  MGP (GOAL ${goalVDOT}): ${fmtPaceMMSS(goalPaces.marathon)}/mi (~155-165 bpm) — fixed, it IS the goal.\n` +
    (enginePaces
      ? `  Threshold (ENGINE ${vdotEstimate!.vdot}): ${fmtPaceMMSS(enginePaces.threshold)}/mi (~88% max ≈ ${Math.round(0.88 * MAX_HR)} bpm) · Interval: ${fmtPaceMMSS(enginePaces.interval)}/mi — ONLY when programmed (Phase 2+, ≤1×/wk).`
      : `  Threshold/interval: no engine estimate — key to ~VDOT 48-50 (T ~6:51-7:04/mi) once programmed (Phase 2+).`);

  let vdotLine: string;
  if (vdotEstimate) {
    const eq = equivalentRaces(vdotEstimate.vdot);
    vdotLine =
      `VDOT — current engine ~${vdotEstimate.vdot} (${vdotEstimate.basis}).\n` +
      `  Equivalent races at ~${vdotEstimate.vdot}: 5K ${eq.k5} · 10K ${eq.k10} · HM ${eq.hm} · M ${eq.m} (race potential IF fully trained).\n` +
      `  Benchmarks: ${benchStr}. Goal (${GOAL_TIME}, ${GOAL_PACE}) = VDOT ${goalVDOT}.\n` +
      `  READ:${durabilityNote}\n` +
      pacesLine;
  } else {
    vdotLine =
      `VDOT — no recent hard effort (≥80% max HR) to estimate the engine. Benchmarks: ${benchStr}. ` +
      `Goal (${GOAL_TIME}, ${GOAL_PACE}) = VDOT ${goalVDOT}.${durabilityNote} Run a 5K TT to pin current fitness.\n` +
      pacesLine;
  }

  // Long run milestone target dates
  const milestonesBlock = buildLongRunMilestones();

  // Full Strava history block
  const profileBlock = buildProfileBlock(athleteProfile);

  // Bot prescription history (what was prescribed vs done)
  let botHistoryBlock = "";
  if (history && history.weeks.length > 0) {
    const rows = history.weeks.map((w) => {
      let row = `  ${w.weekOf}: ${w.runMiles.toFixed(1)}mi | LR ${w.longRunMiles > 0 ? w.longRunMiles.toFixed(1) + "mi" : "none"} | ${w.qualityWorkouts}Q | ${w.liftDays}lifts | adherence ${w.adherenceScore}/100`;
      if (w.avgRunHR) row += ` | HR${w.avgRunHR}`;
      if (w.peakWatts) row += ` | peak${w.peakWatts}W`;
      row += ` — ${w.adherenceNotes}`;
      return row;
    }).join("\n");
    botHistoryBlock = `\nBOT PRESCRIPTION HISTORY (${history.weeks.length} weeks):\n${rows}\n`;
  }

  // Adherence block — interactive coaching tracks prescriptions in COACHING-LOG.md,
  // so `adherence` is normally null; point the coach at the log instead of implying
  // there was no previous plan.
  let adherenceBlock = "ADHERENCE: tracked in COACHING-LOG.md — score last week against the newest entry's prescription.\n";
  if (adherence) {
    adherenceBlock = `ADHERENCE SCORE: ${adherence.score}/100
${adherence.summary}
Hit: ${adherence.hit.join(", ") || "none"}
Missed: ${adherence.missed.join(", ") || "none"}
Modified: ${adherence.modified.join(", ") || "none"}\n`;
  }

  // Training load block — TRIMP-based since the FIT cutover (Jul 2026). Strava-era
  // baseline weeks carry zero TRIMP, so CTL is provisional until ~6 FIT-era weeks
  // accumulate (≈ mid-Aug 2026); mileage change, symptoms, and recovery are read together.
  const sufferDataGap = load.zeroWeeks > 0 || load.ctlWeeks < 4
    ? `\n  DATA NOTE: CTL averages only the ${load.ctlWeeks} week(s) WITH TRIMP data (${load.zeroWeeks} Strava-era week(s) in the window have none). Provisional until ~6 FIT-era weeks accumulate — use mileage, symptoms, recovery, and HR trends as primary.`
    : "";
  const acwrLine = acwr.ratio != null
    ? `  ACWR (workload-change heuristic): ${acwr.ratio} — acute ${acwr.acute}mi this week vs chronic ${acwr.chronic}mi/wk (4-wk avg). ${acwr.status}`
    : `  ACWR (workload-change heuristic): ${acwr.status} (this week ${acwr.acute}mi)`;
  const loadBlock = `TRAINING LOAD (TRIMP — Banister; scale ballpark-comparable to the old suffer score, thresholds provisional):
  CTL (${load.ctlWeeks}wk-with-data avg TRIMP): ${load.ctl} | ATL (this week): ${load.atl} | TSB: ${load.tsb > 0 ? "+" : ""}${load.tsb}
  Status: ${load.status}${sufferDataGap}
${acwrLine}`;

  // Readiness read — drives the adaptive ramp tier (see CLAUDE.md adaptive framework).
  const illnessThisWeek = activities.some(a => a.illnessNote);
  const painThisWeek = injuryFlags.length > 0;
  const hardCross = activities.filter(isHardCrossTraining);
  const hardCrossLine = hardCross.length > 0
    ? `\n  ⚠ HIDDEN HARD CROSS-TRAINING (${hardCross.length}): ${hardCross.map(a => `${a.type} ${a.dayOfWeek} (HR ${a.avgHR ?? "?"}avg/${a.maxHR ?? "?"}max)`).join("; ")} — each counts as a HARD day (likely basketball: cutting/jumping, right-knee risk). True load is HIGHER than mileage shows; never day-of/day-before the long run; it REPLACES a hard slot.`
    : "";
  const recentHR = (athleteProfile?.weeks ?? []).slice(-5).map(w => w.avgRunHR).filter((h): h is number => !!h);
  const hrTrend = recentHR.length >= 2 ? recentHR.join("→") + "bpm" : "n/a";
  const recoveryDays = loadRecovery();
  const recovery = recoveryReadiness(recoveryDays);
  const thinBaseComeback = !acwr.reliable && acwr.chronic < 8 && acwr.acute >= 10;
  let tier: string;
  if (painThisWeek || illnessThisWeek) {
    tier = "RED — back off / deload (pain or illness). Cut lower lifting first.";
  } else if ((acwr.ratio != null && acwr.reliable && acwr.ratio > 1.3) || thinBaseComeback || recovery?.underRecovered) {
    tier = recovery?.underRecovered
      ? "YELLOW — hold (~+0-5%): HRV suppressed AND resting HR elevated (physiological under-recovery, not just soreness)."
      : thinBaseComeback
        ? "YELLOW — hold and rebuild context: current mileage is ≥10mi without an established chronic base."
      : "YELLOW — hold (~+0-5%) and review symptoms/recovery; relative mileage change is elevated.";
  } else {
    tier = "GREEN — clear to PUSH (+10-15%) IF easy-pace HR is steady/dropping. Don't timid-ramp a ready athlete.";
    if (recovery?.anyFlag) tier += " (one recovery flag below — GREEN stands, but note it in the plan.)";
  }
  const detail = recoveryDetail(recoveryDays);
  const vo2Line = vo2maxTrend(recoveryDays);
  // A stalled sheet-sync presents old averages as current — flag data age > 3 days.
  const newestRec = recoveryDays.length > 0 ? recoveryDays[recoveryDays.length - 1].date : null;
  const recAgeDays = newestRec ? Math.floor((Date.now() - Date.parse(newestRec + "T12:00:00Z")) / 86_400_000) : 0;
  const staleLine = newestRec && recAgeDays > 3
    ? `\n  ⚠ RECOVERY DATA STALE: newest row ${newestRec} (${recAgeDays} days old) — re-run the sheet merge before trusting these baselines.`
    : "";
  const recoveryLines = recovery
    ? staleLine + "\n  " + recovery.lines.join("\n  ") +
      (vo2Line ? `\n  ${vo2Line}` : "") +
      (detail.length > 0 ? `\n  Last ${detail.length} days:\n    ${detail.join("\n    ")}` : "")
    : "\n  Recovery data: none yet (data/recovery.csv — see docs/SETUP-HEALTHFIT.md to enable HRV/RHR/sleep).";
  const flagStr = painThisWeek || illnessThisWeek
    ? `${painThisWeek ? "⚠ pain/injury" : ""}${illnessThisWeek ? " ⚠ illness" : ""}`.trim()
    : "none";
  const readinessBlock = `READINESS (sets next week's ramp — see adaptive framework):
  Flags this week: ${flagStr}${hardCrossLine}
  Easy-fitness read: weekly avg run HR ${hrTrend} (dropping at a similar pace = fitness rising = green light to add volume)${recoveryLines}
  Suggested tier: ${tier}
  (Mid-week ACWR is partial — weight the last completed week + flags. Judge with the data above.)`;

  // Activities block
  const seenContextDays = new Set<string>();
  const activitiesBlock = activities.length > 0
    ? activities.map((a) => {
        const dayKey = `${a.dayOfWeek}|${a.date}`;
        const includeDayContext = !seenContextDays.has(dayKey);
        seenContextDays.add(dayKey);
        return fmtActivity(a, includeDayContext);
      }).join("\n\n")
    : "No activities recorded this week.";

  // Injury block
  const injuryBlock = injuryFlags.length > 0
    ? `\nINJURY / PAIN FLAGS (athlete-reported — address first in your report):\n${injuryFlags.map((f) => `  ${f}`).join("\n")}\n`
    : "";

  return `${profileBlock}
${botHistoryBlock}
${vdotLine}
${milestonesBlock ? milestonesBlock + "\n" : ""}
${adherenceBlock}
${loadBlock}

${readinessBlock}

THIS WEEK'S ACTIVITIES (Apple Watch Ultra 2 + Polar H10, via Apple Health/HealthFit):
${activitiesBlock}

WEEKLY SUMMARY: ${runMiles.toFixed(1)} miles run | longest ${longRunMiles > 0 ? longRunMiles.toFixed(1) + "mi" : "none"} | lifts: ${liftDays.join(", ") || "none"}${avgRunHR ? ` | avg run HR ${avgRunHR}bpm` : ""}${thisWeekSuffer > 0 ? ` | total TRIMP ${thisWeekSuffer}` : ""}${indoorLine}
${injuryBlock}
PLAN TO WRITE: ${planRange} (${planDays.join(", ")})${isMidWeek ? `\nNote: plan starts mid-week (${DAYS[zonedDayOfWeek(planStartDate)]}) — manual retry, cover only these days.` : ""}

Write the full coaching report and next-week plan. Address injury flags first if present. Every run day must have exact distance, pace range, HR zone with bpm, and warmup/cooldown breakdown. No vague descriptors.`;
}
