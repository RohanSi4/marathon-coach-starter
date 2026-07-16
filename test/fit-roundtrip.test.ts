// Round-trip: encode a synthetic activity with the official SDK's Encoder, then run
// it through OUR decode → normalize pipeline. Exercises decodeFit (incl. CRC) and
// normalizeFit end-to-end without waiting on real HealthFit fixtures. Real fixtures
// from Phase 0 additionally pin HealthFit's field conventions (cadence units, power
// placement) in fit-normalize.test.ts once captured.
import test from "node:test";
import assert from "node:assert/strict";
import { Encoder, Profile } from "@garmin/fitsdk";
import { decodeFit } from "../lib/fit/decode";
import { normalizeFit } from "../lib/fit/normalize";

const MILE = 1609.344;
const START = new Date("2026-07-01T13:00:00Z");

function makeFit(opts: {
  sport: string; subSport?: string;
  miles?: number; secPerMile?: number; hr?: number; gps?: boolean;
}): Uint8Array {
  const encoder = new Encoder();
  // The SDK's Encodable<Mesg> type doesn't model per-message fields — cast through
  // a loose writer; the decoder round-trip is what validates correctness here.
  const write = (m: Record<string, unknown>) => encoder.writeMesg(m as never);
  write({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "activity",
    manufacturer: "development",
    product: 0,
    timeCreated: START,
    serialNumber: 1234,
  });

  const miles = opts.miles ?? 0;
  const secPerMile = opts.secPerMile ?? 540;
  const totalSec = miles > 0 ? Math.round(miles * secPerMile) : 1800;
  const speed = miles > 0 ? MILE / secPerMile : 0;

  for (let s = 0; s <= totalSec; s += 1) {
    write({
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: new Date(START.getTime() + s * 1000),
      ...(miles > 0 ? { distance: s * speed, speed } : {}),
      ...(opts.hr != null ? { heartRate: opts.hr } : {}),
      ...(opts.gps ? {
        positionLat: Math.round(37.33 / (180 / 2 ** 31)),
        positionLong: Math.round(-121.89 / (180 / 2 ** 31)),
      } : {}),
    });
  }

  write({
    mesgNum: Profile.MesgNum.SESSION,
    startTime: START,
    timestamp: new Date(START.getTime() + totalSec * 1000),
    sport: opts.sport,
    subSport: opts.subSport ?? "generic",
    totalElapsedTime: totalSec,
    totalTimerTime: totalSec,
    totalDistance: miles * MILE,
    avgHeartRate: opts.hr,
    maxHeartRate: opts.hr != null ? opts.hr + 8 : undefined,
    totalCalories: 400,
  });

  return encoder.close();
}

test("treadmill run round-trips: type, trainer, distance, splits, TRIMP", () => {
  const buf = makeFit({ sport: "running", subSport: "treadmill", miles: 4, secPerMile: 563, hr: 137 });
  const decoded = decodeFit(buf);
  assert.ok(decoded.ok, decoded.ok ? "" : decoded.reason);
  const a = normalizeFit(decoded.messages, "synthetic.fit")!;

  assert.equal(a.type, "Run");
  assert.equal(a.trainer, true);
  assert.equal(a.start_latlng, null);
  assert.ok(Math.abs(a.distance - 4 * MILE) < 2);
  assert.equal(a.average_heartrate, 137);
  assert.equal(a.start_date, START.toISOString());
  assert.equal(a.key, `${START.toISOString()}_Run`);
  assert.equal(a.splits!.length, 4);
  assert.equal(a.splits![0].pace, "9:23/mi");
  assert.ok(a.trimp! > 0);
  assert.equal(a.hrZones!.length, 5);
});

test("outdoor run carries GPS start_latlng in degrees", () => {
  const buf = makeFit({ sport: "running", miles: 1, hr: 145, gps: true });
  const decoded = decodeFit(buf);
  assert.ok(decoded.ok);
  const a = normalizeFit(decoded.messages)!;
  assert.ok(a.start_latlng);
  assert.ok(Math.abs(a.start_latlng![0] - 37.33) < 0.001);
  assert.ok(Math.abs(a.start_latlng![1] - -121.89) < 0.001);
});

test("strength workout maps to WeightTraining with HR but no splits", () => {
  const buf = makeFit({ sport: "training", subSport: "strengthTraining", hr: 105 });
  const decoded = decodeFit(buf);
  assert.ok(decoded.ok);
  const a = normalizeFit(decoded.messages)!;
  assert.equal(a.type, "WeightTraining");
  assert.equal(a.splits, undefined);
  assert.equal(a.average_heartrate, 105);
  assert.ok(a.trimp! > 0);
});

test("corrupted file fails CRC and is rejected, not ingested", () => {
  const buf = makeFit({ sport: "running", miles: 1, hr: 140 });
  const corrupted = buf.slice(0, buf.length - 40); // truncate: CRC + tail gone
  const decoded = decodeFit(corrupted);
  assert.equal(decoded.ok, false);
});

test("random bytes are rejected as not-a-FIT", () => {
  const junk = new Uint8Array(256).fill(7);
  const decoded = decodeFit(junk);
  assert.equal(decoded.ok, false);
});
