# Marathon Coach Starter

A privacy-first template that turns an AI assistant into a running coach with
real training history, repeatable metrics, and a memory that improves each week.

[Use this template](https://github.com/RohanSi4/marathon-coach-starter/generate)
· [See the live fitness dashboard](https://rohansingh04.com/fitness)
· [Read the case study](https://rohansingh04.com/projects/marathon-prep-bot)

This is the reusable machinery from my own marathon coaching system. It starts
empty, interviews you about your goals and training history, then builds plans
from your data. My workouts, locations, and health notes are not included.

## What you get

- A coach with memory through versioned athlete, plan, and adherence files
- An Apple Watch pipeline that imports HealthFit FIT exports
- Derived splits, heart-rate zones, TRIMP, aerobic decoupling, strides, and trends
- Adaptive weekly planning with injury gates, step-back weeks, taper rules, and fueling
- Coaching rules grounded in established models with clear limits and citations
- A TypeScript toolkit with strict validation and automated regression coverage

## The flow

~~~text
Apple Watch
    ↓
HealthFit FIT export
    ↓
TypeScript import and validation
    ↓
Training history + derived metrics
    ↓
AI coach reads the evidence
    ↓
Weekly plan + adherence log
~~~

## Quick start with Claude Code

Requirements: Node.js 20+.

1. Click [Use this template](https://github.com/RohanSi4/marathon-coach-starter/generate)
   or clone the repository.
2. Install dependencies:

   ~~~bash
   npm install
   ~~~

3. Open the folder in [Claude Code](https://claude.com/claude-code) and say:

   > You're my running coach. Onboard me.

4. The coach reads `CLAUDE.md`, notices that no athlete profile exists, and
   interviews you about your race, goals, background, injuries, shoes, and schedule.
5. Apple Watch users can follow
   [`docs/SETUP-HEALTHFIT.md`](docs/SETUP-HEALTHFIT.md) to connect workout exports.
6. Ask the coach to plan your week. It will rebuild the coaching context, review
   what happened, and write the next seven days.

Keep your generated repository private if you import personal training data.

## Use it with any chatbot

No Apple Watch or coding assistant is required. `PROMPT.md` is a standalone
version of the coaching system for ChatGPT, Claude, Gemini, or another assistant.
You report workouts manually, so it is less precise, but the same planning and
safety rules still apply.

## What is in the repository

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Coaching rules, science, workflow, and required plan format |
| `ONBOARDING.md` | First-session athlete interview |
| `PROMPT.md` | Standalone prompt for chatbots without repository access |
| `ATHLETE.md` | Athlete profile created during onboarding |
| `COACHING-LOG.md` | Weekly plans and adherence history |
| `lib/` and `scripts/` | TypeScript workout analysis and coaching tools |
| `data/` | Private training archive, empty in the template |
| `docs/SETUP-HEALTHFIT.md` | Apple Watch and HealthFit setup |

## Useful commands

| Command | What it does |
|---|---|
| `npm run import` | Import new HealthFit FIT exports |
| `npm run coach-data` | Build the full weekly coaching context |
| `npm run plan-today` | Show today's prescribed session |
| `npm run last-run` | Analyze the latest run, splits, heart rate, and strides |
| `npm run trends` | Show the long-term training arc |
| `npm run zones` | Recalculate heart-rate zones from the athlete's own runs |
| `npm run typecheck` | Run strict TypeScript checks |
| `npm test` | Run the regression suite |

## Coaching principles

The system uses Daniels VDOT, Banister TRIMP and fitness-fatigue, Seiler
intensity distribution, Lydiard-style periodization, and athlete-specific heart
rate trends. It treats those models as tools, not truth.

Real race results beat model estimates. Pain and injury signals stop progression.
The coach states uncertainty and does not pretend population research can predict
one athlete perfectly. This is training support, not medical advice.

## Privacy

FIT files can contain timestamps, heart-rate streams, and location data. The
template intentionally keeps the pipeline local and starts with an empty archive.
Treat access to a populated copy as access to sensitive health information.
