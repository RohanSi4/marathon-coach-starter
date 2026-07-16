import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { RUN_TYPES } from "../lib/weeks";
import { SHOE_PERIODS, SHOE_LIFETIME_BASE_MILES, shoeForDate } from "../lib/config";
import { loadActivities } from "../lib/store";
import { loadNotes, noteDateKey } from "../lib/notes";

// ─── shoes ────────────────────────────────────────────────────────────────────
// Shoe mileage from the local store: each run maps to a shoe via the config
// date-range map (SHOE_PERIODS), with per-day `shoes:` overrides from data/notes.md.
// Lifetime totals = SHOE_LIFETIME_BASE_MILES (Strava-era odometer snapshot) + store
// miles. Foam degrades over ~300-500mi — warn before running on dead cushioning.

function wearLabel(miles: number): string {
  if (miles >= 500) return "🔴 RETIRE — past 500mi, foam is done";
  if (miles >= 400) return "⚠ approaching retirement (400-500mi) — start shopping";
  if (miles >= 300) return "keep an eye on it (300-400mi)";
  return "✓ fresh";
}

function main() {
  const notes = loadNotes();
  const runs = loadActivities().filter(a => RUN_TYPES.includes(a.type));

  const miles = new Map<string, number>();
  for (const [name, base] of Object.entries(SHOE_LIFETIME_BASE_MILES)) miles.set(name, base);

  let unattributed = 0;
  for (const r of runs) {
    const d = new Date(r.start_date);
    const shoe = notes.get(noteDateKey(d))?.shoes ?? shoeForDate(d);
    if (!shoe) { unattributed += r.distance / 1609.344; continue; }
    miles.set(shoe, (miles.get(shoe) ?? 0) + r.distance / 1609.344);
  }

  if (miles.size === 0) {
    console.log("No shoes configured — add SHOE_PERIODS entries in lib/config.ts.");
    return;
  }

  const sorted = [...miles.entries()].sort(([, a], [, b]) => b - a);
  const nameWidth = Math.min(28, Math.max(...sorted.map(([n]) => n.length)));

  console.log("── Shoe Mileage (store + Strava-era baseline) ─────────────────────");
  for (const [name, mi] of sorted) {
    const label = name.slice(0, nameWidth).padEnd(nameWidth);
    console.log(`  ${label}  ${`${mi.toFixed(1)}mi`.padStart(8)}  ${wearLabel(mi)}`);
  }
  if (unattributed > 0.1) {
    console.log(`  ${"(no shoe attributed)".padEnd(nameWidth)}  ${`${unattributed.toFixed(1)}mi`.padStart(8)}  — extend SHOE_PERIODS`);
  }
  console.log("───────────────────────────────────────────────────────────────────");
  console.log("  Tip: rotate 2+ pairs to spread load; replace trainers ~400-500mi.");
  console.log(`  Config: ${SHOE_PERIODS.map(p => `${p.name} (from ${p.from}${p.to ? ` to ${p.to}` : ""})`).join(" · ")}`);
}

main();
