// Store semantics: deterministic filenames from dedupe keys, idempotent double-
// import, overwrite-on-reexport, chronological loads with a since filter.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  activityFilename,
  fingerprintSource,
  hasActivity,
  indexRecord,
  loadActivities,
  loadIndex,
  replaceActivity,
  saveActivity,
  saveIndex,
  shouldImportSource,
} from "../lib/store";
import type { StoredActivity } from "../lib/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));

function act(startISO: string, type = "Run", distance = 6437): StoredActivity {
  return {
    schemaVersion: 1, source: "fit", key: `${startISO}_${type}`,
    id: Math.floor(Date.parse(startISO) / 1000), name: type, type, sport_type: type,
    start_date: startISO, distance, moving_time: 2160, elapsed_time: 2200,
    average_speed: distance / 2160, max_speed: 4, total_elevation_gain: 10,
  };
}

test("filenames are filesystem-safe and chronological-sorting", () => {
  const f = activityFilename("2026-07-01T13:00:00.000Z_Run");
  assert.equal(f, "2026-07-01T130000Z_Run.json");
  assert.ok(!f.includes(":"));
});

test("save → load round-trips; since filter works; sorted output", () => {
  saveActivity(act("2026-07-01T13:00:00.000Z"), dir);
  saveActivity(act("2026-06-28T14:00:00.000Z"), dir);
  saveActivity(act("2026-07-02T02:00:00.000Z", "WeightTraining", 0), dir);

  const all = loadActivities(undefined, dir);
  assert.equal(all.length, 3);
  assert.equal(all[0].start_date, "2026-06-28T14:00:00.000Z"); // sorted

  const recent = loadActivities(Date.parse("2026-07-01T00:00:00Z") / 1000, dir);
  assert.equal(recent.length, 2);
});

test("re-import of the same key overwrites, not duplicates", () => {
  const a = act("2026-07-01T13:00:00.000Z");
  const first = saveActivity(a, dir);
  assert.equal(first.overwrote, true); // already saved above
  const edited = { ...a, distance: 7000 };
  saveActivity(edited, dir);
  const all = loadActivities(undefined, dir).filter(x => x.key === a.key);
  assert.equal(all.length, 1);
  assert.equal(all[0].distance, 7000);
});

test("hasActivity + import index round-trip", () => {
  assert.equal(hasActivity("2026-07-01T13:00:00.000Z_Run", dir), true);
  assert.equal(hasActivity("2020-01-01T00:00:00.000Z_Run", dir), false);
  saveIndex({ "workout.fit": "2026-07-01T13:00:00.000Z_Run" }, dir);
  assert.deepEqual(loadIndex(dir), { "workout.fit": "2026-07-01T13:00:00.000Z_Run" });
  // The index file must not be loaded as an activity.
  assert.equal(loadActivities(undefined, dir).every(a => a.key), true);
});

test("fingerprinted index records detect changed bytes while legacy records remain compatible", () => {
  const original = fingerprintSource(Buffer.from("fit-content-a"));
  const unchanged = fingerprintSource(Buffer.from("fit-content-a"));
  const changed = fingerprintSource(Buffer.from("fit-content-b"));
  const record = indexRecord("2026-07-01T13:00:00.000Z_Run", original);

  assert.equal(shouldImportSource(record, unchanged), false);
  assert.equal(shouldImportSource(record, changed), true);
  assert.equal(shouldImportSource("2026-07-01T13:00:00.000Z_Run", changed), false);
  assert.equal(shouldImportSource(undefined, changed), true);

  saveIndex({ "legacy.fit": "old-key", "fingerprinted.fit": record }, dir);
  assert.deepEqual(loadIndex(dir), { "legacy.fit": "old-key", "fingerprinted.fit": record });
});

test("same-key poorer re-export cannot erase richer stored data", () => {
  const start = "2026-07-04T13:00:00.000Z";
  const rich = {
    ...act(start),
    distance: 8000,
    start_latlng: [37.77, -122.42],
    average_heartrate: 151,
    splits: [{ mile: 1, pace: "8:00" }],
  };
  saveActivity(rich, dir);

  const result = saveActivity({ ...act(start), distance: 1000 }, dir);
  assert.equal(result.retainedExisting, true);
  assert.equal(result.overwrote, false);
  assert.equal(result.activity.distance, 8000);
  assert.deepEqual(result.activity.start_latlng, [37.77, -122.42]);

  const stored = loadActivities(undefined, dir).find(a => a.key === rich.key);
  assert.equal(stored?.distance, 8000);
  assert.deepEqual(stored?.start_latlng, [37.77, -122.42]);
});

test("equal-richness edits still overwrite values", () => {
  const start = "2026-07-05T13:00:00.000Z";
  const original = { ...act(start), average_heartrate: 150 };
  saveActivity(original, dir);
  const result = saveActivity({ ...original, distance: 9000, average_heartrate: 155 }, dir);
  assert.equal(result.retainedExisting, false);
  assert.equal(result.overwrote, true);
  assert.equal(result.activity.distance, 9000);
});

test("near-duplicate replacement is collision-safe for keys in the same second", () => {
  const old = act("2026-07-06T13:00:00.100Z");
  const replacement = {
    ...act("2026-07-06T13:00:00.900Z"),
    start_latlng: [37.77, -122.42],
  };
  assert.equal(activityFilename(old.key), activityFilename(replacement.key));
  saveActivity(old, dir);

  replaceActivity(old.key, replacement, dir);
  const matches = loadActivities(undefined, dir).filter(a => a.start_date.startsWith("2026-07-06T13:00:00"));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].key, replacement.key);
  assert.deepEqual(matches[0].start_latlng, [37.77, -122.42]);
});

test("failed replacement leaves the old activity intact", () => {
  const old = act("2026-07-07T13:00:00.000Z");
  saveActivity(old, dir);
  const invalid = act("2026-07-07T13:03:00.000Z") as StoredActivity & { cycle?: unknown };
  invalid.cycle = invalid;

  assert.throws(() => replaceActivity(old.key, invalid, dir));
  assert.equal(hasActivity(old.key, dir), true);
  assert.equal(loadActivities(undefined, dir).some(a => a.key === old.key), true);
});
