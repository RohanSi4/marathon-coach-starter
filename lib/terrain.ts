// ─── Hill exposure ────────────────────────────────────────────────────────────
// If the goal race has hills, the plan needs a way to PROVE the athlete has been
// running them. Elevation is stored per run and printed per run, but without
// aggregation a build can drift onto flat ground for months and nothing says so —
// the classic version being long runs that get longer and flatter at the same time,
// with treadmill miles contributing a structural zero on top.
//
// The unit is FEET OF CLIMB PER MILE, which is comparable across run lengths in a
// way that total gain is not — a flat 14-miler out-climbs a hilly 3-miler on
// total feet while being the less specific run.
import type { StoredActivity } from "./types";
import { isTreadmillActivity } from "./config";
import { weekKey, RUN_TYPES } from "./weeks";
import { noteDateKey } from "./notes";

const MILE_M = 1609.344;
const M_TO_FT = 3.28084;

// EDIT ME during onboarding: set these from the GOAL RACE's actual profile. A
// rolling road marathon runs roughly 40-50 ft/mi of climb, so 40 is a reasonable
// default for "genuinely course-specific"; below ~20 ft/mi is flat ground
// regardless of what the neighbourhood feels like underfoot. If the goal race is
// flat, this whole module is informational rather than a requirement.
export const HILLY_FT_PER_MI = 40;
export const FLAT_FT_PER_MI = 20;
// The long-run threshold the course requirement is really about.
export const LONG_RUN_MILES = 8;
// Hill-specific fitness (eccentric quad tolerance on the downs, most of all) decays
// on this order. Past it, a met requirement is a historical fact, not current fitness.
export const STALE_HILL_DAYS = 28;

const round1 = (n: number): number => parseFloat(n.toFixed(1));

export interface TerrainRun {
  date: string;
  miles: number;
  climbFt: number;
  ftPerMile: number;
  treadmill: boolean;
}

export function terrainRuns(activities: StoredActivity[]): TerrainRun[] {
  const out: TerrainRun[] = [];
  for (const a of activities) {
    if (!RUN_TYPES.includes(a.type)) continue;
    const miles = a.distance / MILE_M;
    if (miles < 1) continue;
    const climbFt = (a.total_elevation_gain ?? 0) * M_TO_FT;
    out.push({
      date: noteDateKey(new Date(a.start_date)),
      miles: round1(miles),
      climbFt: Math.round(climbFt),
      ftPerMile: round1(climbFt / miles),
      treadmill: isTreadmillActivity(a),
    });
  }
  return out;
}

export interface TerrainWeek {
  weekStarting: string;
  miles: number;
  climbFt: number;
  ftPerMile: number;
  hillyLongRuns: number;
}

export function weeklyTerrain(activities: StoredActivity[]): TerrainWeek[] {
  const byWeek = new Map<string, { miles: number; climbFt: number; hilly: number }>();
  for (const a of activities) {
    if (!RUN_TYPES.includes(a.type)) continue;
    const miles = a.distance / MILE_M;
    if (miles < 1) continue;
    // A treadmill contributes ZERO climb even when it reports ascent. The Jul 2
    // 2026 incline session recorded 128m (420ft) and, before this, that landed in
    // the weekly hill total as though he had run a hilly route — the exact claim
    // the header makes and the block existed to disprove. Belt incline is real work
    // for the calves but it is not course specificity: no descent, no eccentric
    // loading, no camber. The MILES still count, because diluting ft/mi with flat
    // indoor mileage is precisely the signal this rule wants to surface.
    const treadmill = isTreadmillActivity(a);
    const climbFt = treadmill ? 0 : (a.total_elevation_gain ?? 0) * M_TO_FT;
    const k = weekKey(new Date(a.start_date));
    const acc = byWeek.get(k) ?? { miles: 0, climbFt: 0, hilly: 0 };
    acc.miles += miles;
    acc.climbFt += climbFt;
    // …and an indoor run can never satisfy the course requirement, however steep
    // the belt was set.
    if (!treadmill && miles >= LONG_RUN_MILES && climbFt / miles >= HILLY_FT_PER_MI) acc.hilly++;
    byWeek.set(k, acc);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
    .map(([weekStarting, v]) => ({
      weekStarting,
      miles: round1(v.miles),
      climbFt: Math.round(v.climbFt),
      ftPerMile: v.miles > 0 ? round1(v.climbFt / v.miles) : 0,
      hillyLongRuns: v.hilly,
    }));
}

export function formatTerrainBlock(
  activities: StoredActivity[],
  recent = 8,
  now: Date = new Date(),
): string {
  const weeks = weeklyTerrain(activities);
  const head =
    `HILL EXPOSURE (ft of climb per mile — goal-race target ~${HILLY_FT_PER_MI}+ ft/mi):\n` +
    `  CLAUDE.md requires hill work in Phase 2-3 and ≥2 LONG runs (≥${LONG_RUN_MILES}mi) on hilly\n` +
    `  courses. Treadmill miles contribute a structural ZERO — that is the point of the rule.`;
  if (weeks.length === 0) return head + "\n  No runs stored yet.";

  const rows = weeks.slice(-recent).map((w) => {
    const verdict =
      w.ftPerMile >= HILLY_FT_PER_MI ? "hilly" : w.ftPerMile >= FLAT_FT_PER_MI ? "rolling" : "FLAT";
    const hl = w.hillyLongRuns > 0 ? `  ✓ ${w.hillyLongRuns} hilly long run${w.hillyLongRuns > 1 ? "s" : ""}` : "";
    return `  ${w.weekStarting.padEnd(14)} ${String(w.miles).padStart(5)}mi  ${String(w.climbFt).padStart(5)}ft  ` +
      `${String(w.ftPerMile).padStart(5)} ft/mi  ${verdict}${hl}`;
  });

  // The course requirement is cumulative over the build, not weekly.
  const runs = terrainRuns(activities);
  const longRuns = runs.filter((r) => r.miles >= LONG_RUN_MILES);
  const hillyLong = longRuns.filter((r) => r.ftPerMile >= HILLY_FT_PER_MI);
  const last4 = weeks.slice(-4);
  const m4 = last4.reduce((s, w) => s + w.miles, 0);
  const c4 = last4.reduce((s, w) => s + w.climbFt, 0);

  const lines = [
    `  COURSE REQUIREMENT: ${hillyLong.length} of ${longRuns.length} long runs have been on hilly ground (need ≥2 by race).` +
      (hillyLong.length >= 2
        ? " ✓ count met."
        : " ✗ NOT MET — this is a named requirement, not a nice-to-have."),
    `  TRAILING 4WK: ${round1(m4)}mi with ${Math.round(c4)}ft of climb = ${m4 > 0 ? round1(c4 / m4) : 0} ft/mi.`,
  ];
  // A satisfied COUNT is not satisfied exposure. Hill fitness decays, and the
  // requirement is a Phase 2-3 requirement — five hilly long runs in June do
  // nothing for a race in November if the last one was months ago.
  if (hillyLong.length > 0) {
    const last = hillyLong[hillyLong.length - 1];
    const ageDays = Math.round((now.getTime() - new Date(last.date).getTime()) / 86_400_000);
    lines.push(
      `  Most recent hilly long run: ${last.date} (${ageDays}d ago), ${last.miles}mi at ${last.ftPerMile} ft/mi.` +
        (ageDays > STALE_HILL_DAYS
          ? `  ⚠ STALE — over ${STALE_HILL_DAYS} days. The count is met on paper only; schedule one.`
          : ""),
    );
  }
  if (longRuns.length >= 2) {
    const first = longRuns[0];
    const last = longRuns[longRuns.length - 1];
    if (last.ftPerMile < first.ftPerMile * 0.75) {
      lines.push(
        `  ⚠ DRIFT: long-run climb rate has fallen ${first.ftPerMile} → ${last.ftPerMile} ft/mi as the runs got longer ` +
          "(flatter routes are easier to extend on). The race course does not get flatter — route the long run, don't just lengthen it.",
      );
    }
  }

  return `${head}\n${rows.join("\n")}\n${lines.join("\n")}`;
}
