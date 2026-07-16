// The notes channel replaces Strava descriptions as the injury-keyword feed —
// parsing, token extraction, same-day merging, and coach-TZ date joining all have
// to be right or the safety pipeline silently starves.
import test from "node:test";
import assert from "node:assert/strict";
import { parseNotes, noteDateKey } from "../lib/notes";

test("parses bare and bulleted date lines, ignores everything else", () => {
  const notes = parseNotes([
    "# July notes",
    "2026-07-03: knee fine, took a gel at mile 5",
    "- 2026-07-04: right ankle a little tight after",
    "random prose that is not a note",
    "* 2026-07-05: easy day",
  ].join("\n"));
  assert.equal(notes.length, 3);
  assert.equal(notes[0].date, "2026-07-03");
  assert.match(notes[1].text, /ankle a little tight/);
});

test("extracts shoes: and rpe: tokens while keeping full text for keyword scanning", () => {
  const [n] = parseNotes("2026-09-01: tempo felt strong. shoes: Endorphin Speed 3 rpe: 7");
  assert.equal(n.shoes, "Endorphin Speed 3");
  assert.equal(n.rpe, 7);
  assert.match(n.text, /tempo felt strong/);
  assert.match(n.text, /shoes:/); // tokens stay in text — keyword scan sees everything
});

test("rpe caps at 10", () => {
  const [n] = parseNotes("2026-07-03: died today rpe: 99");
  assert.equal(n.rpe, 10);
});

test("noteDateKey uses the coach-TZ calendar date (late-night run stays on its day)", () => {
  // 2026-07-02T02:30:00Z = Wed Jul 1, 10:30pm ET — the athlete's Wednesday.
  assert.equal(noteDateKey(new Date("2026-07-02T02:30:00Z")), "2026-07-01");
  // 2026-09-10T03:00:00Z = Wed Sep 9, 11pm ET.
  assert.equal(noteDateKey(new Date("2026-09-10T03:00:00Z")), "2026-09-09");
});

// ─── Coach-logged exclusion (false-injury-flag fix, Jul 2026) ────────────────
// Coach annotations (tagged "(coach-logged)") must NOT drive the injury/illness
// keyword scan — a coach note saying the athlete is FINE would otherwise trip the
// injury flag on words like "knee"/"pain". athleteText carries scan-eligible text.

test("coach-logged line contributes to text but NOT athleteText", () => {
  const [n] = parseNotes("2026-07-08: not right side or knee, valve fully clear (coach-logged)");
  assert.match(n.text, /knee/);      // full text keeps it (for display)
  assert.equal(n.athleteText, "");   // but nothing athlete-authored to scan
  assert.match(n.coachText, /knee/); // coach context stays available, separately labeled
});

test("athlete-authored line keeps its text scannable", () => {
  const [n] = parseNotes("2026-07-08: right knee felt tight the last mile");
  assert.match(n.athleteText, /knee/); // real symptom stays scannable
  assert.equal(n.coachText, "");
});

test("coach line with internal '; ' is fully excluded (no post-merge split leak)", () => {
  const [n] = parseNotes("2026-07-08: ruling: no knee issue; ramp is fine (coach-logged)");
  assert.equal(n.athleteText, ""); // the whole line is coach-authored, semicolons and all
});

test("mixed day: athlete symptom flags, coach annotation does not", async () => {
  const { loadNotes } = await import("../lib/notes");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const p = path.join(os.tmpdir(), `notes-test-${Date.now()}.md`);
  fs.writeFileSync(p,
    "2026-07-08: knee felt a little off today\n" +
    "2026-07-08: circuit done, no knee signal (coach-logged)\n");
  const map = loadNotes(p);
  fs.unlinkSync(p);
  const n = map.get("2026-07-08")!;
  assert.match(n.text, /circuit done/);        // display has both
  assert.match(n.athleteText, /knee felt/);    // athlete symptom present
  assert.doesNotMatch(n.athleteText, /circuit done/); // coach line excluded from scan
  assert.match(n.coachText, /circuit done/);          // but retained as coach context
});
