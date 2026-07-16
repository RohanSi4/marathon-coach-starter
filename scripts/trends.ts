import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { RUN_TYPES, weekKey, fmtPace } from "../lib/weeks";
import { loadActivities } from "../lib/store";
import { loadRecovery } from "../lib/recovery";
import type { StoredActivity } from "../lib/types";
import { noteDateKey } from "../lib/notes";

// ─── trends ───────────────────────────────────────────────────────────────────
// Longitudinal analysis over the full FIT archive — the questions a coach asks of
// two years of data: is aerobic efficiency (speed per heartbeat) improving? Is the
// aerobic base holding on long runs (decoupling)? What's the real training load?
// And the honest training-age context behind the current build.
//
// Usage: npm run trends [weeks]     (weekly table depth, default 12)

const EASY_HR_MAX = 152;

function ef(a: StoredActivity): number | null {
  // Efficiency factor: speed per heartbeat (m/s per bpm ×1000). Higher = fitter.
  if (!a.average_heartrate || a.average_speed <= 0) return null;
  return (a.average_speed / a.average_heartrate) * 1000;
}

function main() {
  const depth = parseInt(process.argv[2] ?? "12", 10);
  const all = loadActivities();
  const runs = all.filter(a => RUN_TYPES.includes(a.type) && a.distance > 800);

  // ── Training-age context (by year) ──
  console.log("── Training age (the returning-runner evidence) ───────────────────");
  const byYear = new Map<string, { mi: number; n: number }>();
  for (const r of runs) {
    const y = noteDateKey(new Date(r.start_date)).slice(0, 4);
    const e = byYear.get(y) ?? { mi: 0, n: 0 };
    e.mi += r.distance / 1609.344;
    e.n++;
    byYear.set(y, e);
  }
  for (const [y, e] of [...byYear.entries()].sort()) {
    console.log(`  ${y}: ${e.mi.toFixed(0).padStart(5)}mi across ${String(e.n).padStart(3)} runs`);
  }

  // ── Weekly table ──
  const weekMap = new Map<string, StoredActivity[]>();
  for (const r of runs) {
    const k = weekKey(new Date(r.start_date));
    if (!weekMap.has(k)) weekMap.set(k, []);
    weekMap.get(k)!.push(r);
  }
  const weeks = [...weekMap.entries()]
    .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
    .slice(-depth);

  console.log(`\n── Last ${weeks.length} run-weeks: efficiency + load ──────────────────────`);
  console.log("  Week          | Miles | TRIMP | easyHR | EF(easy) | decoupling (runs ≥40min)");
  console.log("  " + "─".repeat(78));
  for (const [wk, ws] of weeks) {
    const miles = ws.reduce((s, r) => s + r.distance / 1609.344, 0);
    const trimp = ws.reduce((s, r) => s + (r.trimp ?? 0), 0);
    const easy = ws.filter(r => (r.average_heartrate ?? 999) <= EASY_HR_MAX);
    const easyHR = easy.length
      ? Math.round(easy.reduce((s, r) => s + r.average_heartrate!, 0) / easy.length)
      : null;
    const efs = easy.map(ef).filter((v): v is number => v != null);
    const avgEF = efs.length ? (efs.reduce((a, b) => a + b, 0) / efs.length).toFixed(1) : "—";
    const dec = ws.filter(r => r.decouplingPct != null)
      .map(r => `${(r.distance / 1609.344).toFixed(0)}mi:${r.decouplingPct! > 0 ? "+" : ""}${r.decouplingPct}%`)
      .join(" ") || "—";
    console.log(`  ${wk.padEnd(14)}| ${miles.toFixed(1).padStart(5)} | ${String(trimp).padStart(5)} | ${easyHR != null ? String(easyHR).padStart(6) : "     —"} | ${avgEF.padStart(8)} | ${dec}`);
  }
  console.log("  EF = m/s per bpm ×1000 on easy runs (higher = more speed per heartbeat).");

  // ── Easy-run cadence by month (we coach a nudge toward ~165 spm — track it) ──
  const cadRuns = runs.filter(r => r.average_cadence != null && (r.average_heartrate ?? 999) <= EASY_HR_MAX
    && r.average_cadence! > 130 /* <130 spm on a run = bad sample (walk mix / sensor) */);
  if (cadRuns.length > 0) {
    const byMonth2 = new Map<string, number[]>();
    for (const r of cadRuns.slice(-60)) {
      const m = noteDateKey(new Date(r.start_date)).slice(0, 7);
      if (!byMonth2.has(m)) byMonth2.set(m, []);
      byMonth2.get(m)!.push(r.average_cadence!);
    }
    const line = [...byMonth2.entries()].sort().slice(-6)
      .map(([m, cs]) => `${m}: ${(cs.reduce((a, b) => a + b, 0) / cs.length).toFixed(0)}spm(n=${cs.length})`)
      .join(" · ");
    console.log(`\n── Easy-run cadence (target: nudge toward ~165 spm) ────────────────\n  ${line}`);
  }

  // ── Recovery by month (HRV / RHR / sleep / VO2max — the body's ledger) ──
  const recovery = loadRecovery();
  if (recovery.length > 0) {
    const byMonth = new Map<string, { hrv: number[]; rhr: number[]; sleep: number[]; vo2: number[] }>();
    for (const d of recovery) {
      const m = d.date.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, { hrv: [], rhr: [], sleep: [], vo2: [] });
      const e = byMonth.get(m)!;
      if (d.hrv != null) e.hrv.push(d.hrv);
      if (d.rhr != null) e.rhr.push(d.rhr);
      if (d.sleepH != null) e.sleep.push(d.sleepH);
      if (d.vo2max != null) e.vo2.push(d.vo2max);
    }
    const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    console.log("\n── Recovery by month (HRV ↑ / RHR ↓ / sleep ≥7h = absorbing) ──────");
    console.log("  Month    | RHR  | HRV  | Sleep | short<6.5h | VO2max");
    for (const [m, e] of [...byMonth.entries()].sort().slice(-13)) {
      const rhr = avg(e.rhr), hrv = avg(e.hrv), sl = avg(e.sleep), vo = avg(e.vo2);
      const short = e.sleep.filter(h => h < 6.5).length;
      console.log(`  ${m}  | ${rhr != null ? rhr.toFixed(0).padStart(4) : "   —"} | ${hrv != null ? hrv.toFixed(0).padStart(4) : "   —"} | ${sl != null ? sl.toFixed(1).padStart(5) : "    —"} | ${String(short).padStart(10)} | ${vo != null ? vo.toFixed(1) : "—"}`);
    }
  }

  // ── Long-run decoupling history (the marathon-readiness ledger) ──
  const longish = runs.filter(r => r.decouplingPct != null && r.moving_time >= 40 * 60)
    .slice(-12);
  if (longish.length > 0) {
    console.log("\n── Decoupling ledger (≥40min runs — <5% on 90min+ = base built) ───");
    for (const r of longish) {
      const d = r.decouplingPct!;
      const flag = d < 5 ? "✓ coupled" : d < 10 ? "· building" : "⚠ high drift";
      console.log(`  ${noteDateKey(new Date(r.start_date))} | ${(r.distance / 1609.344).toFixed(1).padStart(5)}mi @ ${fmtPace(r.average_speed).padStart(8)} | HR ${r.average_heartrate ?? "—"} | ${d > 0 ? "+" : ""}${d}% ${flag}`);
    }
  }
}

main();
