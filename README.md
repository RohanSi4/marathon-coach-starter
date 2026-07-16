# AI Running Coach — starter kit

Turn an AI assistant into your personal running coach — one that reads your
actual training data (every run, split by split, with heart rate), applies real
sports science (Daniels' VDOT, Seiler intensity distribution, Banister training
load), writes your weekly plans, and adapts them to how your body is actually
responding.

This is a template. Nobody's data is in it. Your coach learns *you* during an
onboarding interview and gets smarter every week from your own numbers.

## What you get

- **A coach with a memory** — your profile, every plan, and every week's
  adherence live in files the AI reads at the start of each session.
- **A real data pipeline** (Apple Watch) — every workout lands as a FIT file;
  the toolkit computes splits, HR zones, training load (TRIMP), aerobic
  decoupling, stride detection, and long-term trends from the raw stream.
- **Honest coaching logic** — easy days governed by heart rate and the talk
  test, weekly mileage ramps gated by injury signals (GREEN/YELLOW/RED tiers),
  step-back weeks, taper rules, in-run fueling plans.
- **Receipts** — every prescription traces to an established training model, and
  the system defers to your real race results over its own estimates.

## Quick start (Claude Code — the full experience)

1. **Get the repo:** click "Use this template" on GitHub (or fork/clone).
2. **Install:** `npm install` (needs Node 20+).
3. **Open the folder in [Claude Code](https://claude.com/claude-code)** and say:
   > "You're my running coach. Onboard me."

   The AI reads `CLAUDE.md` (its operating manual), notices you have no profile
   yet, and runs the onboarding interview — what you're training for, your goal,
   your background, injuries, shoes, schedule. It writes your profile, configures
   the repo, and hands you week 1.
4. **Hook up your data** (Apple Watch users): follow `docs/SETUP-HEALTHFIT.md`
   (~10 minutes, one time). After every workout, `npm run import` pulls it in.
5. **Each week:** tell your coach "plan my week." It runs `npm run coach-data`,
   reads your log, and writes the next week from the evidence.

Keep your copy of the repo private if you'd rather not share your training data —
the data folder is part of the archive by design.

## Quick start (any chatbot — no code)

Don't want the data pipeline? `PROMPT.md` is a standalone system prompt: paste it
into ChatGPT, Claude.ai, Gemini, or anything else with memory/custom instructions.
You self-report your runs; the coach applies the same training logic. Less
precise, still a real coach.

## What's in the box

| Path | What it is |
|---|---|
| `CLAUDE.md` | The coach's operating manual (science, workflow, rules, output format) |
| `ONBOARDING.md` | The first-session interview protocol |
| `PROMPT.md` | Standalone version for any chatbot, no code needed |
| `ATHLETE.md` | *Created at onboarding* — your profile, the coach's memory |
| `COACHING-LOG.md` | Every week's plan + what actually happened |
| `lib/`, `scripts/` | The data toolkit (TypeScript, 216 tests) |
| `data/` | Your training archive (starts empty) |
| `docs/SETUP-HEALTHFIT.md` | Apple Watch → FIT pipeline setup |

## Useful commands

```
npm run import          # ingest new workouts from HealthFit
npm run coach-data      # the full weekly coaching context
npm run plan-today      # what's on the plan today
npm run last-run        # latest run: splits, HR analysis, stride check
npm run trends          # the long-term arc
npm run zones           # re-derive YOUR HR zones from YOUR runs
npm test                # the test suite
```

## Requirements

- Node 20+
- For the full pipeline: an Apple Watch + [HealthFit](https://apps.apple.com/app/healthfit/id1202650514)
  (~$5, one-time) + iCloud Drive on a Mac
- An AI assistant that can read files and run commands (Claude Code is the
  reference experience)

## A note on trust

This system is built to be *trustworthy, not trusted blindly*: it cites its
models, states its limits (n=1, estimated max HR, population regressions), and
defers to real race results over its own estimates. It is not medical advice —
pain means see a professional, and the coach is instructed to say exactly that.

---

*Extracted from a real coaching system that trained a real marathoner. The
athlete's data stayed home; the machinery is all here.*
