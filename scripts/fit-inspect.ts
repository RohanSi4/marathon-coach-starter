import fs from "fs";
import { decodeFit } from "../lib/fit/decode";
import { normalizeFit } from "../lib/fit/normalize";

// ─── fit-inspect ──────────────────────────────────────────────────────────────
// Dump one FIT file's raw decoded messages + our normalized read. The Phase-0
// verification tool: confirms HealthFit's actual field conventions (cadence units,
// where Apple running power lands, sub_sport codes) before trusting the importer.
//
// Usage: npm run fit-inspect <file.fit>

// Real HealthFit files carry BigInt fields (e.g. serialNumber) — JSON.stringify
// needs a replacer. (StoredActivity is unaffected: normalize only copies numbers.)
const safe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run fit-inspect <file.fit>");
    process.exit(1);
  }

  const buf = new Uint8Array(fs.readFileSync(file));
  const decoded = decodeFit(buf);
  if (!decoded.ok) {
    console.error(`Decode failed: ${decoded.reason}`);
    process.exit(1);
  }

  const m = decoded.messages;
  console.log("── Message counts ─────────────────────────────────────────");
  for (const [k, v] of Object.entries(m)) {
    if (Array.isArray(v) && v.length > 0) console.log(`  ${k}: ${v.length}`);
  }

  console.log("\n── Session (first) ────────────────────────────────────────");
  console.log(JSON.stringify(m.sessionMesgs?.[0] ?? null, safe, 2));

  console.log("\n── Records (first 3) ──────────────────────────────────────");
  (m.recordMesgs ?? []).slice(0, 3).forEach((r, i) =>
    console.log(`  [${i}]`, JSON.stringify(r, safe)));

  console.log("\n── Laps (first 2) ─────────────────────────────────────────");
  (m.lapMesgs ?? []).slice(0, 2).forEach((l, i) =>
    console.log(`  [${i}]`, JSON.stringify(l, safe)));

  if (decoded.warnings.length > 0) {
    console.log("\n── Decoder warnings ───────────────────────────────────────");
    decoded.warnings.forEach(w => console.log(`  ${w}`));
  }

  console.log("\n── Normalized (our read) ──────────────────────────────────");
  const a = normalizeFit(m, file);
  if (!a) {
    console.log("  (no session — not normalizable)");
    return;
  }
  const { splits, hrZones, ...rest } = a;
  console.log(JSON.stringify(rest, safe, 2));
  if (splits) {
    console.log("  Splits:", splits.map(s => `M${s.mile}:${s.pace}${s.avgHR ? `@${s.avgHR}` : ""}`).join(" "));
  }
  if (hrZones) {
    console.log("  Zones:", hrZones.map(z => `Z${z.zone}:${Math.round(z.seconds / 60)}min`).join(" "));
  }
}

main();
