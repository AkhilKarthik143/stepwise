/**
 * Shared Web Audio context for the level meters — create-once + resume.
 *
 * WHY this is a helper (and why the CALL SITE matters): on iOS/Safari an
 * AudioContext first touched AFTER an `await` is born SUSPENDED — the
 * user-gesture call stack that would authorize it has already unwound — and a
 * suspended context reads flat zero. That made the mic level meter look dead on
 * iPad until the user happened to tap Mute (the next real gesture). Calling
 * this SYNCHRONOUSLY inside the Connect-button gesture, before any await, lets
 * iOS start the context running so the meter is live from the first frame.
 *
 * Best-effort by contract: the meter is cosmetic and must NEVER break the call.
 * Every failure path (no Web Audio, constructor throw, resume rejection)
 * returns null or no-ops instead of throwing.
 */
export interface AudioCtxHolder {
  /** Structurally matches React's MutableRefObject<AudioContext | null>. */
  current: AudioContext | null;
}

type WebkitWindow = typeof globalThis & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

/**
 * Ensure `holder.current` is a live, running AudioContext.
 *  - creates it on first call (stored back on the holder for reuse),
 *  - resumes it if the platform parked it SUSPENDED,
 *  - returns the context, or null if Web Audio is unavailable / construction failed.
 *
 * Idempotent: safe to call at gesture time AND again when wiring the analyser.
 */
export function primeAudioContext(holder: AudioCtxHolder): AudioContext | null {
  try {
    const w = (typeof window !== "undefined" ? window : undefined) as WebkitWindow | undefined;
    const Ctx = w?.AudioContext ?? w?.webkitAudioContext;
    if (!Ctx) return null;
    if (!holder.current) holder.current = new Ctx();
    if (holder.current.state === "suspended") {
      // resume() returns a promise; a rejection (rare, e.g. policy still
      // blocking) must not surface — a later real gesture retries.
      void holder.current.resume().catch(() => {});
    }
    return holder.current;
  } catch {
    return null;
  }
}
