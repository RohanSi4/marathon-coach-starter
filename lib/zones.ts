// ─── Evidence-based HR threshold derivation ───────────────────────────────────
// Re-derives the two physiological anchors that define the zone map from the
// athlete's own stored runs, so HR_ZONE_BOUNDS can be audited against fresh data
// every 4-6 weeks (`npm run zones`) instead of drifting on a one-off estimate:
//
//   • LT1 (aerobic threshold / top of Z2) — from aerobic decoupling (Pa:HR):
//     the highest avg-HR band where long steady runs stay coupled (<5%) vs the
//     lowest band where they decouple (>8%). Physiology: below LT1 the HR-pace
//     relationship holds for an hour-plus; above it, drift appears.
//   • LT2 (lactate threshold / top of Z4) — from best sustained time-weighted HR
//     over long consecutive-split windows. A HR held ~steady for 45-120 min must
//     sit BELOW true LT2, so the best long-window HR is a floor; the classic
//     field LTHR (~30-60 min all-out avg) sits a few bpm above a 2-hour hold.
//
// Interval/strides runs poison both signals (HR spikes wreck decoupling and split
// averages without representing a sustained effort), so runs whose max HR towers
// over their avg are excluded from LT1 evidence (STEADY_MAX_OVER_AVG).
import type { StoredActivity } from "./types";

// H10 chest strap in use since Jun 22 2026 (athlete note that day). Earlier HR is
// wrist-optical: fine for steady averages, distrust single-reading max spikes.
export const H10_SINCE = "2026-06-22";

// A run counts as STEADY (usable for LT1 decoupling evidence) when its max HR
// doesn't tower over its average — surges/strides/intervals show 30+ bpm gaps.
export const STEADY_MAX_OVER_AVG = 25;

export interface DecouplingObs {
  date: string;
  avgHR: number;
  decouplingPct: number;
  miles: number;
  steady: boolean;
}

export interface SustainedWindow {
  windowMiles: number;
  minutes: number;
  avgHR: number;
  date: string;
  fromMile: number;
}

export interface Lt1Estimate {
  lt1: number | null;          // bpm, null when the data can't bracket it
  highestCoupled?: DecouplingObs;  // best "still fine" evidence
  lowestDecoupled?: DecouplingObs; // first "over the line" evidence
  observations: DecouplingObs[];
}

const paceSeconds = (pace: string): number | null => {
  const m = /^(\d+):(\d{2})/.exec(pace);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function decouplingObservations(
  activities: StoredActivity[],
  opts: { sinceIso?: string; minMovingSec?: number } = {}
): DecouplingObs[] {
  const { sinceIso, minMovingSec = 2400 } = opts;
  const out: DecouplingObs[] = [];
  for (const a of activities) {
    if (a.type !== "Run" || a.decouplingPct == null || a.average_heartrate == null) continue;
    if (a.moving_time < minMovingSec) continue;
    if (sinceIso && a.start_date < sinceIso) continue;
    const steady =
      a.max_heartrate == null || a.max_heartrate - a.average_heartrate <= STEADY_MAX_OVER_AVG;
    out.push({
      date: a.start_date.slice(0, 10),
      avgHR: Math.round(a.average_heartrate),
      decouplingPct: a.decouplingPct,
      miles: Math.round((a.distance / 1609.344) * 10) / 10,
      steady,
    });
  }
  return out.sort((x, y) => x.avgHR - y.avgHR);
}

// LT1 = midpoint between the highest steady-run avg HR that stayed coupled (<5%)
// and the lowest steady-run avg HR above it that decoupled (>8%). When nothing
// decoupled yet (all runs disciplined/below), LT1 can only be bounded from below —
// return null and let the caller present the bound honestly.
export function estimateLt1(obs: DecouplingObs[]): Lt1Estimate {
  const steady = obs.filter((o) => o.steady);
  const coupled = steady.filter((o) => o.decouplingPct < 5);
  const highestCoupled = coupled.length
    ? coupled.reduce((a, b) => (b.avgHR > a.avgHR ? b : a))
    : undefined;
  const decoupled = steady.filter(
    (o) => o.decouplingPct > 8 && (!highestCoupled || o.avgHR > highestCoupled.avgHR)
  );
  const lowestDecoupled = decoupled.length
    ? decoupled.reduce((a, b) => (b.avgHR < a.avgHR ? b : a))
    : undefined;
  const lt1 =
    highestCoupled && lowestDecoupled
      ? Math.round((highestCoupled.avgHR + lowestDecoupled.avgHR) / 2)
      : null;
  return { lt1, highestCoupled, lowestDecoupled, observations: steady };
}

// Best time-weighted avg HR over every consecutive-splits window of `windowMiles`,
// across all runs with per-mile HR. The long windows (9+, 13) are the LT2 floor.
export function bestSustained(
  activities: StoredActivity[],
  windowMiles: number
): SustainedWindow | null {
  let best: SustainedWindow | null = null;
  for (const a of activities) {
    if (a.type !== "Run" || !a.splits) continue;
    const sp = a.splits.filter((s) => s.avgHR != null && paceSeconds(s.pace) != null);
    for (let i = 0; i + windowMiles <= sp.length; i++) {
      const seg = sp.slice(i, i + windowMiles);
      const t = seg.reduce((s, x) => s + paceSeconds(x.pace)!, 0);
      const hr = seg.reduce((s, x) => s + paceSeconds(x.pace)! * x.avgHR!, 0) / t;
      if (!best || hr > best.avgHR) {
        best = {
          windowMiles,
          minutes: Math.round(t / 60),
          avgHR: Math.round(hr),
          date: a.start_date.slice(0, 10),
          fromMile: i + 1,
        };
      }
    }
  }
  return best;
}

// Top credible max-HR observations. Wrist-optical spikes (pre-H10) are kept but
// flagged; the caller decides how to present them.
export interface MaxHrObs {
  maxHR: number;
  date: string;
  type: string;
  h10Era: boolean;
}

export function maxHrObservations(activities: StoredActivity[], top = 8): MaxHrObs[] {
  return activities
    .filter((a) => a.max_heartrate != null)
    .map((a) => ({
      maxHR: a.max_heartrate!,
      date: a.start_date.slice(0, 10),
      type: a.type,
      h10Era: a.start_date.slice(0, 10) >= H10_SINCE,
    }))
    .sort((x, y) => y.maxHR - x.maxHR)
    .slice(0, top);
}
