// ─── VDOT (Jack Daniels' Running Formula) ─────────────────────────────────────
// Proper implementation of Daniels' VO2/VDOT model. Replaces the old inflated
// pace→VDOT lookup table, which read ~9 points high (it scored a hard 6-mile run
// at 8:03/mi as VDOT ~51; the real value for that effort is ~41).
//
// Validated against known anchors:
//   5K  20:00  → VDOT ~50   (the canonical "sub-20 5K = VDOT 50")
//   HM  1:59   → VDOT ~37
//   M   3:45   → VDOT ~41
//
// VDOT is a RACE-PREDICTIVE aerobic fitness number. It assumes you have the
// endurance to hold the pace for the distance — so a genuine estimate needs a
// race, a time trial, or a long sustained threshold effort, NOT a short surge.

const MILE_M = 1609.344;

// Daniels' oxygen cost of running at velocity v (metres/minute), mL/kg/min.
export function vo2ForVelocity(vMetresPerMin: number): number {
  return -4.60 + 0.182258 * vMetresPerMin + 0.000104 * vMetresPerMin * vMetresPerMin;
}

// Fraction of VO2max sustainable for a race lasting t minutes (Daniels' drop-dead
// curve). ~1.0 for very short efforts, falling toward ~0.8 for marathon-length.
export function fractionForDuration(tMinutes: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * tMinutes) +
    0.2989558 * Math.exp(-0.1932605 * tMinutes)
  );
}

// Invert vo2ForVelocity: velocity (m/min) that costs a given VO2.
export function velocityForVo2(vo2: number): number {
  const a = 0.000104;
  const b = 0.182258;
  const c = -(4.60 + vo2);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

export function paceSecPerMileFromVelocity(vMetresPerMin: number): number {
  // metres/min → sec/mile
  return (MILE_M / vMetresPerMin) * 60;
}

export function velocityFromPaceSecPerMile(paceSecPerMile: number): number {
  return (MILE_M / paceSecPerMile) * 60;
}

// VDOT from a MAX race/time-trial performance (distance in metres, time in sec).
export function raceVDOT(distanceMeters: number, timeSeconds: number): number {
  const tMin = timeSeconds / 60;
  const v = distanceMeters / tMin;
  return vo2ForVelocity(v) / fractionForDuration(tMin);
}

const THRESHOLD_FRACTION = 0.88;

// Swain (1994) regression: %HRmax → %VO2max. Inputs/outputs are fractions (0..1).
// e.g. 0.84 HRmax ≈ 0.72 VO2max. Reliable in the 70-100% HRmax band; noisy below.
export function pctVo2maxFromPctHRmax(pctHRmax: number): number {
  return (1.5472 * (pctHRmax * 100) - 57.53) / 100;
}

// VDOT estimate from a SUB-MAXIMAL steady run, using HR relative to max to gauge how
// hard it actually was. This is the honest method for an athlete who deliberately
// holds back: his HR (not an assumed threshold intensity) sets the effort level, so
// VO2max ≈ VO2(pace) / %VO2max(HR). A run at 8:03/mi & HR 163 (84% of a 195 max) reads
// ~50, not ~41 — because 84% max is cruising, not a threshold effort. Only trust it in
// the ≥~80% HRmax band; a real race/TT still beats it.
export function vdotFromHRPace(paceSecPerMile: number, avgHR: number, maxHR: number): number {
  const v = velocityFromPaceSecPerMile(paceSecPerMile);
  return vo2ForVelocity(v) / pctVo2maxFromPctHRmax(avgHR / maxHR);
}

// Invert raceVDOT: predicted race time (sec) for a VDOT at a distance.
export function predictRaceSeconds(vdot: number, distanceMeters: number): number {
  // Monotonic in time → binary search. Bounds: 1 min … 8 h.
  let lo = 60;
  let hi = 8 * 3600;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (raceVDOT(distanceMeters, mid) > vdot) lo = mid; // faster time = higher VDOT
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function fmtPaceMMSS(secPerMile: number): string {
  const t = Math.round(secPerMile); // round first so seconds never land on 60
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtClock(totalSec: number): string {
  const t = Math.round(totalSec); // round first so seconds never land on 60
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

// Daniels training paces (sec/mile) for a VDOT. Easy is a range (62–72% VO2max);
// M/T/I are point paces the coach turns into ranges.
export interface TrainingPaces {
  easySlow: number;
  easyFast: number;
  marathon: number;
  threshold: number;
  interval: number;
}

export function trainingPaces(vdot: number): TrainingPaces {
  return {
    easySlow: paceSecPerMileFromVelocity(velocityForVo2(0.62 * vdot)),
    easyFast: paceSecPerMileFromVelocity(velocityForVo2(0.72 * vdot)),
    marathon: predictRaceSeconds(vdot, 42195) / (42195 / MILE_M),
    threshold: paceSecPerMileFromVelocity(velocityForVo2(THRESHOLD_FRACTION * vdot)),
    interval: paceSecPerMileFromVelocity(velocityForVo2(vdot)),
  };
}

// Equivalent race times (formatted) for a VDOT — for sanity-checking a number.
export function equivalentRaces(vdot: number): { k5: string; k10: string; hm: string; m: string } {
  return {
    k5: fmtClock(predictRaceSeconds(vdot, 5000)),
    k10: fmtClock(predictRaceSeconds(vdot, 10000)),
    hm: fmtClock(predictRaceSeconds(vdot, 21097.5)),
    m: fmtClock(predictRaceSeconds(vdot, 42195)),
  };
}
