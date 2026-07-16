// ─── Durability: late-run aerobic decoupling (the marathon's true limiter) ────
// Durability — the magnitude/onset of physiological drift over a prolonged run —
// is now argued to be a fourth determinant of endurance performance alongside
// VO₂max, threshold, and economy (Maunder & Seiler 2021, Sports Medicine;
// recreational-runner confirmation Kuang 2025). It's precisely THIS athlete's gap:
// his fresh engine predicts ~3:07, but the engine fades over 26 miles and his is
// untested. This module measures the fade.
//
// We extend the whole-run Pa:HR decoupling (lib/fit/compute.ts) to THIRDS, computed
// from the stored per-mile splits (no raw stream needed — splits carry per-mile HR
// + pace). EF (efficiency factor) = speed / HR per mile; decoupling compares the
// LAST third to the FIRST third: positive = faded (durability limit), negative =
// negative-split (strong). When 90-min+ runs hold late decoupling <5%, the aerobic
// base is genuinely built — a far stronger readiness signal than mileage alone, and
// the objective evidence for the Sep 21 goal decision.
//
// SIGN + EF conventions match computeDecoupling() exactly so the two read the same.
import type { StoredActivity, MileSplit } from "./types";
import { noteDateKey } from "./notes";
import { RUN_TYPES } from "./weeks";

const MILE_M = 1609.344;

// Runs shorter than this can't form three meaningful thirds; also below the ~75-min
// prolonged-exercise threshold where durability is the relevant question.
export const MIN_SPLITS_FOR_DURABILITY = 6;
export const DEFAULT_MIN_MILES = 6;

const paceSeconds = (pace: string): number | null => {
  const m = /^(\d+):(\d{2})/.exec(pace);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// EF proxy = speed / HR (speed in m/min so the number is human-legible). Absolute
// scale is arbitrary — only the first-vs-last RATIO drives decoupling.
const efOfSplit = (s: MileSplit): number | null => {
  const ps = paceSeconds(s.pace);
  if (ps == null || ps <= 0 || s.avgHR == null || s.avgHR <= 0) return null;
  const speedMPerMin = MILE_M / (ps / 60);
  return speedMPerMin / s.avgHR;
};

const round1 = (n: number): number => parseFloat(n.toFixed(1));

export interface DurabilityRead {
  decouplingPct: number;          // last-third EF vs first-third EF; + = faded
  thirdsEF: [number, number, number];
  milesUsed: number;              // splits with usable pace+HR
}

// Per-third durability from a run's per-mile splits. null when too few usable miles.
export function runDurability(splits: MileSplit[] | undefined): DurabilityRead | null {
  if (!splits) return null;
  const ef: number[] = [];
  for (const s of splits) {
    const e = efOfSplit(s);
    if (e != null) ef.push(e);
  }
  const n = ef.length;
  if (n < MIN_SPLITS_FOR_DURABILITY) return null;

  // Balanced endpoints: first/last thirds get equal size, remainder goes to the
  // middle (which doesn't affect the first-vs-last decoupling ratio).
  const cut1 = Math.floor(n / 3);
  const cut2 = Math.ceil((2 * n) / 3);
  const mean = (arr: number[]): number => arr.reduce((s, x) => s + x, 0) / arr.length;
  const t1 = mean(ef.slice(0, cut1));
  const t2 = mean(ef.slice(cut1, cut2));
  const t3 = mean(ef.slice(cut2));
  if (t1 <= 0) return null;

  return {
    decouplingPct: round1(((t1 - t3) / t1) * 100),
    thirdsEF: [round1(t1), round1(t2), round1(t3)],
    milesUsed: n,
  };
}

export interface DurabilityLedgerEntry {
  date: string;
  miles: number;
  decouplingPct: number;
  thirdsEF: [number, number, number];
  tempC?: number;
  treadmill: boolean;
}

// Chronological durability ledger over all qualifying long runs (activities are
// already sorted ascending by loadActivities).
export function durabilityLedger(
  activities: StoredActivity[],
  minMiles: number = DEFAULT_MIN_MILES
): DurabilityLedgerEntry[] {
  const out: DurabilityLedgerEntry[] = [];
  for (const a of activities) {
    if (!RUN_TYPES.includes(a.type) || !a.splits) continue;
    const miles = a.distance / MILE_M;
    if (miles < minMiles) continue;
    const d = runDurability(a.splits);
    if (!d) continue;
    out.push({
      date: noteDateKey(new Date(a.start_date)),
      miles: round1(miles),
      decouplingPct: d.decouplingPct,
      thirdsEF: d.thirdsEF,
      tempC: a.average_temp,
      treadmill: !!a.trainer,
    });
  }
  return out;
}

const band = (pct: number): string =>
  pct < 5 ? "COUPLED — base holding" : pct <= 10 ? "building" : "faded (too fast/hot/long)";

// The printed block for coach-data. `recent` caps how many long runs to show.
export function formatDurabilityBlock(activities: StoredActivity[], recent = 8): string {
  const ledger = durabilityLedger(activities);
  if (ledger.length === 0) {
    return "DURABILITY (late-run decoupling — the marathon-readiness marker):\n" +
      "  No qualifying long runs yet (need ≥6mi with per-mile HR). Builds as the long run grows.";
  }
  const rows = ledger.slice(-recent).map((e) => {
    const heat = e.tempC != null && e.tempC >= 24 ? ` · ${Math.round(e.tempC)}°C (heat inflates drift)` : "";
    const tm = e.treadmill ? " (tm)" : "";
    const sign = e.decouplingPct >= 0 ? "+" : "";
    return `  ${e.date}${tm}  ${e.miles}mi  late-third ${sign}${e.decouplingPct}%  ` +
      `[thirds EF ${e.thirdsEF.join(" → ")}]  ${band(e.decouplingPct)}${heat}`;
  });
  const last = ledger[ledger.length - 1];
  const trend =
    ledger.length >= 2
      ? (() => {
          const prev = ledger[ledger.length - 2];
          const delta = last.decouplingPct - prev.decouplingPct;
          const dir = Math.abs(delta) < 0.1 ? "level with" : delta < 0 ? "improved from" : "up from";
          const sign = last.decouplingPct >= 0 ? "+" : "";
          const prevSign = prev.decouplingPct >= 0 ? "+" : "";
          return `  READ: latest ${last.miles}mi held ${sign}${last.decouplingPct}% over its last third ` +
            `(${dir} ${prevSign}${prev.decouplingPct}% prior). ` +
            "When 90-min+ runs stay <5%, the aerobic base is genuinely built (the Sep 21 goal-decision evidence).";
        })()
      : "  READ: one data point so far — trend it as the long run grows.";
  return (
    "DURABILITY (late-run decoupling per-third — the marathon-readiness marker to watch):\n" +
    rows.join("\n") +
    "\n" +
    trend
  );
}
