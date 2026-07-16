import fs from "fs";
import path from "path";
import type { AthleteProfile } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const PROFILE_PATH = path.join(DATA_DIR, "athlete-profile.json");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Athlete profile (full Strava history, built by build-history script) ─────
// This is the only persisted state. Prescriptions + adherence live in
// COACHING-LOG.md now (Claude maintains it), not in a JSON file.

export function loadAthleteProfile(): AthleteProfile | null {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_PATH, "utf-8")) as AthleteProfile;
  } catch {
    return null;
  }
}

export function saveAthleteProfile(profile: AthleteProfile): void {
  try {
    ensureDataDir();
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
  } catch (err) {
    console.warn("Failed to save athlete profile (non-fatal):", err);
  }
}
