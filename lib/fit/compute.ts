// ─── Pure per-stream computations (FIT record messages → coaching metrics) ────
// Everything here is pure math over RecordPoint[] so it's unit-testable with
// synthetic arrays — no FIT decoding, no I/O. Replaces what the Strava API used to
// hand us pre-computed (splits, HR zones) and adds what it never did (TRIMP,
// normalized power from the raw stream).
import type { MileSplit, HRZoneSplit, StrideBlip } from "../types";
import { MAX_HR, HR_REST, HR_ZONE_BOUNDS } from "../config";
import { fmtPaceMMSS } from "../vdot";

export interface RecordPoint {
  t: number;       // epoch ms
  hr?: number;     // bpm
  dist?: number;   // cumulative meters
  alt?: number;    // meters
  power?: number;  // watts
  speed?: number;  // m/s
}

const MILE_M = 1609.344;
// Consecutive records further apart than this are treated as a pause (auto-pause /
// stopped at a light) and excluded from moving time — matches Strava's moving-pace
// split semantics closely enough for coaching.
const PAUSE_GAP_S = 10;

function movingDt(prevT: number, curT: number): number {
  const dt = (curT - prevT) / 1000;
  if (dt <= 0) return 0;
  return dt <= PAUSE_GAP_S ? dt : 0;
}

// Per-mile splits from cumulative distance: interpolate the crossing time at each
// 1609.344m boundary, accumulate moving time + time-weighted HR per split. Includes
// the partial final split at its true pace (matches Strava splits_standard).
export function computeMileSplits(records: RecordPoint[]): MileSplit[] | undefined {
  const pts = records.filter(r => r.dist != null && Number.isFinite(r.t));
  if (pts.length < 2) return undefined;
  const totalDist = pts[pts.length - 1].dist! - pts[0].dist!;
  if (totalDist < 400) return undefined; // sub-quarter-mile: no meaningful splits

  const splits: MileSplit[] = [];
  const startDist = pts[0].dist!;
  let mile = 1;
  let timerSec = 0;
  let hrWeighted = 0;
  let hrSec = 0;
  let splitStartAlt = pts[0].alt;
  let lastAlt = pts[0].alt;

  const closeSplit = (altAtClose: number | undefined, milesInSplit: number) => {
    const secPerMile = milesInSplit > 0 ? timerSec / milesInSplit : 0;
    splits.push({
      mile,
      pace: secPerMile > 0 ? `${fmtPaceMMSS(secPerMile)}/mi` : "N/A",
      avgHR: hrSec > 0 ? Math.round(hrWeighted / hrSec) : undefined,
      elevFt: altAtClose != null && splitStartAlt != null
        ? Math.round((altAtClose - splitStartAlt) * 3.28084)
        : undefined,
    });
    mile++;
    timerSec = 0;
    hrWeighted = 0;
    hrSec = 0;
    splitStartAlt = altAtClose;
  };

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const dtMoving = movingDt(prev.t, cur.t);
    const hr = cur.hr ?? prev.hr;
    if (cur.alt != null) lastAlt = cur.alt;

    let segStartD = prev.dist!;
    let segStartT = prev.t;
    const dCur = cur.dist!;

    // Handle every mile boundary crossed within this record interval.
    while (dCur - startDist >= mile * MILE_M && dCur > segStartD) {
      const boundary = startDist + mile * MILE_M;
      const frac = (boundary - segStartD) / (dCur - segStartD);
      const tCross = segStartT + frac * (cur.t - segStartT);
      const dtSlice = dtMoving * ((tCross - segStartT) / (cur.t - prev.t));
      timerSec += dtSlice;
      if (hr != null && dtSlice > 0) { hrWeighted += hr * dtSlice; hrSec += dtSlice; }
      closeSplit(lastAlt, 1);
      segStartD = boundary;
      segStartT = tCross;
    }

    const dtRest = dtMoving * ((cur.t - segStartT) / (cur.t - prev.t));
    timerSec += dtRest;
    if (hr != null && dtRest > 0) { hrWeighted += hr * dtRest; hrSec += dtRest; }
  }

  // Partial final split (only if it's a meaningful fraction of a mile).
  const remainingMi = (pts[pts.length - 1].dist! - startDist - (mile - 1) * MILE_M) / MILE_M;
  if (remainingMi >= 0.05 && timerSec > 0) closeSplit(lastAlt, remainingMi);

  return splits.length > 0 ? splits : undefined;
}

// Time-in-zone from the raw HR stream, bucketed by our own MAX_HR-fraction bounds.
// Emits exactly 5 zones sorted by minBpm (coach-prompt's validateHRZones contract).
export function computeHRZones(records: RecordPoint[]): HRZoneSplit[] | undefined {
  const bounds = HR_ZONE_BOUNDS.map(f => Math.round(f * MAX_HR)); // e.g. [135,150,167,180]
  const zones: HRZoneSplit[] = [0, 1, 2, 3, 4].map(i => ({
    zone: i + 1,
    minBpm: i === 0 ? 0 : bounds[i - 1],
    maxBpm: i === 4 ? 999 : bounds[i],
    seconds: 0,
  }));

  let any = false;
  for (let i = 1; i < records.length; i++) {
    const hr = records[i - 1].hr ?? records[i].hr;
    if (hr == null) continue;
    const dt = movingDt(records[i - 1].t, records[i].t);
    if (dt <= 0) continue;
    const z = zones.find(z => hr >= z.minBpm && hr < z.maxBpm) ?? zones[4];
    z.seconds += dt;
    any = true;
  }
  if (!any) return undefined;
  zones.forEach(z => { z.seconds = Math.round(z.seconds); });
  return zones;
}

// Banister TRIMP, per-record: Σ Δt(min) · x · 0.64·e^(1.92x), x = HR reserve fraction.
// Per-record beats session-average TRIMP for interval-shaped efforts. Replaces
// Strava's proprietary suffer score (same metric family, so magnitudes are ballpark-
// comparable — load-block thresholds get recalibrated after a few weeks of real data).
export function computeTrimp(records: RecordPoint[], hrRest: number = HR_REST): number | undefined {
  let trimp = 0;
  let any = false;
  for (let i = 1; i < records.length; i++) {
    const hr = records[i - 1].hr ?? records[i].hr;
    if (hr == null) continue;
    const dt = movingDt(records[i - 1].t, records[i].t);
    if (dt <= 0) continue;
    const x = Math.min(1, Math.max(0, (hr - hrRest) / (MAX_HR - hrRest)));
    trimp += (dt / 60) * x * 0.64 * Math.exp(1.92 * x);
    any = true;
  }
  return any ? Math.round(trimp) : undefined;
}

// HR drift: first-half vs last-half average across mile splits (≥4 splits with HR,
// report only when |Δ| ≥ 10). Shared with the legacy Strava path so the two report
// drift identically.
export function computeHRDriftFromSplits(splits: MileSplit[] | undefined): number | undefined {
  if (!splits || splits.length < 4) return undefined;
  const withHR = splits.filter(s => s.avgHR);
  if (withHR.length < 4) return undefined;
  const half = Math.floor(withHR.length / 2);
  const firstAvg = withHR.slice(0, half).reduce((s, m) => s + m.avgHR!, 0) / half;
  const lastAvg = withHR.slice(-half).reduce((s, m) => s + m.avgHR!, 0) / half;
  const drift = Math.round(lastAvg - firstAvg);
  return Math.abs(drift) >= 10 ? drift : undefined;
}

// Aerobic decoupling (Pa:HR): efficiency factor (speed/HR) of the first half vs the
// second half of a run, as a percentage. Positive = the same pace cost more HR late
// (cardiac drift / fading aerobic endurance); <5% on a 60-90min steady run is the
// classic "aerobically coupled" marker that the base is built. Only computed for
// runs ≥40min of moving time with HR + speed streams — the marathon-relevant read.
const DECOUPLING_MIN_MOVING_S = 40 * 60;

export function computeDecoupling(records: RecordPoint[]): number | undefined {
  // Collect per-interval (movingDt, speed, hr) samples.
  const samples: { dt: number; speed: number; hr: number }[] = [];
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const cur = records[i];
    const dt = movingDt(prev.t, cur.t);
    if (dt <= 0) continue;
    const hr = cur.hr ?? prev.hr;
    const speed = cur.speed ?? prev.speed
      ?? (cur.dist != null && prev.dist != null ? (cur.dist - prev.dist) / dt : undefined);
    if (hr == null || speed == null || speed <= 0) continue;
    samples.push({ dt, speed, hr });
  }

  const totalMoving = samples.reduce((s, x) => s + x.dt, 0);
  if (totalMoving < DECOUPLING_MIN_MOVING_S) return undefined;

  // Split at half the moving time.
  let acc = 0;
  let splitIdx = samples.length;
  for (let i = 0; i < samples.length; i++) {
    acc += samples[i].dt;
    if (acc >= totalMoving / 2) { splitIdx = i + 1; break; }
  }
  const ef = (part: typeof samples): number => {
    const t = part.reduce((s, x) => s + x.dt, 0);
    if (t === 0) return 0;
    const speed = part.reduce((s, x) => s + x.speed * x.dt, 0) / t;
    const hr = part.reduce((s, x) => s + x.hr * x.dt, 0) / t;
    return hr > 0 ? speed / hr : 0;
  };
  const ef1 = ef(samples.slice(0, splitIdx));
  const ef2 = ef(samples.slice(splitIdx));
  if (ef1 <= 0 || ef2 <= 0) return undefined;

  return parseFloat((((ef1 - ef2) / ef1) * 100).toFixed(1));
}

// ─── Stride-blip detection ─────────────────────────────────────────────────────
// Strides (4-6×20s relaxed-fast reps after an easy run) are invisible in mile
// splits — 20s at 7:00/mi inside a 9:30/mi mile barely moves the average — but
// they leave an unmistakable signature in the HR stream: a short, SHARP spike
// 8-15bpm above the local baseline that decays back within a minute or two.
// Detection is HR-based (not speed) because treadmill strides can hide from the
// belt-speed stream too. Guards against false positives:
//   - skip the first 5min (the warmup ramp climbs steadily, not sharply)
//   - the rise must be fast (baseline-cross → peak within 60s) — hills aren't
//   - the whole excursion must be over within 2min — surges/hills last longer
const STRIDE_SKIP_START_S = 300;
const STRIDE_EDGE_RISE = 5;        // bpm above baseline that opens/closes an excursion
const STRIDE_MIN_PEAK_RISE = 9;   // bpm above baseline the peak must reach (real strides run +12-17; +8-9 is surge noise)
const STRIDE_MAX_RISE_S = 60;      // excursion start → peak (sharpness)
const STRIDE_MAX_DURATION_S = 120; // whole excursion (rise + decay)
const STRIDE_SMOOTH_N = 5;         // samples (~5s) of HR smoothing
// Baseline = 25th percentile of the trailing [t-180s, t-20s] window. A low
// percentile (not the median) so a PREVIOUS stride's decay inside the window
// can't inflate the reference and mask the next rep — strides come 4-6 in a row.
const BASELINE_WINDOW_S: [number, number] = [180, 20];
const BASELINE_PCTL = 0.25;

export function detectStrideBlips(records: RecordPoint[]): StrideBlip[] | undefined {
  const pts = records.filter(r => r.hr != null && Number.isFinite(r.t));
  if (pts.length < 120) return undefined; // needs a real HR stream (~2min+)
  const t0 = pts[0].t;
  const el = pts.map(p => (p.t - t0) / 1000);
  const raw = pts.map(p => p.hr!);

  // Light smoothing so single-sample strap noise can't fake a spike.
  const hr: number[] = raw.map((_, i) => {
    const lo = Math.max(0, i - STRIDE_SMOOTH_N + 1);
    let s = 0;
    for (let j = lo; j <= i; j++) s += raw[j];
    return s / (i - lo + 1);
  });

  // Trailing low-percentile baseline (window excludes the last 20s, so an
  // in-progress blip doesn't pollute its own reference).
  const baseline: (number | undefined)[] = el.map((t, i) => {
    if (t < BASELINE_WINDOW_S[0]) return undefined;
    const win: number[] = [];
    for (let j = i; j >= 0 && el[j] >= t - BASELINE_WINDOW_S[0]; j--) {
      if (el[j] <= t - BASELINE_WINDOW_S[1]) win.push(hr[j]);
    }
    if (win.length < 10) return undefined;
    win.sort((a, b) => a - b);
    return win[Math.floor(win.length * BASELINE_PCTL)];
  });

  const blips: StrideBlip[] = [];
  let i = 0;
  while (i < el.length) {
    const b = baseline[i];
    if (b == null || el[i] < STRIDE_SKIP_START_S || hr[i] < b + STRIDE_EDGE_RISE) { i++; continue; }
    // Excursion opened — walk to its end (HR back under baseline+edge, or stream end).
    const start = i;
    const openBase = b;
    let peakIdx = i;
    while (i < el.length && hr[i] >= openBase + STRIDE_EDGE_RISE) {
      if (hr[i] > hr[peakIdx]) peakIdx = i;
      i++;
    }
    const endEl = i < el.length ? el[i] : el[el.length - 1];
    const duration = endEl - el[start];
    const riseTime = el[peakIdx] - el[start];
    const peakRise = hr[peakIdx] - openBase;
    const endedWithStream = i >= el.length;
    if (
      peakRise >= STRIDE_MIN_PEAK_RISE &&
      riseTime <= STRIDE_MAX_RISE_S &&
      (duration <= STRIDE_MAX_DURATION_S || (endedWithStream && riseTime <= STRIDE_MAX_RISE_S))
    ) {
      // Report the raw (unsmoothed) peak inside the excursion for display.
      let rawPeak = raw[start];
      for (let j = start; j < Math.min(i + 1, raw.length); j++) rawPeak = Math.max(rawPeak, raw[j]);
      blips.push({
        atSec: Math.round(el[peakIdx]),
        peakHR: Math.round(rawPeak),
        baseHR: Math.round(openBase),
        durationSec: Math.round(duration),
      });
    }
  }
  return blips.length > 0 ? blips : undefined;
}

// One-line human read of the blips, shared by last-run and coach-data.
export function describeStrideBlips(blips: StrideBlip[]): string {
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const peaks = blips.map(b => b.peakHR).join("/");
  const times = blips.map(b => mmss(b.atSec)).join(", ");
  return `${blips.length} short HR spike${blips.length === 1 ? "" : "s"} (≈strides) — peaks ${peaks} bpm at ${times}`;
}

// Normalized power (Coggan): 30s rolling average of power, mean of 4th powers, ^0.25.
// Assumes ~1s record cadence (true for Apple Watch exports); returns undefined when
// there isn't enough power data to be meaningful.
export function computeNormalizedPower(records: RecordPoint[]): number | undefined {
  const powers = records.filter(r => r.power != null).map(r => r.power!);
  if (powers.length < 60) return undefined;

  const WINDOW = 30;
  let sum = 0;
  let fourthSum = 0;
  let count = 0;
  for (let i = 0; i < powers.length; i++) {
    sum += powers[i];
    if (i >= WINDOW) sum -= powers[i - WINDOW];
    if (i >= WINDOW - 1) {
      const rolling = sum / WINDOW;
      fourthSum += Math.pow(rolling, 4);
      count++;
    }
  }
  if (count === 0) return undefined;
  return Math.round(Math.pow(fourthSum / count, 0.25));
}
