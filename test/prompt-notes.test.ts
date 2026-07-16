import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../lib/summarize";
import { buildCoachingUserMessage } from "../lib/coach-prompt";
import type { ActivitySummary, StoredActivity } from "../lib/types";
import type { DayNote } from "../lib/notes";

const stored = (): StoredActivity => ({
  schemaVersion: 1,
  source: "fit",
  key: "2026-07-09T19:00:00.000Z_Run",
  id: 1,
  name: "Run",
  type: "Run",
  sport_type: "Run",
  start_date: "2026-07-09T19:00:00.000Z",
  distance: 5000,
  moving_time: 1800,
  elapsed_time: 1800,
  average_speed: 2.78,
  max_speed: 3,
  total_elevation_gain: 0,
  start_latlng: null,
});

test("summarize keeps athlete reports and coach context in separate fields", () => {
  const note: DayNote = {
    date: "2026-07-09",
    text: "knee felt fine; prescribe outdoor miles (coach-logged)",
    athleteText: "knee felt fine",
    coachText: "prescribe outdoor miles (coach-logged)",
  };
  const result = summarize(stored(), new Map([[note.date, note]]));
  assert.equal(result.notes, "knee felt fine");
  assert.equal(result.coachNotes, "prescribe outdoor miles (coach-logged)");
  assert.doesNotMatch(result.notes!, /prescribe/);
});

test("coaching prompt prints shared daily context once for multiple activities", () => {
  const base: ActivitySummary = {
    type: "Run",
    name: "Run",
    dayOfWeek: "Thursday",
    date: "Jul 9",
    distanceMiles: 3,
    durationFormatted: "30m",
    paceFormatted: "10:00/mi",
    elevationFt: 0,
    notes: "felt good",
    coachNotes: "keep it easy (coach-logged)",
  };
  const prompt = buildCoachingUserMessage(
    [base, { ...base, type: "WeightTraining", name: "Weight Training", distanceMiles: 0, paceFormatted: "N/A" }],
    null,
    null,
    new Date("2026-07-10T12:00:00-07:00"),
    null,
  );
  assert.equal(prompt.match(/Athlete note: "felt good"/g)?.length, 1);
  assert.equal(prompt.match(/Coach context: "keep it easy/g)?.length, 1);
});
