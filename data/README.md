# data/: the training archive

- `activities/`: one JSON per workout, materialized from FIT files by
  `npm run import`. Gitignored by default, because a workout carries GPS start
  coordinates, exact timestamps, heart-rate streams, and the recording device's
  name. If your repository is private and you want the archive versioned as your
  training history, remove the `data/` lines from `.gitignore`.
- `notes.md`: the athlete's free-text channel (injury detection reads it).
- `recovery.csv`: daily HRV/RHR/sleep/VO2max, built by `npm run recovery-merge`.
- `athlete-profile.json`: weekly history aggregate, built by `npm run build-history`.

Everything here regenerates from FIT files + notes except notes.md itself.
