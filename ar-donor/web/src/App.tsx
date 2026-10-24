import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { detectCapabilities, type Capabilities } from "./lib/capabilities";
import { useWebRTC } from "./lib/useWebRTC";
import { useWakeLock } from "./lib/useWakeLock";
import { captureAnnotatedSnapshot, saveSnapshot, type PendingSnapshot } from "./lib/snapshot";
import { Hud2D } from "./components/Hud2D";
import { CameraBackground } from "./components/CameraBackground";
import { AnnotationOverlay } from "./components/AnnotationOverlay";
import { CaptionBar } from "./components/CaptionBar";
import { AnnotationHistory } from "./components/AnnotationHistory";
import { SessionSummaryModal } from "./components/SessionSummaryModal";
import { PastJobs } from "./components/PastJobs";
import { NotebookPicker } from "./components/NotebookPicker";
import { ProcedureTracker } from "./components/ProcedureTracker";
import { SolutionPanel } from "./components/SolutionPanel";
import { AnchoredDiagram } from "./components/AnchoredDiagram";
import { LoginGate } from "./components/LoginGate";
import { ChatPanel } from "./components/ChatPanel";
import { SolutionsPanel } from "./components/SolutionsPanel";
import { apiUrl } from "./lib/api";
import type { SessionSummary } from "./lib/useWebRTC";
import type { SceneApi } from "./components/Scene";

// Code-split the 3D stack (three / r3f / xr / uikit / drei). The camera feed and
// the 2D HUD paint immediately; the Scene chunk (and the XR store it owns) streams
// in right after, so a phone/display-glasses user is never blocked on WebGL they
// may not even use. NOTE: do not import anything from @react-three/* at this app
// entry — that would statically pull the heavy stack back into the eager bundle.
const Scene = lazy(() => import("./components/Scene").then((m) => ({ default: m.Scene })));

export function App() {
  const [caps, setCaps] = useState<Capabilities>({
    tier: "T0-hud",
    arSupported: false,
    details: "Detecting…",
  });
  // The Scene hands us an AR-entry handle once it has mounted (and the XR manager
  // exists). Until then the "Enter AR" button stays disabled.
  const [sceneApi, setSceneApi] = useState<SceneApi | null>(null);
  // A past job opened from the history browser (idle screen).
  const [viewedJob, setViewedJob] = useState<SessionSummary | null>(null);
  // Login gate. "checking" until /health says whether auth is required; then
  // "login" (no stored token) or "app". The server enforces auth on /offer +
  // /ice-config regardless — this gate is the UX layer, so it fails OPEN: if
  // /health is unreachable we show the app and let the API surface its own 401.
  const [gate, setGate] = useState<"checking" | "login" | "app">("checking");
  const [authRequired, setAuthRequired] = useState(false);
  // True once the initial /health check has been slow enough to suggest the
  // backend is cold-starting (free hosts sleep when idle) — drives a friendlier
  // "waking up" message instead of a silent spinner.
  const [slowWake, setSlowWake] = useState(false);
  // Typed chat lane (text + image + generated images), separate from the voice call.
  const [showChat, setShowChat] = useState(false);
  // Company Solution Memory (past solved cases), scoped per tenant server-side.
  const [showSolutions, setShowSolutions] = useState(false);
  // Screen capture is desktop-only (phone browsers don't expose getDisplayMedia).
  const screenSupported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function";
  const {
    state,
    log,
    annotations,
    connect,
    disconnect,
    addLog,
    aiActivity,
    speaking,
    liveCaption,
    transcript,
    micMuted,
    toggleMic,
    micLevel,
    micSilent,
    annotationHistory,
    recallAnnotation,
    lastError,
    audioBlocked,
    resumeAudio,
    sendText,
    summary,
    dismissSummary,
    openRecord,
    hasRecord,
    snapshotRequest,
    procedureSteps,
    model,
    dismissModel,
    setModelStep,
    groundedBy,
  } = useWebRTC();

  // 'm' toggles the mic while connected (skipped when typing in an input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "m" && e.key !== "M") return;
      // Ignore auto-repeat (holding the key would strobe the mic) and
      // browser/OS chords like Ctrl+M / Alt+M.
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable))
        return;
      toggleMic();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMic]);
  // Keep the screen awake during live guidance (no-op where unsupported).
  useWakeLock(state === "connected" || state === "reconnecting");

  useEffect(() => {
    let alive = true;
    detectCapabilities().then((c) => {
      if (alive) setCaps(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Decide whether to show the login gate. Ask the backend if auth is on; if so
  // and we have no stored token, gate. Fails OPEN on a health error (see `gate`).
  useEffect(() => {
    let alive = true;
    // After a few seconds with no answer, assume the backend is waking from
    // sleep (free-tier cold start) and show the reassuring message.
    const slowTimer = window.setTimeout(() => {
      if (alive) setSlowWake(true);
    }, 3500);

    // One /health attempt with a generous timeout; a cold start resolves in
    // ~50s, so abort only well past that. Retry once on a hard failure (a brief
    // 502 during wake) before deciding.
    const probe = async (): Promise<Response> => {
      const ctrl = new AbortController();
      const to = window.setTimeout(() => ctrl.abort(), 120_000);
      try {
        return await fetch(apiUrl("/health"), { signal: ctrl.signal });
      } finally {
        window.clearTimeout(to);
      }
    };

    (async () => {
      let r: Response | null = null;
      try {
        r = await probe();
        if (!r.ok) throw new Error(`health ${r.status}`);
      } catch {
        // Wake-up blip: wait briefly and try once more before giving up.
        await new Promise((res) => setTimeout(res, 2000));
        try {
          r = await probe();
          if (!r.ok) r = null;
        } catch {
          r = null;
        }
      }
      if (!alive) return;
      try {
        const h = r ? await r.json().catch(() => ({})) : {};
        const required = Boolean(h && (h as { auth_required?: boolean }).auth_required);
        setAuthRequired(required);
        if (!required) {
          setGate("app");
          return;
        }
        let token = "";
        try {
          token = window.localStorage.getItem("apiToken") || "";
        } catch {
          /* storage blocked — treat as no token */
        }
        setGate(token ? "app" : "login");
      } catch {
        // Backend unreachable after retries: don't hard-lock the UI. The API
        // itself still rejects unauthenticated /offer calls, so this is safe.
        if (alive) setGate("app");
      }
    })();
    return () => {
      alive = false;
      window.clearTimeout(slowTimer);
    };
  }, []);

  const handleSignOut = useCallback(() => {
    try {
      window.localStorage.removeItem("apiToken");
    } catch {
      /* ignore */
    }
    setGate("login");
  }, []);

  // iOS holds a voice-captured photo here (no gesture to share) for a tap-to-save.
  const [pendingSnapshot, setPendingSnapshot] = useState<PendingSnapshot | null>(null);

  const handleSnapshot = useCallback(
    async (fromGesture = true) => {
      const res = await captureAnnotatedSnapshot("camera-bg", annotations, fromGesture);
      if (res.pending) {
        // iOS, voice-triggered: held for a one-tap save (a download would
        // navigate Safari away and kill the live session).
        setPendingSnapshot((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return res.pending!;
        });
        addLog("Snapshot ready — tap “Save photo” to keep it.");
      } else {
        addLog(res.ok ? "Snapshot saved." : "Snapshot failed — couldn't capture the camera view.");
      }
    },
    [annotations, addLog],
  );

  const saveHeldSnapshot = useCallback(async () => {
    if (!pendingSnapshot) return;
    const ok = await saveSnapshot(pendingSnapshot.file); // gesture → iOS share sheet
    if (ok) {
      URL.revokeObjectURL(pendingSnapshot.url);
      setPendingSnapshot(null);
      addLog("Snapshot saved.");
    }
  }, [pendingSnapshot, addLog]);

  // Drop a held (unsaved) voice snapshot when the session ends, so a stale
  // "Save photo" pill never lingers into the next session and its blob URL/File
  // don't leak. iOS-only in practice (desktop never holds one).
  useEffect(() => {
    if (state === "idle" || state === "error") {
      setPendingSnapshot((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
    }
  }, [state]);

  // Voice-requested snapshots (the AI's take_snapshot tool) run the same capture
  // as the Snap button, but WITHOUT a user gesture. Skips the initial 0.
  useEffect(() => {
    if (snapshotRequest > 0) void handleSnapshot(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotRequest]);

  const handleEnterAR = useCallback(async () => {
    if (!sceneApi) {
      addLog("AR is still initializing — try again in a moment.");
      return;
    }
    try {
      await sceneApi.enterAR();
    } catch (e) {
      // User-denied consent, an unsupported required feature, or a not-yet-ready
      // session — surface it instead of an unhandled promise rejection.
      addLog("Could not start AR: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [sceneApi, addLog]);

  if (gate === "checking") {
    return (
      <div className="login-gate">
        <div className="login-card login-card--loading">
          {slowWake ? (
            <>
              <span>Waking up the server…</span>
              <span className="login-sub">First load can take up to a minute.</span>
            </>
          ) : (
            "Loading…"
          )}
        </div>
      </div>
    );
  }

  if (gate === "login") {
    return <LoginGate onAuthed={() => setGate("app")} />;
  }

  return (
    <div className="app">
      {/* z0: camera feed (the technician's view on non-immersive devices). */}
      <CameraBackground />

      {/* z30: typed chat lane (text + image upload + AI-generated images +
          on-demand NVIDIA detection), independent of the live voice session. */}
      {!showChat && (
        <button className="chat-fab" onClick={() => setShowChat(true)} title="Open chat" aria-label="Open chat">
          💬
        </button>
      )}
      <ChatPanel visible={showChat} onClose={() => setShowChat(false)} />
      <SolutionsPanel visible={showSolutions} onClose={() => setShowSolutions(false)} />

      {/* z1: r3f Canvas + WebXR + in-AR spatial HUD + world-anchored markers.
          Mounted ONLY where immersive AR is possible — on iOS/iPad (no WebXR)
          it can never enter AR and would just burn a WebGL context + battery and
          download the three stack for nothing; the 2D overlay (z5) is the
          universal baseline there. Lazy + falls back to nothing. */}
      {caps.arSupported && (
        <Suspense fallback={null}>
          <Scene status={state} annotations={annotations} onReady={setSceneApi} />
        </Suspense>
      )}

      {/* z5: Gemini-driven component highlights over the camera view (2D, the
          universal baseline — always on, every device). */}
      <AnnotationOverlay annotations={annotations} />

      {/* z7: live captions + session transcript of the AI's spoken guidance. */}
      <CaptionBar live={liveCaption} transcript={transcript} />

      {/* z8: tap-to-recall rail of every mark the AI has drawn this session. */}
      <AnnotationHistory history={annotationHistory} onRecall={recallAnnotation} />

      {/* z8: the AI's numbered steps as glanceable progress (left edge).
          Rendered only during a live session — on the error screen it would sit
          behind the error card; the steps STATE still survives for reconnect. */}
      {(state === "connected" || state === "reconnecting") && (
        <ProcedureTracker steps={procedureSteps} />
      )}

      {/* z9: the AI's explanatory 3D/2D diagram (show_model tool). Floating card,
          right-anchored; the 3D viewer chunk loads lazily only for 3D specs. */}
      {/* z6: a 2D diagram the AI PINNED over the camera (anchor present) renders
          here, over the real equipment. If the anchor maps off-screen,
          AnchoredDiagram falls back to the floating card itself. */}
      {model && model.mode === "2d" && model.anchor && (
        <AnchoredDiagram spec={model} onClose={dismissModel} onStep={setModelStep} />
      )}

      {/* The floating card hosts everything NOT pinned: all 3D specs + un-anchored
          2D specs. (Anchored 2D shows pinned-only, to avoid a double render.) */}
      {model && !(model.mode === "2d" && model.anchor) && (
        <SolutionPanel spec={model} onClose={dismissModel} onStep={setModelStep} />
      )}

      {/* iOS: a voice-captured photo waiting for a one-tap save (the tap is the
          user gesture iOS needs to open the share sheet → Save to Photos). */}
      {pendingSnapshot && (
        <button className="save-snapshot" onClick={saveHeldSnapshot}>
          <img src={pendingSnapshot.url} alt="" className="save-snapshot__thumb" />
          Save photo
        </button>
      )}

      {/* z9: runtime manual picker (idle only — backend 409s while connected). */}
      <NotebookPicker visible={state === "idle"} />

      {/* z9: past-jobs browser (idle/error screens — records survive reloads). */}
      <PastJobs
        visible={state === "idle" || state === "error"}
        onView={setViewedJob}
      />

      {/* z20: end-of-session record with copy/download (shown on user End, or
          when a past job is opened from the history browser). */}
      {summary && <SessionSummaryModal summary={summary} onClose={dismissSummary} />}
      {!summary && viewedJob && (
        <SessionSummaryModal summary={viewedJob} onClose={() => setViewedJob(null)} />
      )}

      {/* z10: the always-present premium DOM HUD (T0 baseline + controls). */}
      <Hud2D
        caps={caps}
        state={state}
        log={log}
        onConnect={connect}
        onDisconnect={disconnect}
        onEnterAR={handleEnterAR}
        onConnectScreen={() => connect("screen")}
        onOpenChat={() => setShowChat(true)}
        onOpenSolutions={() => setShowSolutions(true)}
        screenSupported={screenSupported}
        arReady={sceneApi !== null}
        aiActivity={aiActivity}
        groundedBy={groundedBy}
        speaking={speaking}
        micMuted={micMuted}
        onToggleMic={toggleMic}
        micLevel={micLevel}
        micSilent={micSilent}
        lastError={lastError}
        audioBlocked={audioBlocked}
        onResumeAudio={resumeAudio}
        onSendText={sendText}
        hasRecord={hasRecord}
        onViewRecord={openRecord}
        onSnapshot={() => handleSnapshot(true)}
        onSignOut={authRequired ? handleSignOut : undefined}
      />
    </div>
  );
}
