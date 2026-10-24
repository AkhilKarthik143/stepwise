import { afterEach, describe, expect, it, vi } from "vitest";
import { primeAudioContext, type AudioCtxHolder } from "./audioContext";

/**
 * Fake AudioContext: lets a test drive `state` and observe resume()/construction.
 * `startState` mimics the platform parking a freshly-built context SUSPENDED
 * (iOS/Safari) vs RUNNING (desktop Chrome) at construction time.
 */
function makeFakeCtx(startState: AudioContextState = "running") {
  const resume = vi.fn(() => Promise.resolve());
  let constructed = 0;
  class FakeCtx {
    state: AudioContextState;
    resume = resume;
    constructor() {
      constructed++;
      this.state = startState;
    }
  }
  return {
    Ctx: FakeCtx as unknown as typeof AudioContext,
    resume,
    constructedCount: () => constructed,
  };
}

function withWindow(props: Record<string, unknown>): void {
  (globalThis as any).window = props;
}

afterEach(() => {
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

describe("primeAudioContext", () => {
  it("constructs a context on first call and stores it on the holder", () => {
    const { Ctx, constructedCount } = makeFakeCtx("running");
    withWindow({ AudioContext: Ctx });
    const holder: AudioCtxHolder = { current: null };

    const ctx = primeAudioContext(holder);

    expect(ctx).not.toBeNull();
    expect(holder.current).toBe(ctx);
    expect(constructedCount()).toBe(1);
  });

  it("reuses the existing context — never constructs a second (idempotent)", () => {
    const { Ctx, constructedCount } = makeFakeCtx("running");
    withWindow({ AudioContext: Ctx });
    const holder: AudioCtxHolder = { current: null };

    const a = primeAudioContext(holder);
    const b = primeAudioContext(holder);

    expect(a).toBe(b);
    expect(constructedCount()).toBe(1);
  });

  it("resumes a SUSPENDED context (the iOS-after-await case)", () => {
    const { Ctx, resume } = makeFakeCtx("suspended");
    withWindow({ AudioContext: Ctx });
    const holder: AudioCtxHolder = { current: null };

    primeAudioContext(holder);

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("does NOT resume a context that is already running", () => {
    const { Ctx, resume } = makeFakeCtx("running");
    withWindow({ AudioContext: Ctx });
    const holder: AudioCtxHolder = { current: null };

    primeAudioContext(holder);

    expect(resume).not.toHaveBeenCalled();
  });

  it("falls back to webkitAudioContext when the standard one is absent (older iOS Safari)", () => {
    const { Ctx, constructedCount } = makeFakeCtx("suspended");
    withWindow({ webkitAudioContext: Ctx });
    const holder: AudioCtxHolder = { current: null };

    const ctx = primeAudioContext(holder);

    expect(ctx).not.toBeNull();
    expect(constructedCount()).toBe(1);
  });

  it("returns null (no throw) when Web Audio is unavailable", () => {
    withWindow({}); // neither AudioContext nor webkitAudioContext
    const holder: AudioCtxHolder = { current: null };

    expect(primeAudioContext(holder)).toBeNull();
    expect(holder.current).toBeNull();
  });

  it("swallows a constructor that throws — returns null, never breaks the call", () => {
    class Boom {
      constructor() {
        throw new Error("AudioContext construction blocked");
      }
    }
    withWindow({ AudioContext: Boom as unknown as typeof AudioContext });
    const holder: AudioCtxHolder = { current: null };

    expect(primeAudioContext(holder)).toBeNull();
  });

  it("attaches a .catch to a rejecting resume() so the rejection is swallowed", () => {
    // Deterministic (no timers): the rejected promise records whether the helper
    // attached a handler. spyOn calls THROUGH to the real Promise.prototype.catch,
    // so the rejection is genuinely handled here — no leaked unhandled rejection.
    // The load-bearing assertion is catchSpy being called once: if primeAudioContext
    // ever drops `.catch(() => {})` on resume(), catchSpy is never called and this
    // test goes red (verified by mutation — see commit notes).
    const rejected = Promise.reject(new Error("still blocked"));
    const catchSpy = vi.spyOn(rejected, "catch");
    const resume = vi.fn(() => rejected);
    class FakeCtx {
      state: AudioContextState = "suspended";
      resume = resume;
    }
    withWindow({ AudioContext: FakeCtx as unknown as typeof AudioContext });
    const holder: AudioCtxHolder = { current: null };

    const ctx = primeAudioContext(holder);

    expect(ctx).not.toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(catchSpy).toHaveBeenCalledTimes(1); // helper swallowed the rejection
  });

  it("returns null when window is undefined (SSR / non-browser)", () => {
    // no withWindow() — window stays absent
    const holder: AudioCtxHolder = { current: null };
    expect(primeAudioContext(holder)).toBeNull();
  });
});
