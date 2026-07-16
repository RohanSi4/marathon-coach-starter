// Weather enrichment: hour matching, caching (never refetch a known hour), and
// graceful degradation on API failure — temperature must never break an import.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { pickHourTemp, temperatureAt } from "../lib/weather";

test("pickHourTemp picks the closest hour and rejects far-away matches", () => {
  const times = ["2026-07-01T12:00", "2026-07-01T13:00", "2026-07-01T14:00"];
  const temps = [20.1, 24.4, 27.9];
  assert.equal(pickHourTemp(times, temps, "2026-07-01T13:20:00Z"), 24.4);
  assert.equal(pickHourTemp(times, temps, "2026-07-01T23:00:00Z"), undefined); // >90min gap
  assert.equal(pickHourTemp(times, [null, 24.4, null], "2026-07-01T12:01:00Z"), 24.4); // skips nulls
});

test("temperatureAt fetches once, caches, and reuses the cache", async () => {
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wx-")), "cache.json");
  let calls = 0;
  const fake = async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({ hourly: { time: ["2026-07-01T13:00"], temperature_2m: [25.5] } }),
    };
  };
  const when = new Date("2026-07-01T13:10:00Z");
  assert.equal(await temperatureAt(37.33, -121.89, when, fake, cachePath), 25.5);
  assert.equal(await temperatureAt(37.33, -121.89, when, fake, cachePath), 25.5);
  assert.equal(calls, 1); // second hit came from the cache
});

test("API failure degrades to undefined, never throws", async () => {
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wx-")), "cache.json");
  const boom = async () => { throw new Error("network down"); };
  assert.equal(await temperatureAt(37.33, -121.89, new Date(), boom, cachePath), undefined);
  const notOk = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await temperatureAt(37.33, -121.89, new Date(), notOk, cachePath), undefined);
});
