// ─── HRV rolling baseline band (Plews/Altini method) ─────────────────────────
// The right way to read the daily HRV we already collect: not raw bpm, but the
// 7-day rolling mean of ln(HRV) judged against a personal normal band derived from
// the trailing ~60 days. Coach off DEVIATION from his own baseline. Evidence:
// HRV-guided runners improved MORE with FEWER hard sessions (Vesterinen 2016 RCT;
// Manresa-Rocamora 2021 meta) — because the band tells you when a hard day will
// actually be absorbed. Gates INTENSITY (swap the tempo for easy), never volume.
//
// Log-transform first (HRV is log-normally distributed); band = baseline mean ±
// 0.5×SD of ln(HRV) (the smallest-worthwhile-change convention). A rolling mean
// BELOW the band = suppressed/accumulating fatigue → ease the next quality session;
// ABOVE = a positive recovery signal, but never permission to add unscheduled
// intensity. A WIDENING day-to-day spread flags
// fatigue even when the mean holds, so we surface the raw CV too.
import type { RecoveryDay } from "./recovery";

export interface HrvBand {
  latest: number;         // newest daily HRV (ms)
  rolling7: number;       // 7-day rolling mean, back-transformed to ms
  baselineMs: number;     // baseline mean (ms) over the window
  lowerMs: number;        // band floor (ms)
  upperMs: number;        // band ceiling (ms)
  cvPct: number;          // coefficient of variation of daily HRV (%) — spread
  status: "balanced" | "suppressed" | "primed" | "collecting";
  daysUsed: number;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

export const HRV_BAND_MIN_DAYS = 14;   // below this, baseline is meaningless
const BASELINE_WINDOW = 60;
const ROLLING = 7;
const SWC = 0.5; // ×SD of ln(HRV) = smallest worthwhile change

export function hrvBand(days: RecoveryDay[]): HrvBand | null {
  const withHrv = days.filter((d) => d.hrv != null && d.hrv! > 0);
  if (withHrv.length < HRV_BAND_MIN_DAYS) {
    return withHrv.length > 0
      ? {
          latest: withHrv[withHrv.length - 1].hrv!,
          rolling7: NaN, baselineMs: NaN, lowerMs: NaN, upperMs: NaN, cvPct: NaN,
          status: "collecting", daysUsed: withHrv.length,
        }
      : null;
  }
  const window = withHrv.slice(-BASELINE_WINDOW);
  const ln = window.map((d) => Math.log(d.hrv!));
  const baseMeanLn = mean(ln);
  const sdLn = sd(ln);
  const lowerLn = baseMeanLn - SWC * sdLn;
  const upperLn = baseMeanLn + SWC * sdLn;

  const rollingWindow = withHrv.slice(-ROLLING).map((d) => Math.log(d.hrv!));
  const rollingLn = mean(rollingWindow);

  const rawWindow = window.map((d) => d.hrv!);
  const cvPct = (sd(rawWindow) / mean(rawWindow)) * 100;

  const status: HrvBand["status"] =
    rollingLn < lowerLn ? "suppressed" : rollingLn > upperLn ? "primed" : "balanced";

  return {
    latest: withHrv[withHrv.length - 1].hrv!,
    rolling7: Math.round(Math.exp(rollingLn)),
    baselineMs: Math.round(Math.exp(baseMeanLn)),
    lowerMs: Math.round(Math.exp(lowerLn)),
    upperMs: Math.round(Math.exp(upperLn)),
    cvPct: parseFloat(cvPct.toFixed(1)),
    status,
    daysUsed: window.length,
  };
}

export function formatHrvBand(days: RecoveryDay[]): string {
  const b = hrvBand(days);
  if (!b) return "HRV BAND: no HRV data yet.";
  if (b.status === "collecting") {
    return `HRV BAND: collecting baseline (${b.daysUsed}/${HRV_BAND_MIN_DAYS} days) — latest ${b.latest}ms. Read literally until the band forms.`;
  }
  const read =
    b.status === "suppressed"
      ? "BELOW band — ease the next quality session to easy; re-check tomorrow (gates intensity, not volume)"
      : b.status === "primed"
        ? "ABOVE band — positive recovery signal; proceed with the scheduled plan if other signals agree (does not add intensity)"
        : "within band — proceed as planned";
  return (
    "HRV BAND (7-day rolling vs personal baseline — may downgrade a hard day; never upgrades the plan):\n" +
    `  rolling ${b.rolling7}ms vs baseline ${b.baselineMs}ms [band ${b.lowerMs}-${b.upperMs}ms] · latest ${b.latest}ms · day-to-day CV ${b.cvPct}%\n` +
    `  → ${b.status.toUpperCase()}: ${read}`
  );
}
