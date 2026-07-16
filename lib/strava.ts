import fs from "fs";
import path from "path";
import type { StravaActivity, StravaGear, ActivitySummary, HRZoneSplit, MileSplit } from "./types";
import { isTreadmillRun, coachTZ } from "./config";
import { INJURY_KEYWORDS, ILLNESS_KEYWORDS, FUELING_KEYWORDS, LIFESTYLE_KEYWORDS, SHOE_KEYWORDS, hasKeyword } from "./keywords";
import { fmtPace, fmtDuration, getWeekStartUnix, RUN_TYPES } from "./weeks";
import { computeHRDriftFromSplits } from "./fit/compute";

// Week math + formatters moved to lib/weeks.ts (source-agnostic — shared with the
// FIT ingestion path). Re-exported here so existing imports/tests keep working.
export { fmtPace, fmtDuration, zonedDayOfWeek, weekKey, nextWeekKey, fillMissingWeeks, getWeekStartUnix, RUN_TYPES } from "./weeks";

const WORKOUT_TYPE_LABELS: Record<number, string> = {
  1: "Race",
  2: "Long Run",
  3: "Workout",
};

export async function getAccessToken(): Promise<string> {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json() as { access_token: string; refresh_token?: string };

  // Strava rotates refresh tokens periodically — persist the new one immediately
  if (data.refresh_token && data.refresh_token !== process.env.STRAVA_REFRESH_TOKEN) {
    try {
      const envPath = path.join(process.cwd(), ".env.local");
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        const updated = content.replace(
          /^STRAVA_REFRESH_TOKEN=.*/m,
          `STRAVA_REFRESH_TOKEN=${data.refresh_token}`
        );
        fs.writeFileSync(envPath, updated);
        process.env.STRAVA_REFRESH_TOKEN = data.refresh_token;
        console.log("  Strava refresh token rotated — saved to .env.local");
      }
    } catch {
      console.warn("  Warning: new Strava refresh token received but failed to persist to .env.local");
    }
  }

  return data.access_token;
}

// Paginated fetch — returns ALL activities after a unix timestamp.
// Max 200 per page; loops until Strava returns fewer than 200.
export async function getAllActivities(
  accessToken: string,
  after: number
): Promise<StravaActivity[]> {
  const all: StravaActivity[] = [];
  let page = 1;

  while (true) {
    const res = await fetchWithRetry(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Strava activities fetch failed: ${res.status} ${text}`);
    }

    const batch = await res.json() as StravaActivity[];
    all.push(...batch);
    if (batch.length < 200) break;
    page++;
  }

  return all;
}

export async function getWeekActivities(accessToken: string): Promise<StravaActivity[]> {
  return getAllActivities(accessToken, getWeekStartUnix());
}

// Fetch wrapper that retries once on HTTP 429, honouring the Retry-After header.
// For all other non-ok responses it returns the response as-is so callers can
// inspect the status themselves.
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 429) return res;

  const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
  const waitSecs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
  console.warn(`  Strava 429 — waiting ${waitSecs}s before retry (${url})`);
  await new Promise((resolve) => setTimeout(resolve, waitSecs * 1000));
  return fetch(url, init);
}

async function getHRZones(activityId: number, accessToken: string): Promise<HRZoneSplit[] | undefined> {
  try {
    const res = await fetchWithRetry(
      `https://www.strava.com/api/v3/activities/${activityId}/zones`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return undefined;

    const zones = await res.json() as Array<{
      type: string;
      distribution_buckets: Array<{ min: number; max: number; time: number }>;
    }>;

    const hrZone = zones.find((z) => z.type === "heartrate");
    if (!hrZone) return undefined;

    return hrZone.distribution_buckets.map((b, i) => ({
      zone: i + 1,
      minBpm: b.min,
      maxBpm: b.max === -1 ? 999 : b.max,
      seconds: b.time,
    }));
  } catch {
    return undefined;
  }
}

async function getActivityDetail(id: number, accessToken: string): Promise<StravaActivity | null> {
  try {
    const res = await fetchWithRetry(
      `https://www.strava.com/api/v3/activities/${id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null;
    return res.json() as Promise<StravaActivity>;
  } catch {
    return null;
  }
}

// The athlete endpoint returns the athlete's shoes with lifetime distance.
// One call resolves gear_id → shoe name and powers mileage tracking.
export async function getAthleteGear(accessToken: string): Promise<StravaGear[]> {
  try {
    const res = await fetchWithRetry(
      "https://www.strava.com/api/v3/athlete",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return [];
    const data = await res.json() as { shoes?: StravaGear[] };
    return data.shoes ?? [];
  } catch {
    return [];
  }
}

export async function summarizeActivities(
  activities: StravaActivity[],
  accessToken: string
): Promise<ActivitySummary[]> {
  // Fetch full detail for runs — list endpoint omits description, splits, etc.
  const detailMap = new Map<number, StravaActivity>();
  await Promise.all(
    activities
      .filter((a) => RUN_TYPES.includes(a.type))
      .map(async (a) => {
        const detail = await getActivityDetail(a.id, accessToken);
        if (detail) detailMap.set(a.id, detail);
      })
  );

  // Resolve shoe (gear) names once for the whole batch.
  const gear = await getAthleteGear(accessToken);
  const gearMap = new Map(gear.map((g) => [g.id, g.nickname || g.name]));

  return Promise.all(
    activities.map(async (a) => {
      const date = new Date(a.start_date);
      const isRun = RUN_TYPES.includes(a.type);
      const detail = detailMap.get(a.id) ?? a;

      const isTreadmill = isRun && isTreadmillRun({
        trainer: detail.trainer,
        hasGps: Array.isArray(detail.start_latlng) && detail.start_latlng.length > 0,
        elevationGain: a.total_elevation_gain,
      });
      const shoeName = detail.gear_id ? gearMap.get(detail.gear_id) : undefined;

      const hrZones = isRun && a.average_heartrate
        ? await getHRZones(a.id, accessToken)
        : undefined;

      const stoppedSecs = (a.elapsed_time ?? 0) - (a.moving_time ?? 0);

      const splits: MileSplit[] | undefined = isRun && detail.splits_standard?.length
        ? detail.splits_standard
            .filter((s) => s.average_speed > 0)
            .map((s) => ({
              mile: s.split,
              pace: fmtPace(s.average_speed),
              avgHR: s.average_heartrate ? Math.round(s.average_heartrate) : undefined,
              elevFt: s.elevation_difference != null
                ? Math.round(s.elevation_difference * 3.28084)
                : undefined,
            }))
        : undefined;

      // HR drift: first half vs second half of mile splits (shared with the FIT path
      // so both sources report drift identically).
      const hrDriftBpm = computeHRDriftFromSplits(splits);

      // Note keyword detection (word-boundary matched — see lib/keywords.ts).
      const desc = detail.description?.trim();
      const lifestyleNote = hasKeyword(desc, LIFESTYLE_KEYWORDS) ? desc : undefined;
      const fuelingNote = hasKeyword(desc, FUELING_KEYWORDS) ? desc : undefined;

      // noWarmup: first mile HR > 150 AND first mile NOT ≥30s/mi slower than overall
      // avg pace. A warmed-up run starts meaningfully slower; a first mile at avg
      // pace — or FASTER than avg (a sprint start, the worst case) — is no warmup.
      let noWarmup: boolean | undefined;
      if (splits && splits.length > 0 && splits[0].avgHR !== undefined && splits[0].avgHR > 150) {
        const parsePaceSecs = (pace: string): number | undefined => {
          const match = pace.match(/^(\d+):(\d{2})\/mi$/);
          if (!match) return undefined;
          return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
        };
        const split1Secs = parsePaceSecs(splits[0].pace);
        const avgSecs = parsePaceSecs(a.average_speed > 0 ? fmtPace(a.average_speed) : "");
        if (split1Secs !== undefined && avgSecs !== undefined && split1Secs - avgSecs < 30) {
          noWarmup = true;
        }
      }

      const injuryNote = hasKeyword(desc, INJURY_KEYWORDS) ? desc : undefined;
      const illnessNote = hasKeyword(desc, ILLNESS_KEYWORDS) ? desc : undefined;
      const shoeNote = hasKeyword(desc, SHOE_KEYWORDS) ? desc : undefined;

      return {
        type: a.type,
        name: a.name,
        dayOfWeek: date.toLocaleDateString("en-US", { weekday: "long", timeZone: coachTZ(date) }),
        date: date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: coachTZ(date) }),
        distanceMiles: isRun ? parseFloat((a.distance / 1609.344).toFixed(2)) : 0,
        durationFormatted: fmtDuration(a.moving_time),
        paceFormatted: isRun ? fmtPace(a.average_speed) : "N/A",
        elevationFt: Math.round((a.total_elevation_gain ?? 0) * 3.28084),
        avgHR: a.average_heartrate != null ? Math.round(a.average_heartrate) : undefined,
        maxHR: a.max_heartrate != null ? Math.round(a.max_heartrate) : undefined,
        avgWatts: a.device_watts ? a.average_watts : undefined,
        weightedWatts: a.device_watts ? a.weighted_average_watts : undefined,
        sufferScore: a.suffer_score,
        perceivedExertion: a.perceived_exertion,
        calories: detail.calories,
        prCount: a.pr_count && a.pr_count > 0 ? a.pr_count : undefined,
        notes: detail.description?.trim() || undefined,
        hrZones,
        cadence: detail.average_cadence ? Math.round(detail.average_cadence) : undefined,
        stoppedMinutes: stoppedSecs > 120 ? Math.round(stoppedSecs / 60) : undefined,
        avgTempF: detail.average_temp != null
          ? Math.round(detail.average_temp * 9 / 5 + 32)
          : undefined,
        workoutType: detail.workout_type != null
          ? WORKOUT_TYPE_LABELS[detail.workout_type]
          : undefined,
        splits,
        hrDriftBpm,
        lifestyleNote,
        fuelingNote,
        noWarmup,
        injuryNote,
        illnessNote,
        shoeNote,
        isTreadmill,
        shoeName,
      };
    })
  );
}
