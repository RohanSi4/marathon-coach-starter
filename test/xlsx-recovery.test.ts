import { test } from "node:test";
import assert from "node:assert";
import { readXlsx, serialToISODate } from "../lib/xlsx-lite";
import { parseHealthFitXlsx, mergeRecoveryRows, type RecoveryDay } from "../lib/recovery";

// ─── synthetic xlsx builder (stored zip, no deps) ──────────────────────────────
// Enough of a real workbook to exercise the reader: workbook + rels + two
// worksheets, strings inline, dates as Excel serials — the shape HealthFit's
// Google-Sheet export actually has.

function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: Array<[name: string, content: string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameB = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 8);  // method 0 = stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    locals.push(local, nameB, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameB.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

type Cell = string | number | null;
function sheetXml(rows: Cell[][]): string {
  const colRef = (i: number) => {
    let s = "";
    for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
    return s;
  };
  const body = rows
    .map((cells, r) => {
      const cs = cells
        .map((v, c) => {
          if (v == null) return "";
          const ref = `${colRef(c)}${r + 1}`;
          if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join("");
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function buildWorkbook(daily: Cell[][], sleep: Cell[][]): Buffer {
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Daily Metrics" sheetId="1" r:id="rId1"/><sheet name="Sleep" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="w" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="w" Target="worksheets/sheet2.xml"/></Relationships>`;
  return buildZip([
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", rels],
    ["xl/worksheets/sheet1.xml", sheetXml(daily)],
    ["xl/worksheets/sheet2.xml", sheetXml(sleep)],
  ]);
}

const DAILY_HDR: Cell[] = [" Date ", " Active Energy ", " Resting ", " HRV ", " VO₂ max "];
const SLEEP_HDR: Cell[] = [" Date ", " Main ", " Start ", " End ", " InBed ", " Asleep "];
// 46208 = 2026-07-05, 46209 = 2026-07-06 (Excel serial, 1899-12-30 epoch)
const S_JUL5 = 46208, S_JUL6 = 46209;

// ─── tests ─────────────────────────────────────────────────────────────────────

test("serialToISODate: unix epoch and a live date", () => {
  assert.equal(serialToISODate(25569), "1970-01-01");
  assert.equal(serialToISODate(S_JUL6), "2026-07-06");
  assert.equal(serialToISODate(S_JUL6 + 0.4629), "2026-07-06"); // time-of-day fraction dropped
});

test("readXlsx resolves sheet names, inline strings, and numeric cells", () => {
  const buf = buildWorkbook([DAILY_HDR, [S_JUL5, 1316, 47, 118.75, null]], [SLEEP_HDR]);
  const sheets = readXlsx(buf);
  assert.deepEqual(sheets.map(s => s.name), ["Daily Metrics", "Sleep"]);
  assert.equal(sheets[0].rows[0][2].trim(), "Resting");
  assert.equal(sheets[0].rows[1][0], "46208");
});

test("daily metrics: serial dates, precision normalization, unit suffixes", () => {
  const buf = buildWorkbook(
    [DAILY_HDR, [S_JUL5, 1316, "47 bpm", 118.74663135604887, null], [S_JUL6, 999, 55, 148.66089637427143, 53.24123]],
    [SLEEP_HDR]
  );
  const days = parseHealthFitXlsx(buf);
  assert.deepEqual(days, [
    { date: "2026-07-05", hrv: 119, rhr: 47, vo2max: undefined, sleepH: undefined },
    { date: "2026-07-06", hrv: 149, rhr: 55, vo2max: 53.2, sleepH: undefined },
  ]);
});

test("sleep: Main=1 only, wake-date mapping, Asleep×24 to one decimal", () => {
  const buf = buildWorkbook(
    [DAILY_HDR],
    [
      SLEEP_HDR,
      [S_JUL5, 1, 0.0888, 0.4629, 0.374, 0.36991932164325764], // main night → 8.9h on 7/05
      [S_JUL5, 0, 0.6, 0.65, 0.05, 0.045], // nap (Main=0) — excluded
      [S_JUL6, 1, 0.973, 0.318, 0.36, 0.343], // crosses midnight; still keyed to wake date 7/06
    ]
  );
  const days = parseHealthFitXlsx(buf);
  assert.deepEqual(days.map(d => [d.date, d.sleepH]), [["2026-07-05", 8.9], ["2026-07-06", 8.2]]);
});

test("duplicate rows: identical daily dupes collapse; longest main sleep wins", () => {
  const buf = buildWorkbook(
    [DAILY_HDR, [S_JUL5, 1, 47, 119, null], [S_JUL5, 1, 47, 119, null]],
    [SLEEP_HDR, [S_JUL5, 1, 0, 0, 0.1, 0.08], [S_JUL5, 1, 0, 0, 0.38, 0.37]] // fragment then real night
  );
  const days = parseHealthFitXlsx(buf);
  assert.equal(days.length, 1);
  assert.equal(days[0].sleepH, 8.9); // 0.37×24, not the 1.9h fragment
});

test("merge is idempotent and empty cells never clobber existing values", () => {
  const existing: RecoveryDay[] = [{ date: "2026-07-05", hrv: 200, rhr: 50, sleepH: 7.0 }];
  // xlsx row for the same date has HRV but NO Resting cell
  const buf = buildWorkbook([DAILY_HDR, [S_JUL5, 1316, null, 118.7, null]], [SLEEP_HDR]);
  const incoming = parseHealthFitXlsx(buf);
  const once = mergeRecoveryRows(existing, incoming);
  assert.equal(once[0].hrv, 119); // incoming wins where present
  assert.equal(once[0].rhr, 50); // empty cell did NOT clobber
  assert.equal(once[0].sleepH, 7.0); // absent sleep did NOT clobber
  const twice = mergeRecoveryRows(once, incoming);
  assert.deepEqual(twice, once); // idempotent
});
