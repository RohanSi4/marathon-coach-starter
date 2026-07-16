// ─── npm run zones — evidence-based zone audit ────────────────────────────────
// Re-derives LT1/LT2/max-HR from the stored archive and compares them against the
// zone boundaries currently configured in lib/config.ts (HR_ZONE_BOUNDS × MAX_HR).
// Run every 4-6 weeks, or after any benchmark race/TT: if measured anchors have
// drifted >3 bpm from the configured lines, it prints the exact bounds to paste.
// Informational only — never edits config.
import "dotenv/config";
import { loadActivities } from "../lib/store";
import { MAX_HR, HR_ZONE_BOUNDS } from "../lib/config";
import {
  decouplingObservations,
  estimateLt1,
  bestSustained,
  maxHrObservations,
  H10_SINCE,
} from "../lib/zones";

const DAYS = Number(process.env.ZONES_WINDOW_DAYS ?? 120); // LT1 uses recent runs only
const sinceIso = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

const all = loadActivities();
const zoneBpm = HR_ZONE_BOUNDS.map((f) => Math.round(f * MAX_HR)); // [z1top, z2top, z3top, z4top]

console.log("════════════════════════════════════════════════════════════");
console.log("  ZONE AUDIT — measured anchors vs configured bounds");
console.log(`  Config: MAX_HR ${MAX_HR} (estimated) → Z1<${zoneBpm[0]} Z2 ${zoneBpm[0]}-${zoneBpm[1]} Z3 ${zoneBpm[1]}-${zoneBpm[2]} Z4 ${zoneBpm[2]}-${zoneBpm[3]} Z5 ${zoneBpm[3]}+`);
console.log("════════════════════════════════════════════════════════════\n");

// 1) Max HR credibility
console.log(`MAX HR — top observations (H10 chest strap since ${H10_SINCE}; earlier = wrist-optical, distrust lone spikes):`);
for (const o of maxHrObservations(all)) {
  console.log(`  ${o.maxHR} bpm  ${o.date}  ${o.type}${o.h10Era ? "  [H10 ✓]" : ""}`);
}
console.log(`  READ: config MAX_HR ${MAX_HR} should sit at/just above the credible cluster. A true race/TT max supersedes all of this.\n`);

// 2) LT1 from decoupling (recent, steady runs ≥40min)
const obs = decouplingObservations(all, { sinceIso });
const lt1 = estimateLt1(obs);
console.log(`LT1 (aerobic threshold / top of Z2) — decoupling vs avg HR, steady runs ≥40min, last ${DAYS}d:`);
for (const o of lt1.observations) {
  const tag = o.decouplingPct < 5 ? "coupled" : o.decouplingPct <= 8 ? "border " : "DECOUPLED";
  console.log(`  ${o.date}  avgHR ${o.avgHR}  ${o.decouplingPct >= 0 ? "+" : ""}${o.decouplingPct.toFixed(1)}%  ${o.miles}mi  ${tag}`);
}
if (lt1.lt1 != null) {
  console.log(`  → LT1 ≈ ${lt1.lt1} bpm (coupled up to ${lt1.highestCoupled!.avgHR}, decoupled at ${lt1.lowestDecoupled!.avgHR}). Config Z2 top: ${zoneBpm[1]} (drift ${lt1.lt1 - zoneBpm[1] >= 0 ? "+" : ""}${lt1.lt1 - zoneBpm[1]} bpm).`);
} else if (lt1.highestCoupled) {
  console.log(`  → LT1 ≥ ${lt1.highestCoupled.avgHR} bpm (still coupled there; nothing steady has decoupled above it — bounded from below only). Config Z2 top: ${zoneBpm[1]}.`);
} else {
  console.log("  → Not enough steady ≥40min runs with decoupling in the window.");
}
console.log();

// 3) LT2 floor from best sustained windows (all-time, dated so staleness is visible)
console.log("LT2 (lactate threshold / top of Z4) — best sustained time-weighted HR (all-time; date shows staleness):");
for (const w of [3, 5, 7, 9, 13]) {
  const b = bestSustained(all, w);
  if (b) console.log(`  ${w}mi (${b.minutes}min): ${b.avgHR} bpm  on ${b.date} (from mile ${b.fromMile})`);
}
console.log(`  READ: a HR held 45-120min sits BELOW true LT2; add ~3-6 bpm to the longest windows. Config Z4 top: ${zoneBpm[3]}.\n`);

console.log("If a measured anchor drifts >3 bpm from its configured line, update HR_ZONE_BOUNDS in lib/config.ts");
console.log(`(fractions of MAX_HR ${MAX_HR}: bound = bpm / ${MAX_HR}) and document the evidence in the comment. A 5K TT that`);
console.log("records a true max re-keys everything — update MAX_HR first, then re-run this audit.");
