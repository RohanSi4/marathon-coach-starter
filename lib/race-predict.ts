// ─── Ensemble marathon predictor + Marathon Shape ────────────────────────────
// The single most on-thesis feature: blend several models, weight to the athlete's
// own data, and express the result as a RANGE that narrows as the build progresses —
// never one bold number. It operationalizes the whole coaching story: the engine
// predicts ~3:1x he can't yet run; the gap is endurance; the honest "today" estimate
// climbs toward the engine ceiling as volume and long runs accumulate.
//
// Models (each transparent, the LLM reconciles them):
//  • VDOT-equivalent — the engine ceiling (what he could run FULLY trained). Optimistic
//    by design; ignores endurance (Daniels equivalent-performance).
//  • Riegel — t2 = t1·(d2/d1)^1.06 from a race benchmark. Known to UNDER-predict the
//    marathon for recreational runners (calibrated on elites); kept as one input.
//  • Cameron — distance-decayed fatigue factor; more accurate than Riegel for the
//    HM→M extrapolation.
//  • Tanda — predicts the marathon from TRAINING (mean weekly km + mean training pace),
//    not a race. On-thesis for a volume-limited runner: more volume → faster prediction.
//  • Marathon Shape (Runalyze-style) — endurance readiness 0-100% from weekly volume +
//    long-run distance, used to DISCOUNT the engine ceiling toward reality.
import { predictRaceSeconds, raceVDOT } from "./vdot";

const MILE_M = 1609.344;
const HM_M = 21097.5;
const M_M = 42195;

export interface RacePredictInput {
  engineVDOT: number;
  // Best race-like benchmark for Riegel/Cameron (e.g. the Apr 26 solo HM).
  benchmark?: { distanceMeters: number; timeSeconds: number; label: string; submaximal?: boolean };
  recentWeeklyKm: number;      // mean of the last ~4 weeks
  longestRecentKm: number;     // longest single run, last ~4 weeks
  meanTrainingPaceSecPerKm: number; // mean pace across recent runs
  goalSeconds: number;
}

// Coach-set "fully marathon-ready" targets (consistent with our low-50s-mpw peak plan
// and a 20mi long run). Marathon Shape = how close he is to these.
const REQUIRED_WEEKLY_KM = 70;   // ~43 mpw
const REQUIRED_LONGRUN_KM = 32;  // ~20 mi
// A marathon run with the engine but ZERO endurance base runs ~this much slower than
// the engine-equivalent time. Anchors the shape discount (shape 0 → +35%, shape 1 → 0).
const MAX_ENDURANCE_PENALTY = 0.35;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Cameron's distance factor (x in miles).
function cameronF(xMiles: number): number {
  return 13.49681 - 0.048865 * xMiles + 2.438936 / Math.pow(xMiles, 0.7905);
}

function riegel(d1m: number, t1s: number, d2m: number): number {
  return t1s * Math.pow(d2m / d1m, 1.06);
}
function cameron(d1m: number, t1s: number, d2m: number): number {
  const d1mi = d1m / MILE_M, d2mi = d2m / MILE_M;
  return (t1s / d1mi) * (cameronF(d1mi) / cameronF(d2mi)) * d2mi;
}

// Tanda (2011): marathon pace (s/km) from mean weekly km + mean training pace (s/km).
export function tandaMarathonSeconds(weeklyKm: number, trainPaceSecPerKm: number): number {
  const pace = 17.1 + 140.0 * Math.exp(-0.0053 * weeklyKm) + 0.55 * trainPaceSecPerKm;
  return pace * 42.195;
}

export function marathonShape(weeklyKm: number, longestKm: number): number {
  return clamp01(
    0.67 * (weeklyKm / REQUIRED_WEEKLY_KM) + 0.33 * (longestKm / REQUIRED_LONGRUN_KM)
  );
}

export interface RacePrediction {
  goalSeconds: number;
  models: { name: string; seconds: number; note: string }[];
  engineCeilingSeconds: number; // fastest credible if fully built
  shapePct: number;             // 0-100 endurance readiness
  shapeAdjustedSeconds: number; // engine ceiling discounted by shape
  currentCenterSeconds: number; // best "on today's fitness" estimate
  rangeLowSeconds: number;
  rangeHighSeconds: number;
  confidence: "wide" | "narrowing" | "tight";
}

export function predictMarathon(input: RacePredictInput): RacePrediction {
  const models: { name: string; seconds: number; note: string }[] = [];

  const vdotEquiv = predictRaceSeconds(input.engineVDOT, M_M);
  models.push({ name: "VDOT-equivalent", seconds: vdotEquiv, note: "engine ceiling — ignores endurance" });

  if (input.benchmark) {
    const { distanceMeters: d1, timeSeconds: t1, label, submaximal } = input.benchmark;
    // A submaximal performance is slower than the athlete's race capability, so a
    // direct extrapolation is conservative/pessimistic—not optimistic.
    const note = submaximal ? `from ${label} (conservative extrapolation)` : `from ${label}`;
    models.push({ name: "Riegel", seconds: riegel(d1, t1, M_M), note: `${note}; under-predicts M` });
    models.push({ name: "Cameron", seconds: cameron(d1, t1, M_M), note });
  }

  const tanda = tandaMarathonSeconds(input.recentWeeklyKm, input.meanTrainingPaceSecPerKm);
  models.push({ name: "Tanda", seconds: tanda, note: `training-based (${Math.round(input.recentWeeklyKm)}km/wk)` });

  const shape = marathonShape(input.recentWeeklyKm, input.longestRecentKm);
  const shapeAdjusted = vdotEquiv * (1 + MAX_ENDURANCE_PENALTY * (1 - shape));

  // "On today's fitness" = a SHAPE-WEIGHTED blend: when he's unbuilt, trust the
  // training-based Tanda (realistically slow); as endurance builds, trust the
  // engine-anchored shape-adjusted estimate. So the center improves as volume climbs
  // — the whole point — instead of averaging two models that diverge.
  const center = (1 - shape) * tanda + shape * shapeAdjusted;
  // Spread is driven by how UNBUILT he still is (shrinks as the base fills) plus a
  // floor for irreducible race-day variance — a real benchmark tightens the floor.
  const benchFloor = input.benchmark && !input.benchmark.submaximal ? 120 : 180;
  const spread = (1 - shape) * 900 + benchFloor;

  const confidence: RacePrediction["confidence"] =
    spread < 300 ? "tight" : spread < 600 ? "narrowing" : "wide";

  return {
    goalSeconds: input.goalSeconds,
    models: models.map((m) => ({ ...m, seconds: Math.round(m.seconds) })),
    engineCeilingSeconds: Math.round(Math.min(vdotEquiv, ...(input.benchmark ? [cameron(input.benchmark.distanceMeters, input.benchmark.timeSeconds, M_M)] : []))),
    shapePct: Math.round(shape * 100),
    shapeAdjustedSeconds: Math.round(shapeAdjusted),
    currentCenterSeconds: Math.round(center),
    rangeLowSeconds: Math.round(center - spread),
    rangeHighSeconds: Math.round(center + spread),
    confidence,
  };
}

export function fmtHMS(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

export function formatRaceBlock(input: RacePredictInput): string {
  const p = predictMarathon(input);
  const goal = fmtHMS(p.goalSeconds);
  const lines: string[] = [
    "MARATHON PLANNING SCENARIO (heuristic ensemble — not a calibrated probability forecast):",
    `  Current scenario: ${fmtHMS(p.rangeLowSeconds)}–${fmtHMS(p.rangeHighSeconds)}, center ${fmtHMS(p.currentCenterSeconds)} (uncertainty: ${p.confidence})`,
    `  Marathon Shape heuristic: ${p.shapePct}% (volume + long run) — useful for trend direction, not a readiness probability`,
    `  Engine-equivalent time if fully built: ~${fmtHMS(p.engineCeilingSeconds)} (VDOT ${input.engineVDOT}) — physiological potential, not a guaranteed ceiling`,
    `  Models: ${p.models.map((m) => `${m.name} ${fmtHMS(m.seconds)} [${m.note}]`).join(" · ")}`,
  ];
  const goalGapMin = Math.round((p.currentCenterSeconds - p.goalSeconds) / 60);
  lines.push(
    goalGapMin <= 0
      ? `  vs GOAL ${goal}: the heuristic center is at/under goal — protect the build and confirm with long runs plus a race benchmark.`
      : `  vs GOAL ${goal}: heuristic center is ~${goalGapMin} min slower; volume/long-run durability is the main modeled lever.`
  );
  return lines.join("\n");
}
