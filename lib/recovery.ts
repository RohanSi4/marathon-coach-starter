// ─── Daily recovery metrics (HRV / resting HR / sleep) ────────────────────────
// Fed by an iOS automation (Shortcuts or Health Auto Export — see
// docs/SETUP-HEALTHFIT.md) appending one row per day to data/recovery.csv:
//
//   date,hrv_ms,rhr_bpm,sleep_hours,vo2max
//   2026-07-02,68,52,7.4,53.2
//
// Blank cells are fine (a day without a sleep reading still carries HRV/RHR).
// Rows for the same date: last one wins (idempotent re-runs of the automation).
//
// This is the data Strava NEVER exposed. Two uses:
//   1. READINESS: 7-day vs 28-day baselines. Suppressed HRV (7d < ~90% of 28d) or
//      elevated RHR (7d > 28d + 3bpm) = classic under-recovery signals → they bias
//      the tier toward YELLOW (signals, not verdicts — n=1, judge with the rest).
//   2. TRIMP accuracy: the athlete's real resting HR replaces the config estimate.
import fs from "fs";
import path from "path";
import { coachTZ, HR_REST } from "./config";

export interface RecoveryDay {
  date: string;      // YYYY-MM-DD
  hrv?: number;      // SDNN ms
  rhr?: number;      // bpm
  sleepH?: number;   // hours
  vo2max?: number;   // ml/kg/min (Apple Watch estimate — sparse, engine-trend only)
}

export const DEFAULT_RECOVERY_PATH = path.join(process.cwd(), "data", "recovery.csv");

export function parseRecoveryCsv(content: string): RecoveryDay[] {
  const byDate = new Map<string, RecoveryDay>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || /^date[,;]/i.test(t)) continue;
    const [date, hrv, rhr, sleep, vo2] = t.split(",").map(c => c?.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) continue;
    const parse = (v?: string) => {
      const n = parseFloat(v ?? "");
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    // Later rows for the same date win FIELD-BY-FIELD (a partial evening row —
    // sleep landing hours after the morning HRV/RHR — must not wipe the earlier
    // fields; Apple Health posts metrics at different times of day).
    const prev = byDate.get(date);
    byDate.set(date, {
      date,
      hrv: parse(hrv) ?? prev?.hrv,
      rhr: parse(rhr) ?? prev?.rhr,
      sleepH: parse(sleep) ?? prev?.sleepH,
      vo2max: parse(vo2) ?? prev?.vo2max,
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function loadRecovery(csvPath: string = DEFAULT_RECOVERY_PATH): RecoveryDay[] {
  try {
    return parseRecoveryCsv(fs.readFileSync(csvPath, "utf-8"));
  } catch {
    return [];
  }
}

function avg(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function lastNDays(days: RecoveryDay[], n: number, asOf: string): RecoveryDay[] {
  const cutoff = new Date(asOf + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - n);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return days.filter(d => d.date > cutoffStr && d.date <= asOf);
}

export interface RecoveryRead {
  lines: string[];        // formatted lines for the READINESS block
  underRecovered: boolean; // both HRV suppressed AND RHR elevated → real yellow signal
  anyFlag: boolean;
}

// 7-day vs 28-day baseline read, as of the newest row. Needs ≥14 days of history
// before baselines mean anything — reports "collecting baseline" until then.
export function recoveryReadiness(days: RecoveryDay[]): RecoveryRead | null {
  if (days.length === 0) return null;
  const asOf = days[days.length - 1].date;
  const d7 = lastNDays(days, 7, asOf);
  const d28 = lastNDays(days, 28, asOf);

  if (d28.length < 14) {
    return {
      lines: [`Recovery data: ${days.length} day(s) logged (baseline needs ~14) — collecting; latest ${asOf}: ` +
        [days[days.length - 1].hrv != null ? `HRV ${days[days.length - 1].hrv}ms` : null,
         days[days.length - 1].rhr != null ? `RHR ${days[days.length - 1].rhr}bpm` : null,
         days[days.length - 1].sleepH != null ? `sleep ${days[days.length - 1].sleepH}h` : null,
        ].filter(Boolean).join(" · ")],
      underRecovered: false,
      anyFlag: false,
    };
  }

  const hrv7 = avg(d7.map(d => d.hrv).filter((v): v is number => v != null));
  const hrv28 = avg(d28.map(d => d.hrv).filter((v): v is number => v != null));
  const rhr7 = avg(d7.map(d => d.rhr).filter((v): v is number => v != null));
  const rhr28 = avg(d28.map(d => d.rhr).filter((v): v is number => v != null));
  const sleep7 = avg(d7.map(d => d.sleepH).filter((v): v is number => v != null));

  const hrvSuppressed = hrv7 != null && hrv28 != null && hrv7 < 0.9 * hrv28;
  const rhrElevated = rhr7 != null && rhr28 != null && rhr7 > rhr28 + 3;
  const shortSleep = sleep7 != null && sleep7 < 6.5;

  const lines: string[] = [];
  if (hrv7 != null && hrv28 != null) {
    lines.push(`HRV: 7d ${hrv7.toFixed(0)}ms vs 28d ${hrv28.toFixed(0)}ms${hrvSuppressed ? " ⚠ SUPPRESSED (>10% below baseline — under-recovery signal)" : " ✓"}`);
  }
  if (rhr7 != null && rhr28 != null) {
    lines.push(`Resting HR: 7d ${rhr7.toFixed(0)}bpm vs 28d ${rhr28.toFixed(0)}bpm${rhrElevated ? " ⚠ ELEVATED (+3bpm over baseline — fatigue/illness signal)" : " ✓"}`);
  }
  if (sleep7 != null) {
    lines.push(`Sleep: 7d avg ${sleep7.toFixed(1)}h${shortSleep ? " ⚠ SHORT (<6.5h — recovery is being cut)" : ""}`);
  }

  return {
    lines,
    underRecovered: hrvSuppressed && rhrElevated,
    anyFlag: hrvSuppressed || rhrElevated || shortSleep,
  };
}

// Last-n-days detail lines for the coaching context — the texture behind the
// 7d/28d averages (a short night before the long run, an HRV dip after hoops).
export function recoveryDetail(days: RecoveryDay[], n = 7): string[] {
  return days.slice(-n).map(d => {
    const parts = [
      d.hrv != null ? `HRV ${Math.round(d.hrv)}ms` : null,
      d.rhr != null ? `RHR ${Math.round(d.rhr)}bpm` : null,
      d.sleepH != null ? `sleep ${d.sleepH.toFixed(1)}h` : null,
    ].filter(Boolean);
    return `${d.date}: ${parts.join(" · ") || "no data"}`;
  });
}

// Apple Watch VO2max readings are sparse (a few per month). Trend the last few
// plus the change vs ~8 weeks ago — the engine's independent, measured trajectory.
export function vo2maxTrend(days: RecoveryDay[]): string | null {
  const readings = days.filter(d => d.vo2max != null);
  if (readings.length === 0) return null;
  const recent = readings.slice(-4);
  const latest = recent[recent.length - 1];
  const cutoff = new Date(latest.date + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - 56);
  const cutStr = cutoff.toISOString().slice(0, 10);
  const before = readings.filter(d => d.date <= cutStr);
  const baseline = before.length > 0 ? before[before.length - 1] : readings[0];
  const delta = latest.vo2max! - baseline.vo2max!;
  const line = recent.map(d => `${d.date.slice(5)}: ${d.vo2max!.toFixed(1)}`).join(" → ");
  return `VO2max (Apple, measured): ${line}${baseline !== latest ? ` (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} vs ${baseline.date})` : ""}`;
}

// ─── Auto-sync from iCloud ─────────────────────────────────────────────────────
// The iOS Shortcut can only write inside iCloud folders the phone can reach — it
// appends rows to a recovery.csv there. At import time we sweep the candidate
// locations and merge any rows into data/recovery.csv (dedupe by date, later wins),
// so the athlete's automation Just Works no matter which folder Shortcuts used.
const home = process.env.HOME ?? "";
export const EXTERNAL_RECOVERY_CANDIDATES = [
  path.join(home, "Library", "Mobile Documents", "iCloud~is~workflow~my~workflows", "Documents", "recovery.csv"), // Shortcuts app container
  path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Shortcuts", "recovery.csv"),
  path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "recovery.csv"),
  path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "HealthAutoExport", "recovery.csv"),
];

export function mergeRecoveryRows(existing: RecoveryDay[], incoming: RecoveryDay[]): RecoveryDay[] {
  const byDate = new Map(existing.map(d => [d.date, d]));
  for (const d of incoming) {
    const prev = byDate.get(d.date);
    byDate.set(d.date, {
      date: d.date,
      hrv: d.hrv ?? prev?.hrv,
      rhr: d.rhr ?? prev?.rhr,
      sleepH: d.sleepH ?? prev?.sleepH,
      vo2max: d.vo2max ?? prev?.vo2max,
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function writeRecoveryCsv(days: RecoveryDay[], canonicalPath: string = DEFAULT_RECOVERY_PATH): void {
  const header = "# Daily recovery metrics — auto-merged (see docs/SETUP-HEALTHFIT.md §6).\ndate,hrv_ms,rhr_bpm,sleep_hours,vo2max";
  const rows = days.map(d => `${d.date},${d.hrv ?? ""},${d.rhr ?? ""},${d.sleepH ?? ""},${d.vo2max ?? ""}`);
  fs.writeFileSync(canonicalPath, header + "\n" + rows.join("\n") + "\n");
}

// Sweep iCloud candidates → merge new rows into data/recovery.csv. Returns how
// many rows the canonical file gained. Safe to call every import; fully offline.
export function syncExternalRecovery(
  candidates: string[] = EXTERNAL_RECOVERY_CANDIDATES,
  canonicalPath: string = DEFAULT_RECOVERY_PATH
): number {
  const existing = loadRecovery(canonicalPath);
  let merged = existing;
  for (const p of candidates) {
    try {
      merged = mergeRecoveryRows(merged, parseRecoveryCsv(fs.readFileSync(p, "utf-8")));
    } catch { /* candidate absent — fine */ }
  }
  // Gate the write on actual CONTENT change, not row count — the daily pattern is
  // field-level updates to an existing date (sleep/VO2max arriving after the
  // morning HRV row), which leaves length unchanged but must still be persisted.
  const before = new Map(existing.map(d => [d.date, JSON.stringify(d)]));
  const changedDays = merged.filter(d => before.get(d.date) !== JSON.stringify(d)).length;
  if (changedDays === 0) return 0;
  writeRecoveryCsv(merged, canonicalPath);
  return changedDays;
}

// ─── Flexible ingestion (HealthFit Google Sheet & friends) ────────────────────
// HealthFit's "Health Metrics" spreadsheet arrives with its own column names and
// order (Date | Active Energy | Resting Energy | Resting | HRV | Steps | VO₂ max |
// …). This parser header-maps whatever shows up — CSV, TSV, or a markdown pipe
// table (which is how the sheet reads through the Drive connector) — into
// RecoveryDay rows, tolerating unit suffixes ("52 bpm"), h:mm sleep, and US dates.
function toISODate(raw: string): string | null {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // M/D/YYYY
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const parsed = Date.parse(t); // "Jul 3, 2026" and similar
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
}

function toHours(raw: string): number | undefined {
  const hm = raw.match(/^(\d{1,2}):(\d{2})$/) ?? raw.match(/(\d+)\s*h(?:ours?)?\s*(\d+)?\s*m?/i);
  if (hm) return parseFloat((parseInt(hm[1], 10) + (hm[2] ? parseInt(hm[2], 10) / 60 : 0)).toFixed(2));
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 && n < 24 ? n : undefined;
}

export function parseFlexibleRecovery(content: string): RecoveryDay[] {
  const lines = content.split("\n").map(l => l.trim()).filter(l => l && !/^\|?\s*:?-/.test(l));
  const split = (l: string) =>
    (l.includes("|") ? l.replace(/^\|/, "").replace(/\|$/, "").split("|")
      : l.includes("\t") ? l.split("\t")
      : l.split(",")).map(c => c.trim());

  const headerIdx = lines.findIndex(l => /date/i.test(l));
  if (headerIdx < 0) return [];
  const headers = split(lines[headerIdx]).map(h => h.toLowerCase());
  const col = (re: RegExp) => headers.findIndex(h => re.test(h));
  const cols = {
    date: col(/date/),
    hrv: col(/hrv|variability/),
    rhr: col(/^resting$|resting\s*(hr|heart)|rhr/),
    sleep: col(/sleep/),
    vo2: col(/vo.?2|vo.*max|cardio\s*fitness/), // "VO₂ max" uses subscript-two (U+2082)
  };
  if (cols.date < 0) return [];

  const num = (cells: string[], i: number) => {
    if (i < 0 || !cells[i]) return undefined;
    const n = parseFloat(cells[i].replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const out: RecoveryDay[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const cells = split(line);
    const date = toISODate(cells[cols.date] ?? "");
    if (!date) continue;
    const sleepH = cols.sleep >= 0 && cells[cols.sleep] ? toHours(cells[cols.sleep]) : undefined;
    const row: RecoveryDay = { date, hrv: num(cells, cols.hrv), rhr: num(cells, cols.rhr), sleepH, vo2max: num(cells, cols.vo2) };
    if (row.hrv != null || row.rhr != null || row.sleepH != null || row.vo2max != null) out.push(row);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── HealthFit xlsx ingestion (Health Metrics_v5 workbook) ────────────────────
// The Google Sheet exported as .xlsx carries MORE than the Drive-connector
// markdown view: the Sleep tab (per-night rows) only reads reliably this way.
// Extracts BOTH tabs into RecoveryDay rows:
//   • "Daily Metrics": Date (Excel serial) · Resting → rhr · HRV → hrv ·
//     VO₂ max → vo2max. The export duplicates rows; per date the LAST
//     occurrence wins field-by-field (matches parseRecoveryCsv semantics —
//     dupes are identical in practice).
//   • "Sleep": Main=1 rows only (naps/fragments are Main=0); the row Date is
//     the WAKE date; Asleep is a fraction of a day → ×24 h, 1 decimal. If a
//     wake date somehow carries several Main rows, the LONGEST sleep wins (a
//     fragment must not shadow the real night).
import { readXlsx, serialToISODate, type XlsxSheet } from "./xlsx-lite";

function cellDate(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const n = parseFloat(t);
  if (Number.isFinite(n) && n > 20000 && n < 80000) return serialToISODate(n); // Excel serial (1954..2119)
  return toISODate(t);
}

function headerMap(sheet: XlsxSheet): { headers: string[]; body: string[][] } | null {
  const idx = sheet.rows.findIndex(r => r.some(c => /date/i.test(c)));
  if (idx < 0) return null;
  return { headers: sheet.rows[idx].map(h => h.trim().toLowerCase()), body: sheet.rows.slice(idx + 1) };
}

export function parseHealthFitXlsx(buf: Buffer): RecoveryDay[] {
  const sheets = readXlsx(buf);
  const byName = (n: string) => sheets.find(s => s.name.trim() === n);
  const byDate = new Map<string, RecoveryDay>();

  const daily = byName("Daily Metrics");
  const dm = daily && headerMap(daily);
  if (dm) {
    const col = (re: RegExp) => dm.headers.findIndex(h => re.test(h));
    const cols = { date: col(/date/), hrv: col(/hrv|variability/), rhr: col(/^resting$|resting\s*(hr|heart)|rhr/), vo2: col(/vo.?2|vo.*max|cardio\s*fitness/) };
    // Normalize precision to the csv's conventions (hrv/rhr whole bpm/ms,
    // vo2max 1 decimal) — the sheet carries 14-decimal float tails that would
    // otherwise churn every historical row on first merge.
    const num = (cells: string[], i: number, dp = 0) => {
      if (i < 0 || !cells[i]) return undefined;
      const n = parseFloat(cells[i].replace(/[^\d.]/g, ""));
      if (!Number.isFinite(n) || n <= 0) return undefined;
      const f = 10 ** dp;
      return Math.round(n * f) / f;
    };
    for (const cells of dm.body) {
      const date = cellDate(cells[cols.date] ?? "");
      if (!date) continue;
      const prev = byDate.get(date);
      byDate.set(date, {
        date,
        hrv: num(cells, cols.hrv) ?? prev?.hrv,
        rhr: num(cells, cols.rhr) ?? prev?.rhr,
        vo2max: num(cells, cols.vo2, 1) ?? prev?.vo2max,
        sleepH: prev?.sleepH,
      });
    }
  }

  const sleep = byName("Sleep");
  const sl = sleep && headerMap(sleep);
  if (sl) {
    const col = (re: RegExp) => sl.headers.findIndex(h => re.test(h));
    const cols = { date: col(/date/), main: col(/^main$/), asleep: col(/^asleep$/) };
    if (cols.main >= 0 && cols.asleep >= 0) {
      for (const cells of sl.body) {
        const date = cellDate(cells[cols.date] ?? "");
        if (!date) continue;
        if (parseFloat(cells[cols.main] ?? "") !== 1) continue; // main sleep only
        const frac = parseFloat(cells[cols.asleep] ?? "");
        if (!Number.isFinite(frac) || frac <= 0 || frac >= 1) continue;
        const hours = Math.round(frac * 24 * 10) / 10;
        const prev = byDate.get(date);
        if (prev?.sleepH != null && prev.sleepH >= hours) continue; // longest night wins
        byDate.set(date, { date, ...prev, sleepH: hours });
      }
    }
  }

  return [...byDate.values()]
    .filter(d => d.hrv != null || d.rhr != null || d.sleepH != null || d.vo2max != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// The athlete's real resting HR for TRIMP as it was known on a workout date:
// 7-day average of logged RHR through that date, never readings from the future.
// Date-times are converted to the athlete's coaching timezone so an evening run
// is paired with the correct local recovery day rather than the next UTC day.
export function restingHRAsOf(asOf: string | Date, days: RecoveryDay[] = loadRecovery()): number {
  let date: string;
  if (asOf instanceof Date) {
    if (!Number.isFinite(asOf.getTime())) return HR_REST;
    date = asOf.toLocaleDateString("en-CA", { timeZone: coachTZ(asOf) });
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    date = asOf;
  } else {
    const parsed = new Date(asOf);
    if (!Number.isFinite(parsed.getTime())) return HR_REST;
    date = parsed.toLocaleDateString("en-CA", { timeZone: coachTZ(parsed) });
  }

  const recent = lastNDays(days, 7, date)
    .map(d => d.rhr)
    .filter((v): v is number => v != null);
  const a = avg(recent);
  return a != null ? Math.round(a) : HR_REST;
}

// Current coaching displays use the newest recovery row. Keep this wrapper for
// callers that want "now" while sharing the same no-future/fallback semantics.
export function currentRestingHR(days: RecoveryDay[] = loadRecovery()): number {
  if (days.length === 0) return HR_REST;
  return restingHRAsOf(days[days.length - 1].date, days);
}
