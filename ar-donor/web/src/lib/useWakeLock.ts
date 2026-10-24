import { useEffect, useRef } from "react";

/**
 * Keep the screen awake while a live guidance session is active.
 *
 * A technician with both hands inside a machine can't tap the screen to stop it
 * dimming mid-procedure. Uses the Screen Wake Lock API where available
 * (Chrome/Edge desktop + Android, Quest Browser, Safari 16.4+) and quietly does
 * nothing elsewhere — it's an enhancement, never a requirement.
 *
 * The lock is auto-released by the browser when the tab is hidden; we re-acquire
 * on visibilitychange so coming back to the tab restores it.
 */
export function useWakeLock(active: boolean) {
  // WakeLockSentinel type may be absent from older TS lib targets; keep it loose.
  const sentinelRef = useRef<any>(null);

  useEffect(() => {
    const wakeLock: any = (navigator as any).wakeLock;
    if (!active || !wakeLock?.request) return; // unsupported -> no-op

    let cancelled = false;

    const acquire = async () => {
      try {
        const s = await wakeLock.request("screen");
        if (cancelled) {
          s.release().catch(() => {});
          return;
        }
        sentinelRef.current = s;
      } catch {
        /* denied (low battery / policy) — cosmetic, ignore */
      }
    };

    const onVisibility = () => {
      // The browser silently releases the lock when the tab hides; take it back
      // when the technician returns.
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      sentinelRef.current?.release?.().catch?.(() => {});
      sentinelRef.current = null;
    };
  }, [active]);
}
