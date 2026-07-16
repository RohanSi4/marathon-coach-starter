# Setup: Apple Watch → FIT pipeline (one time, ~10 minutes)

The coach reads your workouts as FIT files — the raw per-second data (HR, pace,
GPS, power) straight from the watch. [HealthFit](https://apps.apple.com/app/healthfit/id1202650514)
(~$5 one-time, iOS) exports every Apple Health workout as a FIT file
automatically. This is the whole pipeline:

```
Apple Watch → Apple Health → HealthFit (auto-export) → iCloud Drive → npm run import
```

## Steps

1. **Buy/install HealthFit** on the iPhone paired with your watch.
2. **Grant it Health access** when prompted (workouts + heart rate at minimum;
   grant broadly — it can only read).
3. **Turn on auto-export to iCloud Drive:** HealthFit → Settings (gear) →
   Auto Export → **iCloud Drive** → enable for Workouts, format **FIT**.
4. **Export your history (recommended):** HealthFit → Workouts tab → select-all →
   export to iCloud Drive. Your training history calibrates the coach's models —
   even a year back is gold.
5. **On the Mac** where this repo lives, confirm the folder exists:
   `~/Library/Mobile Documents/iCloud~com~altifondo~HealthFit/Documents`
   (it appears in Finder as "HealthFit" under iCloud Drive after the first
   export). If your path differs, set `HEALTHFIT_DIR` in `.env.local`.
6. **Run `npm run import`.** It scans the folder, downloads any cloud-only files,
   validates, dedupes, and stores activities in `data/activities/`. Run it before
   every coaching session.

## Sync quirks worth knowing

- **Exports are fire-and-forget** — you never lose a workout, but iOS defers
  background uploads. Opening HealthFit in the foreground for ~15-30s after a
  workout reliably pushes the file up. Low Power Mode postpones uploads.
- **Mac-side lag:** viewing the HealthFit folder in Finder nudges iCloud to
  refresh its listing.
- The importer handles "evicted" (cloud-only placeholder) files itself.

## Optional: daily recovery metrics (HRV / resting HR / sleep / VO2max)

HealthFit can also auto-export a daily health-metrics spreadsheet (Settings →
Auto Export → Google Sheets, or a manual export). Feed an export to
`npm run recovery-merge <file.xlsx>` and the coach's readiness view (HRV vs
baseline, resting-HR trend, sleep) comes alive. High value, five minutes.

## No Apple Watch?

- **Garmin:** Garmin Connect can export FIT files — drop them in a folder and
  point `HEALTHFIT_DIR` at it. The importer speaks standard FIT.
- **No watch at all:** the coach still works from self-reported runs logged in
  `data/notes.md` — or skip the repo entirely and use `PROMPT.md` in any chatbot.
