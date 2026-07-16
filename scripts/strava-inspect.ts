/**
 * Diagnostic: dump raw Strava data so we can see what the Apple Watch Ultra sends.
 * Run: npx tsx scripts/strava-inspect.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getAccessToken } from "../lib/strava";

async function fetchJSON(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const token = await getAccessToken();
  console.log("✓ Strava auth OK\n");

  // Last 10 activities
  const activities = await fetchJSON(
    "https://www.strava.com/api/v3/athlete/activities?per_page=10",
    token
  ) as Record<string, unknown>[];

  console.log(`=== Last ${activities.length} Activities ===\n`);
  for (const a of activities) {
    const date = new Date(a.start_date as string).toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
    });
    const distMi = ((a.distance as number) / 1609.34).toFixed(2);
    const paceDecimal = (a.moving_time as number) / 60 / parseFloat(distMi);
    const paceMins = Math.floor(paceDecimal);
    const paceSecs = Math.round((paceDecimal - paceMins) * 60).toString().padStart(2, "0");

    console.log(`${date} | ${a.type} | ${distMi} mi | ${paceMins}:${paceSecs}/mi | HR avg ${a.average_heartrate ?? "—"} max ${a.max_heartrate ?? "—"} | suffer ${a.suffer_score ?? "—"} | effort ${a.perceived_exertion ?? "—"}`);
  }

  // Full detail on most recent activity
  const latest = activities[0];
  console.log(`\n=== Full fields on most recent activity (${latest.name}) ===\n`);
  const detail = await fetchJSON(
    `https://www.strava.com/api/v3/activities/${latest.id}`,
    token
  ) as Record<string, unknown>;

  // Print every non-null top-level field
  for (const [k, v] of Object.entries(detail)) {
    if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0) && typeof v !== "object") {
      console.log(`  ${k}: ${v}`);
    }
  }

  // HR streams for most recent activity
  console.log(`\n=== HR + cadence streams (first 20 samples) ===\n`);
  try {
    const streams = await fetchJSON(
      `https://www.strava.com/api/v3/activities/${latest.id}/streams?keys=heartrate,cadence,watts,velocity_smooth,grade_smooth&key_by_type=true`,
      token
    ) as Record<string, { data: unknown[] }>;

    for (const [type, stream] of Object.entries(streams)) {
      const samples = (stream.data as unknown[]).slice(0, 20);
      console.log(`  ${type}: [${samples.join(", ")}${stream.data.length > 20 ? ", ..." : ""}] (${stream.data.length} total points)`);
    }
  } catch (e) {
    console.log("  Streams not available:", e);
  }

  // Check for zones on most recent activity
  console.log(`\n=== HR Zones ===\n`);
  try {
    const zones = await fetchJSON(
      `https://www.strava.com/api/v3/activities/${latest.id}/zones`,
      token
    );
    console.log(JSON.stringify(zones, null, 2));
  } catch (e) {
    console.log("  Zones not available:", e);
  }
}

main().catch(console.error);
