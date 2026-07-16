// ─── The notes channel (replaces Strava activity descriptions) ────────────────
// FIT files carry no free text and Apple Health has no notes field, so the injury/
// fueling/illness keyword pipeline — the system's #1 safety input — feeds from
// data/notes.md instead: one line per day, joined to that day's activities by the
// coach-TZ calendar date at summarize time.
//
// Format (either bullet or bare):
//   2026-07-03: knee fine, took a gel at mile 5. shoes: speed3 rpe: 6
//   - 2026-07-04: right ankle a little tight after
//
// Optional structured tokens parsed out of the text:
//   shoes: <name>   — overrides the config date-map shoe for that day
//   rpe: <1-10>     — athlete-reported effort
import fs from "fs";
import path from "path";
import { coachTZ } from "./config";

export interface DayNote {
  date: string;   // YYYY-MM-DD (coach-TZ calendar date)
  text: string;   // full note text (for display; tokens included)
  // Athlete-authored text only — coach-logged lines (my annotations) are excluded so
  // they can't trip the injury/illness/fueling keyword scan. A coach note "no knee
  // pain, valve clear (coach-logged)" must NOT fake an injury flag; only the athlete's
  // own words drive symptom detection. Excluded at the LINE level (coach lines can
  // contain "; ", so a post-merge split would be unsafe).
  athleteText: string;
  // Coach-authored context is kept separate for display so it is never mislabeled
  // as an athlete report or fed back into the symptom scanner.
  coachText: string;
  shoes?: string;
  rpe?: number;
}

// A line is a coach annotation (not an athlete symptom report) when it carries the
// "(coach-logged)" marker — appended to every note I write on the athlete's behalf.
const COACH_LOGGED_RE = /\(coach-logged\)/i;

export const DEFAULT_NOTES_PATH = path.join(process.cwd(), "data", "notes.md");

const LINE_RE = /^\s*(?:[-*]\s*)?(\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/;

export function parseNotes(content: string): DayNote[] {
  const out: DayNote[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, date, text] = m;
    const shoes = text.match(/\bshoes:\s*([\w -]+?)(?=\s+\w+:|$)/i)?.[1]?.trim();
    const rpeRaw = text.match(/\brpe:\s*(\d{1,2})\b/i)?.[1];
    const rpe = rpeRaw != null ? Math.min(10, parseInt(rpeRaw, 10)) : undefined;
    const trimmed = text.trim();
    const coachLogged = COACH_LOGGED_RE.test(trimmed);
    out.push({
      date,
      text: trimmed,
      athleteText: coachLogged ? "" : trimmed,
      coachText: coachLogged ? trimmed : "",
      shoes,
      rpe,
    });
  }
  return out;
}

// date → note; multiple lines for the same day merge (text joined with "; ",
// later tokens win).
export function loadNotes(notesPath: string = DEFAULT_NOTES_PATH): Map<string, DayNote> {
  let content = "";
  try {
    content = fs.readFileSync(notesPath, "utf-8");
  } catch {
    return new Map();
  }
  const map = new Map<string, DayNote>();
  for (const note of parseNotes(content)) {
    const existing = map.get(note.date);
    if (existing) {
      existing.text = `${existing.text}; ${note.text}`;
      existing.athleteText = [existing.athleteText, note.athleteText].filter(Boolean).join("; ");
      existing.coachText = [existing.coachText, note.coachText].filter(Boolean).join("; ");
      if (note.shoes) existing.shoes = note.shoes;
      if (note.rpe != null) existing.rpe = note.rpe;
    } else {
      map.set(note.date, { ...note });
    }
  }
  return map;
}

// The coach-TZ calendar date an activity belongs to — matches how the athlete
// thinks about "Friday's run" even when it crossed midnight somewhere else.
export function noteDateKey(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: coachTZ(d),
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  return parts; // en-CA formats as YYYY-MM-DD
}
