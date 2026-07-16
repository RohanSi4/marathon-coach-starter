// ─── Data-source switch: FIT store (default) vs dormant Strava fallback ──────
// DATA_SOURCE=strava re-enables the legacy API path exactly as it was (it bypasses
// the local store entirely — useful only if the Strava subscription question ever
// resolves the other way). Everything else runs on the local FIT-backed store.
import type { ActivitySummary, StoredActivity } from "./types";
import { getWeekStartUnix } from "./weeks";
import { loadActivities } from "./store";
import { loadNotes } from "./notes";
import { summarize } from "./summarize";

export type DataSource = "fit" | "strava";

export function dataSource(): DataSource {
  return process.env.DATA_SOURCE === "strava" ? "strava" : "fit";
}

// This week's activities, enriched — the coach-data input.
export async function getWeekSummaries(): Promise<ActivitySummary[]> {
  if (dataSource() === "strava") {
    const { getAccessToken, getWeekActivities, summarizeActivities } = await import("./strava");
    const token = await getAccessToken();
    return summarizeActivities(await getWeekActivities(token), token);
  }
  const notes = loadNotes();
  return loadActivities(getWeekStartUnix()).map(a => summarize(a, notes));
}

// Raw stored activities since a date — the build-history input. FIT-store only:
// the legacy Strava path never writes the store, so history in strava mode should
// use the frozen baseline instead.
export function getRawSince(date: Date): StoredActivity[] {
  if (dataSource() === "strava") {
    throw new Error(
      "build-history from the Strava API is retired (subscriber-only since Jul 2026). " +
      "History = frozen baseline + FIT store. Unset DATA_SOURCE or set DATA_SOURCE=fit."
    );
  }
  return loadActivities(Math.floor(date.getTime() / 1000));
}
