// ─── Intensity distribution + goal-pace specificity ───────────────────────────
// Two questions CLAUDE.md asks the coach to answer every week, neither of which
// anything in the pipeline actually measured:
//
//   1. DISTRIBUTION. The policy is ~75-80% easy / ~15-20% threshold / <5% hard,
//      measured by TIME, not by session count. Every run already stores `hrZones`
//      (seconds per zone, bucketed against MAX_HR at import), so the weekly split
//      is pure summation — it was simply never summed. Judging distribution by
//      counting "quality sessions" is what let June run at 15% easy and July at
//      87-95% easy without either extreme being named.
//
//   2. SPECIFICITY. A marathon is run at ONE pace. Goal-pace exposure is the
//      single thing a plan can be short on while every other number looks healthy
//      — and it is measurable directly from the stored per-mile splits. In July
//      2026 only 6 of 141 splits landed inside the goal band, 3 of them inside the
//      time trial, i.e. essentially zero deliberate MGP work.
//
// Zone → bucket mapping matches the zone semantics in lib/config.ts:
//   Z1 recovery + Z2 aerobic base → EASY
//   Z3 aerobic threshold          → THRESHOLD
//   Z4 + Z5                       → HARD
import type { StoredActivity } from "./types";
import { weekKey, RUN_TYPES } from "./weeks";
import { GOAL_PACE } from "./config";

const MILE_M = 1609.344;

// Policy targets from CLAUDE.md "Easy-run discipline, the grey zone, and
// intensity distribution". Bands, not points — the read is which side he's on.
export const EASY_TARGET = [75, 80] as const;
export const THRESHOLD_TARGET = [15, 20] as const;
export const HARD_TARGET_MAX = 5;

// Half-width of the goal-pace band. ±15s/mi is the tolerance a marathoner is
// expected to hold on race day; anything wider stops being "goal pace" and starts
// counting easy running as specific work.
export const MGP_BAND_SEC = 15;

export function paceSeconds(pace: string): number | null {
  const m = /^(\d+):(\d{2})/.exec(pace);
  if (!m) return null;
  const s = Number(m[1]) * 60 + Number(m[2]);
  return s > 0 ? s : null;
}

const round1 = (n: number): number => parseFloat(n.toFixed(1));
const pct = (part: number, whole: number): number => (whole > 0 ? round1((part / whole) * 100) : 0);

export interface WeekIntensity {
  weekStarting: string;
  easyMin: number;
  thresholdMin: number;
  hardMin: number;
  totalMin: number;
  easyPct: number;
  thresholdPct: number;
  hardPct: number;
}

// Weekly time-in-zone distribution over RUNS ONLY. Lifts and cross-training carry
// HR zones too, but the 80/20 policy is a running-load policy — folding a
// basketball game's Z4 minutes into it would make the ratio meaningless.
export function weeklyIntensity(activities: StoredActivity[]): WeekIntensity[] {
  const byWeek = new Map<string, { easy: number; threshold: number; hard: number }>();
  for (const a of activities) {
    if (!RUN_TYPES.includes(a.type) || !a.hrZones?.length) continue;
    const k = weekKey(new Date(a.start_date));
    const acc = byWeek.get(k) ?? { easy: 0, threshold: 0, hard: 0 };
    for (const z of a.hrZones) {
      if (z.zone <= 2) acc.easy += z.seconds;
      else if (z.zone === 3) acc.threshold += z.seconds;
      else acc.hard += z.seconds;
    }
    byWeek.set(k, acc);
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
    .map(([weekStarting, z]) => {
      const total = z.easy + z.threshold + z.hard;
      return {
        weekStarting,
        easyMin: Math.round(z.easy / 60),
        thresholdMin: Math.round(z.threshold / 60),
        hardMin: Math.round(z.hard / 60),
        totalMin: Math.round(total / 60),
        easyPct: pct(z.easy, total),
        thresholdPct: pct(z.threshold, total),
        hardPct: pct(z.hard, total),
      };
    });
}

// Which side of the policy a week fell on. Under-doing threshold is the failure
// mode a "quality session count" never catches: four easy runs plus one tempo
// reads as 20% quality by session and 5% by time.
function distributionRead(w: WeekIntensity): string {
  if (w.totalMin < 30) return "too little running to read";
  if (w.easyPct > EASY_TARGET[1] + 5 && w.thresholdPct < THRESHOLD_TARGET[0]) {
    return `ALL EASY — threshold ${w.thresholdPct}% vs ${THRESHOLD_TARGET[0]}-${THRESHOLD_TARGET[1]}% target`;
  }
  if (w.easyPct < EASY_TARGET[0] - 10) return `TOO HARD — only ${w.easyPct}% easy`;
  if (w.hardPct > HARD_TARGET_MAX * 2) return `hard ${w.hardPct}% (target <${HARD_TARGET_MAX}%)`;
  return "on policy";
}

export function formatIntensityBlock(activities: StoredActivity[], recent = 8): string {
  const weeks = weeklyIntensity(activities);
  const head =
    "INTENSITY DISTRIBUTION (time-in-zone, RUNS only — the 75-80/15-20/<5 policy, measured):\n" +
    "  Z1-2 = easy · Z3 = threshold · Z4-5 = hard. Percentages are of RUNNING MINUTES, not sessions.";
  if (weeks.length === 0) {
    return head + "\n  No runs with HR zones stored yet.";
  }

  const rows = weeks.slice(-recent).map((w) => {
    const bar = `${String(w.easyPct).padStart(5)}% easy · ${String(w.thresholdPct).padStart(4)}% thr · ${String(w.hardPct).padStart(4)}% hard`;
    return `  ${w.weekStarting.padEnd(14)} ${String(w.totalMin).padStart(4)}min   ${bar}   ${distributionRead(w)}`;
  });

  // Trailing 4-week aggregate — one week is noise, the block's job is the trend.
  const last4 = weeks.slice(-4);
  const sum = last4.reduce(
    (s, w) => ({ e: s.e + w.easyMin, t: s.t + w.thresholdMin, h: s.h + w.hardMin }),
    { e: 0, t: 0, h: 0 },
  );
  const total = sum.e + sum.t + sum.h;
  const read =
    total === 0
      ? "  READ: no running minutes in the last 4 weeks."
      : `  READ (trailing 4wk): ${pct(sum.e, total)}% easy / ${pct(sum.t, total)}% threshold / ${pct(sum.h, total)}% hard. ` +
        (pct(sum.t, total) < THRESHOLD_TARGET[0]
          ? `Threshold is UNDER target — the gap is ${Math.round((THRESHOLD_TARGET[0] / 100) * total - sum.t)}min/4wk, about ${Math.round(((THRESHOLD_TARGET[0] / 100) * total - sum.t) / 4)}min per week of tempo.`
          : pct(sum.e, total) < EASY_TARGET[0]
            ? "Easy is UNDER target — the aerobic base is being shortchanged for intensity."
            : "On policy.");

  return `${head}\n${rows.join("\n")}\n${read}`;
}

// ─── Goal-pace specificity ────────────────────────────────────────────────────

export interface SpecificityWeek {
  weekStarting: string;
  mgpMiles: number;      // splits inside the goal band
  totalMiles: number;    // splits with a readable pace
  fasterMiles: number;   // faster than the band (quality work, not MGP work)
}

// Per-mile splits inside GOAL_PACE ± MGP_BAND_SEC, by week. Counted in SPLITS,
// which is the honest unit: a 10mi long run with 2 miles at goal pace contributes
// 2, not 10, and not 1 "workout".
export function specificityWeeks(activities: StoredActivity[]): SpecificityWeek[] {
  const goal = paceSeconds(GOAL_PACE);
  if (goal == null) return [];
  const byWeek = new Map<string, SpecificityWeek>();

  for (const a of activities) {
    if (!RUN_TYPES.includes(a.type) || !a.splits?.length) continue;
    const k = weekKey(new Date(a.start_date));
    const row = byWeek.get(k) ?? { weekStarting: k, mgpMiles: 0, totalMiles: 0, fasterMiles: 0 };
    for (const s of a.splits) {
      const ps = paceSeconds(s.pace);
      if (ps == null) continue;
      row.totalMiles++;
      if (Math.abs(ps - goal) <= MGP_BAND_SEC) row.mgpMiles++;
      else if (ps < goal - MGP_BAND_SEC) row.fasterMiles++;
    }
    byWeek.set(k, row);
  }

  return [...byWeek.values()].sort(
    (a, b) => new Date(a.weekStarting).getTime() - new Date(b.weekStarting).getTime(),
  );
}

export function formatSpecificityBlock(activities: StoredActivity[], recent = 8): string {
  const goal = paceSeconds(GOAL_PACE);
  const weeks = specificityWeeks(activities);
  const lo = goal != null ? fmt(goal - MGP_BAND_SEC) : "?";
  const hi = goal != null ? fmt(goal + MGP_BAND_SEC) : "?";
  const head =
    `GOAL-PACE SPECIFICITY (miles inside ${lo}-${hi}, i.e. ${GOAL_PACE} ±${MGP_BAND_SEC}s):\n` +
    "  A marathon is run at ONE pace. This is the number a plan can be short on while\n" +
    "  mileage, ACWR, and durability all look healthy. Counted in MILE SPLITS, not sessions.";
  if (weeks.length === 0) return head + "\n  No runs with per-mile splits stored yet.";

  const rows = weeks.slice(-recent).map((w) => {
    const share = w.totalMiles > 0 ? pct(w.mgpMiles, w.totalMiles) : 0;
    const flag = w.mgpMiles === 0 ? "  ← ZERO goal-pace miles" : "";
    return `  ${w.weekStarting.padEnd(14)} ${String(w.mgpMiles).padStart(3)} of ${String(w.totalMiles).padStart(3)} miles at MGP (${String(share).padStart(5)}%) · ${w.fasterMiles} faster${flag}`;
  });

  const last4 = weeks.slice(-4);
  const mgp = last4.reduce((s, w) => s + w.mgpMiles, 0);
  const tot = last4.reduce((s, w) => s + w.totalMiles, 0);
  const read =
    `  READ (trailing 4wk): ${mgp} of ${tot} miles at goal pace. ` +
    (mgp <= 3
      ? "Effectively NO deliberate goal-pace work. Race pace has to become a rehearsed feel, not a number first met on race day."
      : "Goal-pace exposure is accumulating — keep it inside long runs, not as standalone sessions.");

  return `${head}\n${rows.join("\n")}\n${read}`;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
