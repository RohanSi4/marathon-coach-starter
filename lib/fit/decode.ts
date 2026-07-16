// ─── FIT file decoding (thin wrapper over the official Garmin SDK) ────────────
// CRC-validates before decoding: a failed integrity check on an iCloud file almost
// always means a partially-materialized sync — the caller quarantines and retries
// next import rather than ingesting garbage.
import { Decoder, Stream } from "@garmin/fitsdk";

// The SDK's FitMessages type is broad; we name just the slices we consume.
export interface FitMessages {
  sessionMesgs?: Array<Record<string, unknown>>;
  recordMesgs?: Array<Record<string, unknown>>;
  activityMesgs?: Array<Record<string, unknown>>;
  lapMesgs?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export type DecodeResult =
  | { ok: true; messages: FitMessages; warnings: string[] }
  | { ok: false; reason: string };

export function decodeFit(buf: Uint8Array): DecodeResult {
  let stream: InstanceType<typeof Stream>;
  try {
    stream = Stream.fromBuffer(buf);
  } catch (e) {
    return { ok: false, reason: `unreadable buffer: ${(e as Error).message}` };
  }

  const decoder = new Decoder(stream);
  if (!decoder.isFIT()) return { ok: false, reason: "not a FIT file" };
  if (!decoder.checkIntegrity()) {
    return { ok: false, reason: "CRC/integrity check failed (likely partial iCloud sync — will retry)" };
  }

  const { messages, errors } = decoder.read({
    applyScaleAndOffset: true,
    convertDateTimesToDates: true,
    expandComponents: true,
    mergeHeartRates: true,
  });

  return {
    ok: true,
    messages: messages as unknown as FitMessages,
    warnings: (errors ?? []).map((e: Error) => e.message),
  };
}
