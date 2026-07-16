// Flexible recovery ingestion: the HealthFit Google Sheet arrives with its own
// headers/order and reads as a markdown pipe table through the Drive connector.
// These tests pin the header-mapping, date/unit tolerance, and vo2max round-trip.
import test from "node:test";
import assert from "node:assert/strict";
import { parseFlexibleRecovery, parseRecoveryCsv, mergeRecoveryRows, writeRecoveryCsv } from "../lib/recovery";
import fs from "fs";
import path from "path";
import os from "os";

test("parses the HealthFit sheet markdown table (real header layout)", () => {
  const md = [
    "|  |  |  |  |  |  |  |  |  |",
    "| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |",
    "|  Date  |  Active Energy  |  Resting Energy  |  Resting  |  HRV  |  Steps  |  VO₂ max  |  Exercise Minutes  |  Stand Hours  |",
    "|  2026-07-01  |  650  |  1800  |  52  |  68  |  9500  |  53.2  |  45  |  12  |",
    "|  2026-07-02  |  720  |  1810  |  51 bpm  |  71 ms  |  11000  |    |  60  |  13  |",
  ].join("\n");
  const rows = parseFlexibleRecovery(md);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { date: "2026-07-01", hrv: 68, rhr: 52, sleepH: undefined, vo2max: 53.2 });
  assert.equal(rows[1].rhr, 51);   // unit suffix stripped
  assert.equal(rows[1].hrv, 71);
  assert.equal(rows[1].vo2max, undefined); // sparse metric, blank cell
});

test("CSV with US dates, sleep as h:mm and as '7h 24m'", () => {
  const csv = [
    "Date,Sleep,HRV,Resting",
    "07/01/2026,7:24,66,53",
    "07/02/2026,6h 30m,64,54",
    "07/03/2026,7.5,62,55",
  ].join("\n");
  const rows = parseFlexibleRecovery(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, "2026-07-01");
  assert.equal(rows[0].sleepH, 7.4);
  assert.equal(rows[1].sleepH, 6.5);
  assert.equal(rows[2].sleepH, 7.5);
});

test("rows with a date but no metrics are dropped; no date column → empty", () => {
  assert.equal(parseFlexibleRecovery("Date,HRV\n2026-07-01,\n").length, 0);
  assert.equal(parseFlexibleRecovery("HRV,Resting\n68,52\n").length, 0);
});

test("vo2max round-trips through write + parse and merges field-by-field", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recflex-"));
  const p = path.join(dir, "recovery.csv");
  const a = parseFlexibleRecovery("Date,HRV,Resting\n2026-07-01,68,52");
  const b = parseFlexibleRecovery("Date,VO₂ max\n2026-07-01,53.4");
  const merged = mergeRecoveryRows(a, b);
  assert.equal(merged[0].hrv, 68);      // kept from existing
  assert.equal(merged[0].vo2max, 53.4); // added by incoming
  writeRecoveryCsv(merged, p);
  const back = parseRecoveryCsv(fs.readFileSync(p, "utf-8"));
  assert.equal(back[0].vo2max, 53.4);
  assert.equal(back[0].rhr, 52);
});

test("recoveryDetail: last-n lines with mixed availability", async () => {
  const { recoveryDetail } = await import("../lib/recovery");
  const days = parseRecoveryCsv("date,hrv_ms,rhr_bpm,sleep_hours\n2026-07-01,68,52,7.2\n2026-07-02,,54,\n");
  const lines = recoveryDetail(days, 7);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /2026-07-01: HRV 68ms · RHR 52bpm · sleep 7.2h/);
  assert.match(lines[1], /2026-07-02: RHR 54bpm/);
});

test("vo2maxTrend: sparse readings, delta vs ~8wk baseline", async () => {
  const { vo2maxTrend } = await import("../lib/recovery");
  const csv = "date,hrv_ms,rhr_bpm,sleep_hours,vo2max\n" + [
    "2026-04-01,,,,45.0", "2026-05-01,,,,47.0", "2026-06-10,,,,48.7", "2026-06-24,,,,53.2",
  ].join("\n");
  const line = vo2maxTrend(parseRecoveryCsv(csv))!;
  assert.match(line, /06-24: 53.2/);
  assert.match(line, /\+8.2 vs 2026-04-01/);
  assert.equal(vo2maxTrend([]), null);
});

test("AUDIT FIX: partial later row for same date field-merges, doesn't wipe", () => {
  const days = parseRecoveryCsv("date,hrv_ms,rhr_bpm,sleep_hours\n2026-07-02,68,52,\n2026-07-02,,,7.4\n");
  assert.equal(days.length, 1);
  assert.equal(days[0].hrv, 68);   // preserved from the morning row
  assert.equal(days[0].sleepH, 7.4); // added by the evening row
});

test("AUDIT FIX: syncExternalRecovery persists field-level updates (same row count)", async () => {
  const { syncExternalRecovery } = await import("../lib/recovery");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recsync-"));
  const canonical = path.join(dir, "recovery.csv");
  const external = path.join(dir, "drop.csv");
  fs.writeFileSync(canonical, "date,hrv_ms,rhr_bpm,sleep_hours\n2026-07-02,68,52,\n");
  fs.writeFileSync(external, "2026-07-02,,,7.4\n"); // sleep arrives later, same date
  const changed = syncExternalRecovery([external], canonical);
  assert.equal(changed, 1); // content changed even though row count didn't
  const rows = parseRecoveryCsv(fs.readFileSync(canonical, "utf-8"));
  assert.equal(rows[0].sleepH, 7.4);
  assert.equal(rows[0].hrv, 68);
  assert.equal(syncExternalRecovery([external], canonical), 0); // idempotent
});

test("AUDIT FIX: fmtPace never emits :60 seconds", async () => {
  const { fmtPace } = await import("../lib/weeks");
  assert.equal(fmtPace(1609.344 / 479.6), "8:00/mi"); // was "7:60/mi"
  assert.equal(fmtPace(1609.344 / 480.4), "8:00/mi");
  assert.equal(fmtPace(1609.344 / 545), "9:05/mi");
});
