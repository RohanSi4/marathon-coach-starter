// ─── FIT sport/subSport → our Strava-style activity type ─────────────────────
// The Garmin SDK decodes known enums to string names ("running", "treadmill",
// "strengthTraining"); unknown values arrive as raw numbers, so both are handled.
// The output vocabulary matches what the rest of the pipeline already classifies:
// RUN_TYPES, LIFT_TYPES ("WeightTraining"), and the "Workout" catch-all. Basketball
// gets its real name — an upgrade over Strava's opaque "Workout" — and still trips
// isHardCrossTraining (which only excludes runs + lifts).

const norm = (v: string | number | undefined): string => String(v ?? "generic");

export function mapSport(
  sport: string | number | undefined,
  subSport: string | number | undefined
): { type: string; trainer: boolean } {
  const s = norm(sport);
  const sub = norm(subSport);
  // HealthFit emits "indoorRunning" (sub_sport 45) for treadmill runs, not
  // "treadmill" (1) — verified against a real export Jul 2026. Accept both.
  const treadmill = sub === "treadmill" || sub === "1" || sub === "indoorRunning" || sub === "45";

  switch (s) {
    case "running": case "1":
      if (sub === "trail" || sub === "3") return { type: "TrailRun", trainer: false };
      return { type: "Run", trainer: treadmill };
    case "cycling": case "2":
      return { type: "Ride", trainer: sub === "indoorCycling" || sub === "6" };
    case "fitnessEquipment": case "4":
      if (sub === "elliptical" || sub === "15") return { type: "Elliptical", trainer: true };
      return { type: "Workout", trainer: true };
    case "swimming": case "5":
      return { type: "Swim", trainer: false };
    case "basketball": case "6":
      return { type: "Basketball", trainer: false };
    case "training": case "10":
      if (sub === "strengthTraining" || sub === "20") return { type: "WeightTraining", trainer: false };
      return { type: "Workout", trainer: false };
    case "walking": case "11":
      return { type: "Walk", trainer: treadmill };
    case "hiking": case "17":
      return { type: "Hike", trainer: false };
    case "golf": case "25":
      return { type: "Golf", trainer: false };
    default:
      return { type: "Workout", trainer: false };
  }
}
