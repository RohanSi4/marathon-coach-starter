// ─── Note keyword scanning ────────────────────────────────────────────────────
// Single source of truth for the injury/illness/fueling/lifestyle/shoe keyword
// lists AND the matcher, so the per-activity flags (strava.ts), the aggregate
// flag block + persisted injuryLog (coach-prompt.ts), and build-history all agree.
//
// Matching is WORD-BOUNDARY based, not bare substring. Bare `.includes()` produced
// false positives that could make the coach wrongly prescribe rest — e.g.
// "finishing strong" → "shin", "reached a new PR" → "ache", "chipped away" → "hip",
// "ate a bagel" → "gel". Word boundaries fix all of those while still catching the
// real words ("took a gel", "knee felt tight").

export const INJURY_KEYWORDS = [
  "knee", "shin", "hip", "it band", "plantar", "ankle", "calf", "hamstring",
  "quad", "achilles", "pain", "sore", "soreness", "tight", "tightness", "strain",
  "sprain", "limp", "ache", "hurt", "tweak", "tweaked", "foot",
];

export const ILLNESS_KEYWORDS = [
  "cold", "sick", "flu", "fever", "congested", "congestion", "coughing", "cough",
  "runny", "sinus", "throat", "ill", "illness", "sneezing", "headache", "body ache",
];

// Muscle/GI cramps late in a run are an electrolyte/fueling/hydration signal, so
// "cramp" lives here (not injury) — one home only, to avoid double-routing a note.
export const FUELING_KEYWORDS = [
  "gel", "gu", "shot blok", "blok", "chew", "nutrition", "fueled", "bonked", "bonk",
  "hit the wall", "cramp", "cramped", "cramping", "stomach", "gi issue",
];

export const LIFESTYLE_KEYWORDS = [
  "cigarette", "smoke", "smoked", "alcohol", "beer", "wine", "drinking", "drunk",
  "hungover", "hangover", "no sleep", "tired", "exhausted",
];

export const SHOE_KEYWORDS = [
  "new shoe", "new sneaker", "blister", "rubbing", "too tight", "too big",
  "too small", "clenching", "hot spot", "breaking in", "broke in", "shoe fit", "lace",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns the first keyword found as a whole word (case-insensitive), or undefined.
export function matchKeyword(text: string | undefined, keywords: string[]): string | undefined {
  if (!text) return undefined;
  for (const kw of keywords) {
    if (new RegExp(`\\b${escapeRegex(kw)}\\b`, "i").test(text)) return kw;
  }
  return undefined;
}

export function hasKeyword(text: string | undefined, keywords: string[]): boolean {
  return matchKeyword(text, keywords) !== undefined;
}
