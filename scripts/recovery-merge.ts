import fs from "fs";
import { parseFlexibleRecovery, parseHealthFitXlsx, loadRecovery, mergeRecoveryRows, writeRecoveryCsv, recoveryReadiness, type RecoveryDay } from "../lib/recovery";

// ─── recovery-merge ───────────────────────────────────────────────────────────
// Merge an exported health-metrics table into the canonical data/recovery.csv.
// Accepts:
//   • .xlsx — the "Health Metrics_v5" workbook downloaded from Drive: ingests
//     BOTH the Daily Metrics tab (HRV/RHR/VO2max) and the Sleep tab (main
//     sleep per wake-date) in one pass. Preferred: sleep only reads this way.
//   • CSV / TSV / markdown pipe table (the Drive-connector view) — header-mapped.
// Dedupe by date; incoming values win field-by-field; empty cells never clobber.
//
// Usage: npm run recovery-merge <file> [--dry-run]
//   --dry-run: print what would change, write nothing.

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const src = args.find(a => a !== "--dry-run");
  if (!src) {
    console.error("Usage: npm run recovery-merge <exported-table-file> [--dry-run]");
    process.exit(1);
  }

  const incoming: RecoveryDay[] = src.toLowerCase().endsWith(".xlsx")
    ? parseHealthFitXlsx(fs.readFileSync(src))
    : parseFlexibleRecovery(fs.readFileSync(src, "utf-8"));
  if (incoming.length === 0) {
    console.error("No parseable rows found (need a header row containing 'Date' + at least one metric per row).");
    process.exit(1);
  }

  const existing = loadRecovery();
  const merged = mergeRecoveryRows(existing, incoming);

  // Field-level diff — what this merge actually changes.
  const before = new Map(existing.map(d => [d.date, d]));
  const changes: string[] = [];
  for (const d of merged) {
    const prev = before.get(d.date);
    const delta: string[] = [];
    for (const f of ["hrv", "rhr", "sleepH", "vo2max"] as const) {
      if (d[f] != null && d[f] !== prev?.[f]) {
        delta.push(`${f} ${prev?.[f] != null ? `${prev[f]}→` : ""}${d[f]}`);
      }
    }
    if (delta.length > 0) changes.push(`  ${d.date}: ${delta.join(", ")}${prev ? "" : "  (new day)"}`);
  }

  if (changes.length === 0) {
    console.log(`Nothing to change — ${incoming.length} incoming row(s) already reflected in data/recovery.csv.`);
    return;
  }
  console.log(`${dryRun ? "[dry-run] Would change" : "Changing"} ${changes.length} day(s):`);
  changes.forEach(c => console.log(c));

  if (!dryRun) {
    writeRecoveryCsv(merged);
    console.log(`Merged ${incoming.length} incoming row(s): ${existing.length} → ${merged.length} day(s) in data/recovery.csv`);
    console.log(`Range: ${merged[0].date} → ${merged[merged.length - 1].date}`);
    const read = recoveryReadiness(merged);
    if (read) read.lines.forEach(l => console.log(l));
  }
}

main();
