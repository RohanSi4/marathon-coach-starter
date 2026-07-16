// Recovery-metrics ingestion: CSV parsing, 7d-vs-28d baseline flags, and the
// resting-HR feed into TRIMP. These signals bias the readiness tier toward YELLOW
// when the physiology says under-recovered — signals, not verdicts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { parseRecoveryCsv, recoveryReadiness, currentRestingHR, restingHRAsOf, mergeRecoveryRows, syncExternalRecovery } from "../lib/recovery";

function csvFor(days: Array<{ d: string; hrv?: number; rhr?: number; sleep?: number }>): string {
  return "date,hrv_ms,rhr_bpm,sleep_hours\n" +
    days.map(x => `${x.d},${x.hrv ?? ""},${x.rhr ?? ""},${x.sleep ?? ""}`).join("\n");
}

function dateSeq(n: number, endISO: string): string[] {
  const end = new Date(endISO + "T00:00:00Z");
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (n - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

test("parses CSV, skips headers/comments/garbage, last row per date wins", () => {
  const days = parseRecoveryCsv([
    "# comment",
    "date,hrv_ms,rhr_bpm,sleep_hours",
    "2026-07-01,65,53,7.2",
    "not a row",
    "2026-07-01,68,52,7.4", // same date again — wins
    "2026-07-02,,54,",      // partial row is fine
  ].join("\n"));
  assert.equal(days.length, 2);
  assert.equal(days[0].hrv, 68);
  assert.equal(days[1].hrv, undefined);
  assert.equal(days[1].rhr, 54);
});

test("under 14 days → collecting-baseline message, no flags", () => {
  const days = parseRecoveryCsv(csvFor(dateSeq(5, "2026-07-02").map(d => ({ d, hrv: 65, rhr: 52, sleep: 7 }))));
  const read = recoveryReadiness(days)!;
  assert.match(read.lines[0], /collecting/);
  assert.equal(read.underRecovered, false);
});

test("healthy baselines read ✓ and don't flag", () => {
  const days = parseRecoveryCsv(csvFor(dateSeq(28, "2026-07-02").map(d => ({ d, hrv: 65, rhr: 52, sleep: 7.5 }))));
  const read = recoveryReadiness(days)!;
  assert.equal(read.anyFlag, false);
  assert.equal(read.underRecovered, false);
  assert.match(read.lines.join(" "), /HRV: 7d 65ms vs 28d 65ms ✓/);
});

test("suppressed HRV + elevated RHR → underRecovered (the YELLOW bias)", () => {
  const seq = dateSeq(28, "2026-07-02");
  const days = parseRecoveryCsv(csvFor(seq.map((d, i) => (
    i < 21 ? { d, hrv: 70, rhr: 51, sleep: 7.5 }          // baseline 3 weeks
           : { d, hrv: 55, rhr: 58, sleep: 6.0 }          // rough final week
  ))));
  const read = recoveryReadiness(days)!;
  assert.equal(read.underRecovered, true);
  assert.match(read.lines.join(" "), /SUPPRESSED/);
  assert.match(read.lines.join(" "), /ELEVATED/);
  assert.match(read.lines.join(" "), /SHORT/);
});

test("mergeRecoveryRows: dedupes by date, fills gaps, incoming wins field-by-field", () => {
  const existing = parseRecoveryCsv(csvFor([{ d: "2026-07-01", hrv: 60, rhr: 55 }]));
  const incoming = parseRecoveryCsv(csvFor([
    { d: "2026-07-01", hrv: 65 },          // updates hrv, keeps existing rhr
    { d: "2026-07-02", rhr: 52, sleep: 7 } // new day
  ]));
  const merged = mergeRecoveryRows(existing, incoming);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].hrv, 65);
  assert.equal(merged[0].rhr, 55);
  assert.equal(merged[1].sleepH, 7);
});

test("syncExternalRecovery merges candidate files into the canonical csv", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  const canonical = path.join(dir, "recovery.csv");
  const external = path.join(dir, "shortcut-drop.csv");
  fs.writeFileSync(canonical, "date,hrv_ms,rhr_bpm,sleep_hours\n2026-07-01,60,55,7\n");
  fs.writeFileSync(external, "2026-07-02,66,52,7.5\n2026-07-03,64,53,\n");
  const added = syncExternalRecovery([external], canonical);
  assert.equal(added, 2);
  const rows = parseRecoveryCsv(fs.readFileSync(canonical, "utf-8"));
  assert.equal(rows.length, 3);
  assert.equal(rows[2].hrv, 64);
  // Idempotent: second sync adds nothing.
  assert.equal(syncExternalRecovery([external], canonical), 0);
});

test("currentRestingHR: 7-day average of logged RHR; config fallback when empty", () => {
  const days = parseRecoveryCsv(csvFor(dateSeq(10, "2026-07-02").map((d, i) => ({ d, rhr: i < 3 ? 60 : 52 }))));
  assert.equal(currentRestingHR(days), 52);
  assert.equal(currentRestingHR([]), 60); // HR_REST config fallback
});

test("restingHRAsOf: uses only the trailing 7 days through the workout date", () => {
  const days = parseRecoveryCsv(csvFor([
    { d: "2026-06-24", rhr: 70 }, // eight days before: outside the window
    { d: "2026-06-26", rhr: 50 },
    { d: "2026-06-30", rhr: 52 },
    { d: "2026-07-02", rhr: 54 }, // workout-day morning reading: eligible
    { d: "2026-07-03", rhr: 90 }, // future reading must never leak backward
  ]));
  assert.equal(restingHRAsOf("2026-07-02", days), 52);
});

test("restingHRAsOf: date-times use the athlete's local calendar date", () => {
  const days = parseRecoveryCsv(csvFor([
    { d: "2026-07-08", rhr: 48 },
    { d: "2026-07-09", rhr: 52 },
  ]));
  // Jul 8 at 8pm Pacific is Jul 9 UTC, but the Jul 9 morning reading is future data.
  assert.equal(restingHRAsOf(new Date("2026-07-09T03:00:00Z"), days), 48);
  assert.equal(restingHRAsOf("2026-01-01", days), 60); // no prior reading: config fallback
});
