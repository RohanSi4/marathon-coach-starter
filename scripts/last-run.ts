import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { RUN_TYPES, fmtPace } from "../lib/weeks";
import { AEROBIC_THRESHOLD_BPM, QUALITY_HR_BPM } from "../lib/config";
import { loadActivities } from "../lib/store";
import { loadNotes } from "../lib/notes";
import { summarize, annotateContinuations } from "../lib/summarize";
import { describeStrideBlips } from "../lib/fit/compute";

// ─── last-run ─────────────────────────────────────────────────────────────────
// Most recent run from the local FIT store: splits, HR analysis, easy-zone read.
// Offline — run `npm run import` first if the run just finished.

function main() {
  const runs = loadActivities().filter(a => RUN_TYPES.includes(a.type));
  if (runs.length === 0) {
    console.log("No runs in the store — run `npm run import` (and check HealthFit auto-export).");
    return;
  }
  // Summarize a small trailing window so a split recording (bathroom/water stop)
  // is recognized as a continuation of the previous leg, not its own session.
  const notes = loadNotes();
  const recent = runs.slice(-6).map(r => summarize(r, notes));
  annotateContinuations(recent);
  const s = recent[recent.length - 1];

  console.log(`\n── ${s.name} ──`);
  if (s.continuation) {
    console.log(`  ↳ CONTINUATION: this recording started ${s.continuation.gapMin}min after the previous run ended —`);
    console.log(`    one continuous session in ${s.continuation.leg} recordings, ${s.continuation.combinedMiles}mi combined (brief stop, not a separate run).`);
  }
  console.log(`  Date:       ${s.dayOfWeek}, ${s.date}`);
  console.log(`  Distance:   ${s.distanceMiles.toFixed(2)} mi`);
  console.log(`  Avg pace:   ${s.paceFormatted}`);
  console.log(`  Avg HR:     ${s.avgHR != null ? `${s.avgHR} bpm` : "N/A"}`);
  console.log(`  Max HR:     ${s.maxHR ?? "N/A"} bpm`);
  console.log(`  Elev gain:  ${s.elevationFt} ft`);
  console.log(`  Watts (wtd):${s.weightedWatts ?? "N/A"} W`);
  console.log(`  TRIMP:      ${s.sufferScore ?? "N/A"}`);
  if (s.notes) console.log(`  Notes:      ${s.notes}`);
  if (s.coachNotes) console.log(`  Coach ctx:  ${s.coachNotes}`);
  if (s.shoeName) console.log(`  Shoe:       ${s.shoeName}`);

  if (s.isTreadmill) {
    console.log(`  Treadmill/indoor: pace & distance are GymKit-accurate (belt speed) and HR is H10-accurate — trusted. Note: flat / wind-free / climate-controlled (no hill or heat stimulus).`);
  }

  const splits = s.splits ?? [];
  if (splits.length > 0) {
    console.log(`\n  Mile-by-mile splits:`);
    splits.forEach((sp, i) => {
      const hr = sp.avgHR ? ` | HR ${sp.avgHR}` : "";
      const elev = sp.elevFt != null && sp.elevFt !== 0
        ? ` | ${sp.elevFt > 0 ? "+" : ""}${sp.elevFt}ft`
        : "";
      const label = i + 1 < splits.length ? `Mile ${sp.mile}` : `Mile ${sp.mile} (partial)`;
      console.log(`    ${label}: ${sp.pace}${hr}${elev}`);
    });

    const hrValues = splits.filter(sp => sp.avgHR).map(sp => sp.avgHR!);
    if (hrValues.length > 1) {
      const drift = hrValues[hrValues.length - 1] - hrValues[0];
      const avgHR = Math.round(hrValues.reduce((a, b) => a + b, 0) / hrValues.length);
      const aet = AEROBIC_THRESHOLD_BPM;
      const delta = avgHR - aet;
      console.log(`\n  HR analysis:`);
      console.log(`    Avg HR across splits: ${avgHR} bpm (easy-run ceiling est. ~${aet} bpm; delta ${delta >= 0 ? "+" : ""}${delta})`);
      console.log(`    HR drift mile 1→last: ${drift > 0 ? "+" : ""}${drift} bpm`);
      if (avgHR > QUALITY_HR_BPM) {
        console.log(`    ⚠ Grey zone — avg HR ${avgHR} is ${delta} above the ~${aet} bpm easy ceiling. This was NOT an easy run.`);
        console.log(`      Easy = talk-test effort — hold HR 140-${aet}, let pace float (slower in heat).`);
      } else {
        console.log(`    ✓ Easy zone — well controlled, under the ~${aet} bpm ceiling. This is the habit.`);
      }
    }
  }

  if (s.strideBlips && s.strideBlips.length > 0) {
    console.log(`\n  Stride check: ${describeStrideBlips(s.strideBlips)}`);
    console.log(`    (short sharp HR spikes above the local baseline — the signature strides leave; mile splits average them away)`);
  }

  if (s.hrZones) {
    const total = s.hrZones.reduce((sum, z) => sum + z.seconds, 0);
    if (total > 0) {
      const zoneStr = s.hrZones
        .filter(z => z.seconds > 0)
        .map(z => `Z${z.zone}:${Math.round(z.seconds / 60)}min(${Math.round((z.seconds / total) * 100)}%)`)
        .join(" ");
      console.log(`\n  HR zones: ${zoneStr}`);
    }
  }
}

main();
