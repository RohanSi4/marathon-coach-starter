// ─── xlsx-lite: minimal .xlsx reader (zero dependencies) ──────────────────────
// Just enough OOXML to read the HealthFit "Health Metrics" workbook: sheet
// names → cell grids, shared strings resolved, numbers (incl. Excel serial
// dates) returned as their raw strings for the caller to interpret. Not a
// general xlsx library — no styles, formulas, merged cells, or zip64.
import { inflateRawSync } from "zlib";

export interface XlsxSheet {
  name: string;
  rows: string[][]; // dense per-row grids; missing cells are ""
}

// ── zip container ──────────────────────────────────────────────────────────────
// Entries are located via the End-Of-Central-Directory record (scanned backward
// past any archive comment), then the central directory. Method 0 = stored,
// method 8 = raw deflate — the only two the format allows.
function zipEntries(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  const scanFloor = Math.max(0, buf.length - 65557); // max comment 65535 + EOCD 22
  for (let i = buf.length - 22; i >= scanFloor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("xlsx-lite: not a zip (no end-of-central-directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("xlsx-lite: bad central-directory entry");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);

    // Local header repeats name/extra lengths — data sits after ITS lengths,
    // which can differ from the central copy.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));

    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── narrow XML helpers (regex-scoped; fine for OOXML's machine-written files) ──
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : undefined;
}

// Concatenated text of all <t> runs inside one <si>/<is> block.
function textRuns(block: string): string {
  let out = "";
  for (const m of block.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeEntities(m[1]);
  return out;
}

function colToIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch < "A" || ch > "Z") break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

// ── workbook assembly ──────────────────────────────────────────────────────────
export function readXlsx(buf: Buffer): XlsxSheet[] {
  const files = zipEntries(buf);
  const get = (p: string) => files.get(p)?.toString("utf8");

  const workbook = get("xl/workbook.xml");
  const rels = get("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("xlsx-lite: missing workbook.xml or its rels");

  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attr(m[0], "Id");
    let target = attr(m[0], "Target");
    if (!id || !target) continue;
    target = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    relTarget.set(id, target);
  }

  const shared: string[] = [];
  const sst = get("xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1]));

  const sheets: XlsxSheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(m[0], "name");
    const rid = attr(m[0], "id"); // matches r:id via the ns-tolerant attr()
    const path = rid ? relTarget.get(rid) : undefined;
    const xml = path ? get(path) : undefined;
    if (!name || !xml) continue;
    sheets.push({ name, rows: parseSheet(xml, shared) });
  }
  return sheets;
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    // Self-closing <c .../> (empty cell) or <c ...>...</c>
    for (const c of rowMatch[1].matchAll(/<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = c[1] ?? c[2] ?? "";
      const body = c[3] ?? "";
      const ref = attr(`<c ${attrs}>`, "r") ?? "";
      const idx = ref ? colToIndex(ref) : cells.length;
      const type = attr(`<c ${attrs}>`, "t");
      let value = "";
      if (type === "inlineStr") {
        value = textRuns(body);
      } else {
        const v = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
        value = v ? decodeEntities(v[1]) : "";
        if (type === "s") value = shared[parseInt(value, 10)] ?? "";
      }
      while (cells.length < idx) cells.push("");
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

// Excel serial date (epoch 1899-12-30, the standard 1900 system as written by
// Google Sheets / HealthFit) → YYYY-MM-DD in UTC.
export function serialToISODate(serial: number): string {
  const days = Math.floor(serial + 1e-7); // drop any time-of-day fraction
  const ms = (days - 25569) * 86400000; // 25569 = 1970-01-01
  return new Date(ms).toISOString().slice(0, 10);
}
