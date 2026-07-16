// ─── Training-load lenses: Foster Monotony/Strain + Banister PMC (CTL/ATL/TSB) ─
// Two daily-load analyses that ACWR can't give us, both from the TRIMP we already
// compute per activity:
//
//  • Monotony & Strain (Foster 1998) — Monotony = weekly mean daily load ÷ its SD;
//    Strain = weekly load × monotony. High monotony (every day the same grey load)
//    plus volume can flag an overly repetitive load pattern. This is
//    the numeric form of our grey-zone thesis: low day-to-day variance = the easy
//    days crept up = hard-easy separation collapsing. INCLUDING rest days as zeros
//    is essential — they're what create the variance that protects.
//
//  • PMC: CTL/ATL/TSB (Banister impulse-response) — Fitness (42-day EWMA of load),
//    Fatigue (7-day EWMA), Form/TSB = CTL−ATL. The taper's control panel. PROVISIONAL
//    until ~6 FIT-era weeks of TRIMP accumulate (≈ mid-Aug 2026, per CLAUDE.md) — the
//    Strava-era archive has no TRIMP, so the series only really begins late Jun 2026.
//
// ACWR is a mileage-change lens, not a calibrated injury predictor; these are
// complementary load-distribution and fitness-fatigue lenses.
import type { StoredActivity } from "./types";
import { coachTZ } from "./config";

export interface DailyLoad {
  date: string; // YYYY-MM-DD in the coaching TZ
  trimp: number;
}

// YYYY-MM-DD for an instant in the coaching TZ (so late-night runs bucket to the
// day they were actually run, matching the weekly logic).
function zonedDateStr(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: coachTZ(d), year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Continuous daily TRIMP series from first activity to `through` (default: newest),
// with zero-filled rest days — the zeros are load-bearing for both metrics.
export function dailyLoadSeries(activities: StoredActivity[], through?: string): DailyLoad[] {
  const byDay = new Map<string, number>();
  for (const a of activities) {
    if (!a.trimp) continue;
    const day = zonedDateStr(a.start_date);
    byDay.set(day, (byDay.get(day) ?? 0) + a.trimp);
  }
  if (byDay.size === 0) return [];
  const days = [...byDay.keys()].sort();
  const start = days[0];
  const end = through ?? days[days.length - 1];
  const out: DailyLoad[] = [];
  for (let d = new Date(start + "T12:00:00Z"); d <= new Date(end + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, trimp: byDay.get(key) ?? 0 });
  }
  return out;
}

export interface MonotonyStrain {
  weekStart: string;
  dailyLoads: number[]; // 7 values incl. zero rest days
  totalLoad: number;
  monotony: number;     // mean ÷ SD (population SD); higher = more monotonous
  strain: number;       // totalLoad × monotony
  status: string;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const popSD = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

// Monotony & Strain for the trailing 7 days ending at the series' last day.
export function monotonyStrain(series: DailyLoad[]): MonotonyStrain | null {
  if (series.length < 7) return null;
  const week = series.slice(-7);
  const loads = week.map((d) => d.trimp);
  const total = loads.reduce((s, x) => s + x, 0);
  if (total === 0) return null;
  const sd = popSD(loads);
  // All-equal loads → SD 0 → infinite monotony; cap for display sanity.
  const monotony = sd > 0 ? mean(loads) / sd : 99;
  const strain = total * monotony;
  const status =
    monotony >= 2.0
      ? "HIGH monotony (≥2.0 — days too similar; make easy days easier / hard days harder)"
      : monotony >= 1.5
        ? "moderate monotony (1.5-2.0 — watch the hard-easy separation)"
        : "healthy variance (<1.5 — good hard-easy separation)";
  return {
    weekStart: week[0].date,
    dailyLoads: loads.map((x) => Math.round(x)),
    totalLoad: Math.round(total),
    monotony: parseFloat(monotony.toFixed(2)),
    strain: Math.round(strain),
    status,
  };
}

export interface PMC {
  ctl: number; // fitness (42-day EWMA)
  atl: number; // fatigue (7-day EWMA)
  tsb: number; // form = CTL(yesterday) − ATL(yesterday)
  daysOfData: number;
  provisional: boolean;
}

// EWMA seeded at 0 — the standard PMC convention: fitness/fatigue start from an
// untrained baseline and BUILD, so CTL (slow) trails ATL (fast) during a ramp and
// a constant load doesn't read as instantly-saturated. today = yest + (x−yest)·α.
function ewma(series: number[], days: number): number[] {
  const alpha = 2 / (days + 1);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < series.length; i++) {
    prev = prev + (series[i] - prev) * alpha;
    out.push(prev);
  }
  return out;
}

// PMC as of the last day of the series. TSB (form) uses YESTERDAY's fitness/fatigue —
// the standard PMC convention (today's freshness reflects yesterday's balance).
export function computePMC(series: DailyLoad[]): PMC | null {
  if (series.length < 7) return null;
  const loads = series.map((d) => d.trimp);
  const ctlSeries = ewma(loads, 42);
  const atlSeries = ewma(loads, 7);
  const n = series.length;
  const ctl = ctlSeries[n - 1];
  const atl = atlSeries[n - 1];
  const tsb = ctlSeries[n - 2] - atlSeries[n - 2];
  return {
    ctl: parseFloat(ctl.toFixed(1)),
    atl: parseFloat(atl.toFixed(1)),
    tsb: parseFloat(tsb.toFixed(1)),
    daysOfData: n,
    provisional: n < 42, // <6 weeks → CTL hasn't saturated; treat as directional
  };
}

export function formatLoadBlock(activities: StoredActivity[]): string {
  const series = dailyLoadSeries(activities);
  const ms = monotonyStrain(series);
  const pmc = computePMC(series);
  if (!ms && !pmc) {
    return "LOAD DISTRIBUTION (Foster monotony/strain + PMC): no TRIMP series yet (FIT-era only).";
  }
  const lines: string[] = ["LOAD DISTRIBUTION — complements the mileage-change read; these show hard-easy separation + fitness/fatigue:"];
  if (ms) {
    lines.push(
      `  Monotony ${ms.monotony} · Strain ${ms.strain} (7d load ${ms.totalLoad}, daily [${ms.dailyLoads.join(", ")}]) — ${ms.status}`
    );
  }
  if (pmc) {
    const formRead =
      pmc.tsb > 5 ? "fresh" : pmc.tsb < -20 ? "deep fatigue" : pmc.tsb < -10 ? "loaded (building)" : "neutral";
    lines.push(
      `  PMC: CTL ${pmc.ctl} (fitness) · ATL ${pmc.atl} (fatigue) · TSB ${pmc.tsb} (form — ${formRead})` +
        (pmc.provisional ? ` · PROVISIONAL (${pmc.daysOfData}d of TRIMP; CTL saturates ~mid-Aug — directional only)` : "")
    );
  }
  return lines.join("\n");
}
