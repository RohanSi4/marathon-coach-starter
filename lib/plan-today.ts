// ─── "What's my workout today?" — parse the newest COACHING-LOG prescription ──
// The COACHING-LOG is the source of truth for what was prescribed, so the
// plan-today view reads it directly instead of a separate plan file that can
// drift. The newest `## Week of …` section's `- Ddd M/D: …` bullet lines are the
// per-day prescription; today's line (coach-TZ calendar date) is the answer.
import { coachTZ } from "./config";

export interface PlanDay {
  date: string;    // YYYY-MM-DD
  dayLabel: string; // e.g. "Sat 7/18"
  text: string;    // the prescription, markdown bold stripped
  isKeyDay: boolean; // the 🎯 marker in the log
}

export interface WeekPlan {
  heading: string; // the section heading line, "## " stripped
  weekStart?: string;
  weekEnd?: string;
  prescribedMiles?: number;
  days: PlanDay[];
}

const SECTION_RE = /^## Week of .*?(\d{4})/;
const RANGE_RE = /^## Week of ([A-Za-z]{3}) (\d{1,2})[–-](?:([A-Za-z]{3}) )?(\d{1,2}), (\d{4})/;
const DAY_LINE_RE = /^-\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\/(\d{1,2})\s*([^:]*):\s*(.+)$/;
const PRESCRIBED_RE = /\*\*Prescribed \(~?([\d.]+)mi/;
const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

function stripMd(s: string): string {
  return s.replace(/\*\*/g, "").trim();
}

// Parse the FIRST (= newest; the log is newest-on-top) week section that
// contains day-bullet lines. Sections without day lines (data corrections,
// close-outs) are skipped.
export function parseNewestWeekPlan(logContent: string): WeekPlan | null {
  const lines = logContent.split("\n");
  let heading: string | null = null;
  let year: number | null = null;
  let weekStart: string | undefined;
  let weekEnd: string | undefined;
  let prescribedMiles: number | undefined;
  let days: PlanDay[] = [];

  for (const line of lines) {
    const section = line.match(SECTION_RE);
    if (section) {
      if (days.length > 0) break; // finished the newest section that had a plan
      heading = line.replace(/^##\s*/, "").trim();
      year = parseInt(section[1], 10);
      const range = line.match(RANGE_RE);
      if (range) {
        const [, startMonthLabel, startDay, endMonthLabel, endDay, rangeYear] = range;
        const startMonth = MONTHS[startMonthLabel];
        const endMonth = MONTHS[endMonthLabel ?? startMonthLabel];
        weekStart = `${rangeYear}-${String(startMonth).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;
        weekEnd = `${rangeYear}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
      } else {
        weekStart = undefined;
        weekEnd = undefined;
      }
      prescribedMiles = undefined;
      days = [];
      continue;
    }
    if (line.startsWith("## ") && days.length > 0) break;
    if (year == null) continue;
    const prescribed = line.match(PRESCRIBED_RE);
    if (prescribed && prescribedMiles == null) prescribedMiles = Number(prescribed[1]);
    const m = line.match(DAY_LINE_RE);
    if (!m) continue;
    const [, dow, mm, dd, marker, text] = m;
    const month = parseInt(mm, 10);
    const day = parseInt(dd, 10);
    days.push({
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      dayLabel: `${dow} ${month}/${day}`,
      text: stripMd(text),
      isKeyDay: marker.includes("🎯"),
    });
  }

  if (heading == null || days.length === 0) return null;
  return { heading, weekStart, weekEnd, prescribedMiles, days };
}

// Today's calendar date in the coaching timezone.
export function todayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: coachTZ(now),
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function planWeekDays(plan: WeekPlan): PlanDay[] {
  const days = new Map<string, PlanDay>();
  for (const day of plan.days) {
    if (plan.weekStart && day.date < plan.weekStart) continue;
    if (plan.weekEnd && day.date > plan.weekEnd) continue;
    days.set(day.date, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function planForDate(plan: WeekPlan, dateKey: string): PlanDay | undefined {
  return planWeekDays(plan).find(d => d.date === dateKey);
}
