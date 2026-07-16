# data/ — the training archive

- `activities/` — one JSON per workout, materialized from FIT files by
  `npm run import`. Committed to git on purpose: this IS the archive.
- `notes.md` — the athlete's free-text channel (injury detection reads it).
- `recovery.csv` — daily HRV/RHR/sleep/VO2max, built by `npm run recovery-merge`.
- `athlete-profile.json` — weekly history aggregate, built by `npm run build-history`.

Everything here regenerates from FIT files + notes except notes.md itself.
