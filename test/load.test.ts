import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyLoadSeries, monotonyStrain, computePMC } from "../lib/load";
import type { StoredActivity } from "../lib/types";
import type { DailyLoad as DL } from "../lib/load";

const act = (date: string, trimp: number): StoredActivity =>
  ({ schemaVersion: 1, source: "fit", sourceFile: "x", key: date, id: "i",
     name: "Run", type: "Run", sport_type: "Run",
     start_date: `${date}T18:00:00.000Z`, distance: 8000, moving_time: 2400,
     elapsed_time: 2400, average_speed: 3, trimp }) as unknown as StoredActivity;

test("dailyLoadSeries zero-fills rest days between activities", () => {
  const s = dailyLoadSeries([act("2026-07-01", 40), act("2026-07-04", 60)]);
  assert.equal(s.length, 4); // Jul 1,2,3,4
  assert.deepEqual(s.map((d) => d.trimp), [40, 0, 0, 60]);
});

test("dailyLoadSeries sums multiple activities on one day", () => {
  const s = dailyLoadSeries([act("2026-07-01", 40), act("2026-07-01", 20)]);
  assert.equal(s[0].trimp, 60);
});

test("monotony is HIGH when every day carries the same load (no hard-easy separation)", () => {
  const flat: DL[] = Array.from({ length: 7 }, (_, i) => ({ date: `2026-07-0${i + 1}`, trimp: 50 }));
  const ms = monotonyStrain(flat)!;
  assert.ok(ms.monotony >= 2.0, `expected high, got ${ms.monotony}`);
  assert.match(ms.status, /HIGH/);
});

test("monotony is healthy with real hard-easy variance (rest days present)", () => {
  const varied: DL[] = [
    { date: "2026-07-01", trimp: 40 }, { date: "2026-07-02", trimp: 0 },
    { date: "2026-07-03", trimp: 90 }, { date: "2026-07-04", trimp: 0 },
    { date: "2026-07-05", trimp: 30 }, { date: "2026-07-06", trimp: 0 },
    { date: "2026-07-07", trimp: 100 },
  ];
  const ms = monotonyStrain(varied)!;
  assert.ok(ms.monotony < 1.5, `expected healthy, got ${ms.monotony}`);
  assert.match(ms.status, /healthy/);
});

test("strain = weekly total load × monotony", () => {
  const flat: DL[] = Array.from({ length: 7 }, (_, i) => ({ date: `2026-07-0${i + 1}`, trimp: 50 }));
  const ms = monotonyStrain(flat)!;
  assert.equal(ms.totalLoad, 350);
  assert.equal(ms.strain, Math.round(350 * ms.monotony));
});

test("monotonyStrain returns null for an all-zero week", () => {
  const zeros: DL[] = Array.from({ length: 7 }, (_, i) => ({ date: `2026-07-0${i + 1}`, trimp: 0 }));
  assert.equal(monotonyStrain(zeros), null);
});

test("PMC: CTL and ATL rise with sustained load; provisional under 42 days", () => {
  const s: DL[] = Array.from({ length: 20 }, (_, i) => ({ date: `d${i}`, trimp: 50 }));
  const pmc = computePMC(s)!;
  assert.ok(pmc.ctl > 0 && pmc.atl > 0);
  assert.ok(pmc.atl > pmc.ctl); // 7-day EWMA reacts faster than 42-day, both climbing
  assert.equal(pmc.provisional, true);
});

test("PMC: form (TSB) goes positive when load drops (a taper)", () => {
  const build: DL[] = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, trimp: 60 }));
  const taper: DL[] = Array.from({ length: 10 }, (_, i) => ({ date: `t${i}`, trimp: 10 }));
  const pmc = computePMC([...build, ...taper])!;
  assert.ok(pmc.tsb > 0, `expected fresh/positive TSB after a taper, got ${pmc.tsb}`);
});
