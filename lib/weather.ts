// ─── Outdoor-run temperature enrichment (Open-Meteo, free + keyless) ─────────
// Strava's temperature field was weather enrichment — FIT files have none, but the
// heat-adjusted quality classifier and the summer pacing rules want it. This looks
// up temperature_2m at the run's midpoint hour from its GPS start fix, at IMPORT
// time only (coach-data/build-history stay fully offline), cached in
// data/weather-cache.json so re-imports never refetch. Any failure → undefined —
// the classifier already handles absent temperature.
import fs from "fs";
import path from "path";

export const DEFAULT_CACHE_PATH = path.join(process.cwd(), "data", "weather-cache.json");

// Open-Meteo's archive lags ~5 days behind realtime; the forecast endpoint covers
// the recent window via past_days.
const ARCHIVE_LAG_MS = 5 * 86_400_000;

type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

interface HourlyResponse {
  hourly?: { time?: string[]; temperature_2m?: Array<number | null> };
}

// Pick the hourly temperature closest to the target instant (≤90min away).
export function pickHourTemp(times: string[], temps: Array<number | null>, targetISO: string): number | undefined {
  const target = Date.parse(targetISO);
  let best: number | undefined;
  let bestGap = Infinity;
  for (let i = 0; i < times.length && i < temps.length; i++) {
    const t = temps[i];
    if (t == null) continue;
    const gap = Math.abs(Date.parse(times[i] + (times[i].endsWith("Z") ? "" : "Z")) - target);
    if (gap < bestGap) { bestGap = gap; best = t; }
  }
  return bestGap <= 90 * 60_000 ? best : undefined;
}

function cacheKey(lat: number, lng: number, when: Date): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)},${when.toISOString().slice(0, 13)}`;
}

function loadCache(p: string): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, number>; }
  catch { return {}; }
}

// Temperature (°C) at a location + instant. Returns undefined on any failure.
export async function temperatureAt(
  lat: number,
  lng: number,
  when: Date,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  cachePath: string = DEFAULT_CACHE_PATH
): Promise<number | undefined> {
  const key = cacheKey(lat, lng, when);
  const cache = loadCache(cachePath);
  if (key in cache) return cache[key];

  const la = lat.toFixed(4);
  const lo = lng.toFixed(4);
  const day = when.toISOString().slice(0, 10);
  const recent = Date.now() - when.getTime() < ARCHIVE_LAG_MS;
  const url = recent
    ? `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&hourly=temperature_2m&past_days=7&forecast_days=1&timezone=UTC`
    : `https://archive-api.open-meteo.com/v1/archive?latitude=${la}&longitude=${lo}&start_date=${day}&end_date=${day}&hourly=temperature_2m&timezone=UTC`;

  try {
    const res = await fetchImpl(url);
    if (!res.ok) return undefined;
    const data = await res.json() as HourlyResponse;
    const temp = pickHourTemp(
      data.hourly?.time ?? [],
      data.hourly?.temperature_2m ?? [],
      when.toISOString()
    );
    if (temp != null) {
      cache[key] = temp;
      try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1)); } catch { /* non-fatal */ }
    }
    return temp;
  } catch {
    return undefined;
  }
}
