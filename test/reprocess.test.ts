// Reprocess: recomputing derived fields from a FIT via the importer's own
// normalize path must (a) be a no-op when nothing changed (roundtrip stability),
// (b) rewrite stale derived fields to match a fresh import, (c) never touch
// identity/enrichment fields, and (d) never select strava-era activities.
import test from "node:test";
import assert from "node:assert/strict";
import { Encoder, Profile } from "@garmin/fitsdk";
import { decodeFit } from "../lib/fit/decode";
import { normalizeFit } from "../lib/fit/normalize";
import { recomputeDerived, shouldReprocess, DERIVED_FIELDS } from "../scripts/reprocess";
import type { StoredActivity } from "../lib/types";

const MILE = 1609.344;
const START = new Date("2026-07-01T13:00:00Z");
const HR_REST_TEST = 55;
const RECOVERY_DAYS = [{ date: "2026-07-01", rhr: HR_REST_TEST }];

function makeRunFit(miles = 4, secPerMile = 563, hr = 137): Uint8Array {
  const encoder = new Encoder();
  const write = (m: Record<string, unknown>) => encoder.writeMesg(m as never);
  write({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "activity",
    manufacturer: "development",
    product: 0,
    timeCreated: START,
    serialNumber: 1234,
  });
  const totalSec = Math.round(miles * secPerMile);
  const speed = MILE / secPerMile;
  for (let s = 0; s <= totalSec; s += 1) {
    write({
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: new Date(START.getTime() + s * 1000),
      distance: s * speed,
      speed,
      heartRate: hr,
    });
  }
  write({
    mesgNum: Profile.MesgNum.SESSION,
    startTime: START,
    timestamp: new Date(START.getTime() + totalSec * 1000),
    sport: "running",
    subSport: "treadmill",
    totalElapsedTime: totalSec,
    totalTimerTime: totalSec,
    totalDistance: miles * MILE,
    avgHeartRate: hr,
    maxHeartRate: hr + 8,
    totalCalories: 400,
  });
  return encoder.close();
}

function importOnce(buf: Uint8Array): StoredActivity {
  const decoded = decodeFit(buf);
  assert.ok(decoded.ok, decoded.ok ? "" : decoded.reason);
  const a = normalizeFit(decoded.messages, "synthetic.fit", { hrRest: HR_REST_TEST })!;
  assert.ok(a);
  return a;
}

test("reprocess is a no-op when config and resting HR are unchanged (roundtrip stability)", () => {
  const buf = makeRunFit();
  const stored = importOnce(buf);
  const decoded = decodeFit(buf);
  assert.ok(decoded.ok);
  const result = recomputeDerived(stored, decoded.messages, RECOVERY_DAYS);
  assert.ok(!("error" in result));
  assert.deepEqual(result.changedFields, []);
  for (const f of DERIVED_FIELDS) {
    assert.deepEqual(result.updated[f], stored[f], `field ${f} must be identical`);
  }
});

test("stale derived fields are rewritten to match a fresh import", () => {
  const buf = makeRunFit();
  const stored = importOnce(buf);
  // Simulate an archive imported under OLD config: tamper the baked-in values the
  // way a bounds change would leave them stale.
  const stale: StoredActivity = {
    ...stored,
    trimp: (stored.trimp ?? 0) + 7,
    hrZones: stored.hrZones!.map(z => ({ ...z, seconds: z.seconds + 30 })),
  };
  const decoded = decodeFit(buf);
  assert.ok(decoded.ok);
  const result = recomputeDerived(stale, decoded.messages, RECOVERY_DAYS);
  assert.ok(!("error" in result));
  assert.ok(result.changedFields.includes("trimp"));
  assert.ok(result.changedFields.includes("hrZones"));
  assert.deepEqual(result.updated.trimp, stored.trimp);
  assert.deepEqual(result.updated.hrZones, stored.hrZones);
});

test("a different resting HR flows into TRIMP through the importer's own path", () => {
  const buf = makeRunFit();
  const stored = importOnce(buf);
  const decoded = decodeFit(buf);
  assert.ok(decoded.ok);
  const result = recomputeDerived(stored, decoded.messages, [{ date: "2026-07-01", rhr: HR_REST_TEST + 10 }]);
  assert.ok(!("error" in result));
  assert.ok(result.changedFields.includes("trimp"));
  assert.notEqual(result.updated.trimp, stored.trimp);
});

test("identity and enrichment fields are preserved exactly", () => {
  const buf = makeRunFit();
  const stored = importOnce(buf);
  // Fields set after import (Open-Meteo temp override, athlete-visible name) and
  // identity — none of these may move during reprocess.
  const enriched: StoredActivity = {
    ...stored,
    name: "Custom Run Name",
    average_temp: 31.5,
    trimp: (stored.trimp ?? 0) + 3, // make it actually rewrite something
  };
  const decoded = decodeFit(buf);
  assert.ok(decoded.ok);
  const result = recomputeDerived(enriched, decoded.messages, RECOVERY_DAYS);
  assert.ok(!("error" in result));
  assert.equal(result.updated.key, stored.key);
  assert.equal(result.updated.id, stored.id);
  assert.equal(result.updated.name, "Custom Run Name");
  assert.equal(result.updated.average_temp, 31.5);
  assert.equal(result.updated.sourceFile, "synthetic.fit");
  assert.equal(result.updated.start_date, stored.start_date);
});

test("strava-era and FIT-less activities are never selected for reprocess", () => {
  const buf = makeRunFit();
  const stored = importOnce(buf);
  assert.equal(shouldReprocess(stored), true);
  assert.equal(shouldReprocess({ ...stored, source: "strava" }), false);
  assert.equal(shouldReprocess({ ...stored, sourceFile: undefined }), false);
});

test("reprocess scores each historical activity with RHR available on its own date", () => {
  const buf = makeRunFit();
  const stored = importOnce(buf);
  const decoded = decodeFit(buf);
  assert.ok(decoded.ok);
  const recoveryDays = [
    { date: "2026-07-01", rhr: HR_REST_TEST },
    { date: "2026-07-02", rhr: HR_REST_TEST + 20 }, // future spike must not change Jul 1
  ];
  const result = recomputeDerived(stored, decoded.messages, recoveryDays);
  assert.ok(!("error" in result));
  assert.equal(result.updated.trimp, stored.trimp);
  assert.ok(!result.changedFields.includes("trimp"));
});
