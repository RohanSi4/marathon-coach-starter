import { test } from "node:test";
import assert from "node:assert/strict";
import { runDurability, durabilityLedger, formatDurabilityBlock, MIN_SPLITS_FOR_DURABILITY } from "../lib/durability";
import type { StoredActivity, MileSplit } from "../lib/types";

const splits = (pairs: [string, number][]): MileSplit[] =>
  pairs.map(([pace, avgHR], i) => ({ mile: i + 1, pace, avgHR }));

const run = (over: Partial<StoredActivity>): StoredActivity =>
  ({
    schemaVersion: 1, source: "fit", sourceFile: "x.fit",
    key: (over.start_date ?? "k") + "_Run", id: "t", name: "Run",
    type: "Run", sport_type: "Run",
    start_date: "2026-07-01T12:00:00.000Z",
    distance: 9656, moving_time: 3300, elapsed_time: 3300, average_speed: 2.9,
    ...over,
  }) as StoredActivity;

test("runDurability: steady run (flat pace/HR) shows ~zero decoupling", () => {
  const d = runDurability(splits([
    ["9:00/mi", 140], ["9:00/mi", 140], ["9:00/mi", 140],
    ["9:00/mi", 140], ["9:00/mi", 140], ["9:00/mi", 140],
  ]))!;
  assert.equal(d.decouplingPct, 0);
  assert.equal(d.milesUsed, 6);
});

test("runDurability: a fade (HR rises at same pace late) is POSITIVE decoupling", () => {
  const d = runDurability(splits([
    ["9:00/mi", 140], ["9:00/mi", 140], ["9:00/mi", 145],
    ["9:00/mi", 150], ["9:00/mi", 158], ["9:00/mi", 160],
  ]))!;
  // first third HR ~140, last third ~159 → EF drops → positive decoupling
  assert.ok(d.decouplingPct > 0, `expected positive, got ${d.decouplingPct}`);
});

test("runDurability: a negative split (faster/steady HR late) is NEGATIVE decoupling", () => {
  const d = runDurability(splits([
    ["9:30/mi", 145], ["9:20/mi", 145], ["9:10/mi", 145],
    ["8:50/mi", 145], ["8:40/mi", 145], ["8:30/mi", 145],
  ]))!;
  assert.ok(d.decouplingPct < 0, `expected negative, got ${d.decouplingPct}`);
});

test("runDurability: sign/scale matches whole-run convention (first-vs-last EF ratio)", () => {
  // Speed constant, HR 100 first third → 125 last third: EF drops 20% → +20%.
  const d = runDurability(splits([
    ["8:00/mi", 100], ["8:00/mi", 100],
    ["8:00/mi", 110], ["8:00/mi", 110],
    ["8:00/mi", 125], ["8:00/mi", 125],
  ]))!;
  assert.equal(d.decouplingPct, 20);
});

test("runDurability: returns null below the minimum split count", () => {
  const short = splits(Array(MIN_SPLITS_FOR_DURABILITY - 1).fill(["9:00/mi", 140]) as [string, number][]);
  assert.equal(runDurability(short), null);
});

test("runDurability: skips splits missing HR, still qualifies if enough remain", () => {
  const s = splits([
    ["9:00/mi", 140], ["9:00/mi", 140], ["9:00/mi", 140],
    ["9:00/mi", 145], ["9:00/mi", 150], ["9:00/mi", 152],
  ]);
  s.push({ mile: 7, pace: "9:00/mi" }); // no HR → ignored
  const d = runDurability(s)!;
  assert.equal(d.milesUsed, 6);
});

test("durabilityLedger: includes only runs ≥ minMiles with usable splits, chronological", () => {
  const acts = [
    run({ start_date: "2026-06-10T12:00:00.000Z", distance: 9700 /*6.03mi*/,
      splits: splits([["9:00/mi",140],["9:00/mi",141],["9:00/mi",142],["9:00/mi",144],["9:00/mi",146],["9:00/mi",148]]) }),
    run({ start_date: "2026-06-12T12:00:00.000Z", distance: 4828 /*3mi*/,
      splits: splits([["9:00/mi",140],["9:00/mi",140],["9:00/mi",140]]) }), // too short
    run({ start_date: "2026-06-20T12:00:00.000Z", distance: 12875 /*8mi*/,
      splits: splits([["9:00/mi",140],["9:00/mi",140],["9:00/mi",140],["9:00/mi",140],["9:00/mi",140],["9:00/mi",140],["9:00/mi",140],["9:00/mi",140]]) }),
  ];
  const led = durabilityLedger(acts);
  assert.equal(led.length, 2);
  assert.deepEqual(led.map((e) => e.date), ["2026-06-10", "2026-06-20"]);
});

test("durabilityLedger labels dates in the athlete's coaching timezone", () => {
  const latePacific = run({
    start_date: "2026-07-10T02:30:00.000Z", // Thu Jul 9, 10:30pm ET
    distance: 9700,
    splits: splits([["9:00/mi",140],["9:00/mi",140],["9:00/mi",140],["9:00/mi",140],["9:00/mi",140],["9:00/mi",140]]),
  });
  assert.equal(durabilityLedger([latePacific])[0].date, "2026-07-09");
});

test("formatDurabilityBlock: empty when no qualifying runs; renders trend when present", () => {
  assert.match(formatDurabilityBlock([]), /No qualifying long runs yet/);
  const acts = [
    run({ start_date: "2026-06-10T12:00:00.000Z", distance: 14484 /*9mi*/,
      splits: splits([["9:00/mi",140],["9:00/mi",142],["9:00/mi",144],["9:00/mi",150],["9:00/mi",155],["9:00/mi",158],["9:00/mi",160],["9:00/mi",162],["9:00/mi",164]]) }),
    run({ start_date: "2026-06-28T12:00:00.000Z", distance: 12875 /*8mi*/, average_temp: 28,
      splits: splits([["10:00/mi",140],["10:00/mi",140],["10:00/mi",141],["10:00/mi",142],["10:00/mi",142],["10:00/mi",143],["10:00/mi",143],["10:00/mi",144]]) }),
  ];
  const block = formatDurabilityBlock(acts);
  assert.match(block, /DURABILITY/);
  assert.match(block, /2026-06-28/);
  assert.match(block, /28°C/); // heat annotation on the warm run
  assert.match(block, /goal-decision/);
});
