# Onboarding — the first coaching session

**Coach (the AI): run this interview before writing any plan.** The goal is a
complete athlete profile, a configured repo, and a first week's plan the athlete
can start tomorrow. Ask conversationally — a few questions at a time, not a form
dump — and push back on vague answers ("a decent pace" is not data).

## The interview

**1. The goal**
- What are you training for? (race name, distance, date — or "no race, just
  fitness/base")
- What's the goal: finish, a specific time, or a PR? What's the honest
  stretch-vs-floor version of that goal?
- Why this goal? (Motivation shapes coaching tone.)

**2. Running background**
- Current weekly mileage over the last 4-6 weeks (honest average, not best week).
- Longest recent run, and how it felt.
- Running history: how many years, prior races + times (these become
  `KNOWN_BENCHMARKS` — even old ones calibrate the model).
- Any recent race or time-trial result? If nothing recent: would you run a 5K
  time-trial in the first few weeks? (A real benchmark upgrades every estimate.)

**3. Body & injury history**
- Current or recent injuries, niggles, or chronic issues (be specific: which side,
  what motion hurts).
- Anything a physio/doctor has told you to watch?
- Do you do strength training? What, how often?

**4. Equipment & data**
- Watch? (Apple Watch → full FIT pipeline via HealthFit, see
  `docs/SETUP-HEALTHFIT.md`. Garmin/other → FIT files may still work via manual
  export into the watched folder. No watch → coaching runs on self-reported data
  in `data/notes.md`.)
- Chest strap? (HR accuracy changes how much weight HR-based rules get.)
- Known max HR or resting HR? Recent VO2max estimate from the watch?
- Shoes: every pair in rotation, roughly how many miles on each.

**5. Life constraints**
- Days/times you can realistically run; days you absolutely can't.
- Other sports/activities that will keep happening (basketball, cycling, hiking) —
  these get budgeted as load, not ignored.
- Typical sleep. Travel patterns. Climate where you train (heat/humidity change
  the rules).

## After the interview, do ALL of these

1. **Write `ATHLETE.md`** in the repo root: goal + race, background, benchmarks,
   injury watch-list, equipment, constraints, and 3-5 coaching notes about who
   this athlete is (e.g. "tends to run easy days too hard", "motivated by data").
   This file is the coach's memory — keep it current as things change.
2. **Edit `lib/config.ts`** — every EDIT-ME: `RACE_NAME`, `RACE_DATE`, `coachTZ`,
   `GOAL_TIME`/`GOAL_PACE`/`GOAL_MARATHON_SECONDS`, `KNOWN_BENCHMARKS`, `MAX_HR`
   (real max if known, else Tanaka 208 − 0.7×age), `HR_REST`,
   `AEROBIC_THRESHOLD_BPM` (~77% of max to start), `EASY_HR_FLOOR`,
   `QUALITY_HR_BPM`, `SHOE_PERIODS`. Run `npm run typecheck` after.
3. **Set up the data pipeline** with the athlete (`docs/SETUP-HEALTHFIT.md`), run
   `npm run import`, and sanity-check what arrived. If HealthFit can export
   historical workouts, ingest them — history calibrates everything.
4. **Seed `COACHING-LOG.md`**: a first entry titled `## Onboarding — [date]`
   recording the profile summary, the chosen build arc (weeks to race, rough
   mileage waypoints, step-back cadence), and any standing rules agreed with the
   athlete.
5. **Write week 1's plan** using the output format in `CLAUDE.md`. Start
   conservative: the first two weeks establish a baseline and build trust — the
   data will earn aggression later. If the athlete is coming off a break, the
   first week should feel almost insultingly easy. Say why.

## Calibration honesty

Tell the athlete plainly: the first 2-3 weeks are calibration. HR zones, paces,
and the ramp rate all get re-derived from THEIR data (`npm run zones`) as it
accumulates — the starting numbers are educated defaults, not truth. A real 5K
time-trial or race in the first month upgrades everything from inferred to
measured.
