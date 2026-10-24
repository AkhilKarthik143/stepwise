import { useCallback, useEffect, useRef, useState } from "react";
import { saveJob } from "./jobHistory";
import {
  applyProcedureAnnotation,
  applyProcedureClear,
  type ProcedureStep,
} from "./procedure";
import { normalizeModelSpec, matchLabels, maxStep, type ModelSpec } from "./solutionModel";
import { mergeTitles } from "./sources";
import { primeAudioContext } from "./audioContext";
import { apiUrl } from "./api";

export type { ProcedureStep };
export type { ModelSpec } from "./solutionModel";

/**
 * WebRTC connect flow as a React hook — a faithful port of the hardened v1
 * client logic (thisPc snapshot guards, track-ended detection, transient-ICE
 * reconnect grace), so all of v1's robustness carries into the r3f UI.
 *
 * Step 3 adds a data channel: the backend pushes `annotate` events (component
 * highlights from Gemini) which become auto-expiring `Annotation`s.
 */
export type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export type AnnotationShape = "box" | "point" | "arrow";
export type AnnotationLevel = "info" | "warn" | "danger";

export interface Annotation {
  id: string;
  label: string;
  detail: string;
  /** [ymin, xmin, ymax, xmax], normalized 0-1000 (Gemini spatial convention). */
  box: [number, number, number, number];
  /** How to draw it: outline, precise pin, or pointer arrow. */
  shape: AnnotationShape;
  /** Severity colour: green / amber / red. */
  level: AnnotationLevel;
  /** Optional 1-based step number for an ordered procedure. */
  step?: number;
  /** When this annotation arrived (ms epoch) — drives the freshness fade. */
  createdAt: number;
  expiresAt: number;
  /** True when re-shown from history: the spatial anchor is STALE (the camera
   *  has moved since the AI drew it) — rendered dashed + badged, never as live. */
  recalled?: boolean;
}

export interface TranscriptTurn {
  id: number;
  text: string;
  at: number;
  /** Who said it: the AI (spoken, transcribed) or the technician (typed). */
  role: "assistant" | "user";
  /** Manual source title(s) that grounded this answer (assistant turns only),
   *  so a recovered transcript names what backed each spoken value. */
  sources?: string[];
}

/** Snapshot of a finished session, captured at user End for review/export. */
export interface SessionSummary {
  transcript: TranscriptTurn[];
  marks: Annotation[];
  startedAt: number;
  endedAt: number;
  /** The AI's explanatory diagram active when the session ended, if any — the
   *  richest artifact and the one a technician most wants to recover later. */
  model?: ModelSpec | null;
}

const STUN = "stun:stun.l.google.com:19302";
const ANNOTATION_TTL_MS = 8000;
const MAX_ANNOTATIONS = 6;
const MAX_TRANSCRIPT_TURNS = 50;
const MAX_ANNOTATION_HISTORY = 25;
// Fallback that force-clears the "Checking the manual…" indicator if the
// authoritative idle event is ever LOST on the wire. It must sit ABOVE the
// backend lookup timeout (NOTEBOOKLM_TIMEOUT_SECONDS, default 90s) — otherwise a
// legitimately slow cold-start/queued lookup trips it and the indicator lies
// ("idle") while the AI is still consulting the manual. The backend always emits
// idle within that timeout (via its finally), so reaching this means a drop.
const LOOKUP_INDICATOR_SAFETY_MS = 100_000;
const SHAPES: AnnotationShape[] = ["box", "point", "arrow"];
const LEVELS: AnnotationLevel[] = ["info", "warn", "danger"];

export function useWebRTC(opts?: {
  remoteAudioId?: string;
  localVideoId?: string;
  cameraBgId?: string;
}) {
  const remoteAudioId = opts?.remoteAudioId ?? "remote-audio";
  const localVideoId = opts?.localVideoId ?? "local-video";
  const cameraBgId = opts?.cameraBgId ?? "camera-bg";

  const [state, setState] = useState<ConnState>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // What the AI is doing right now: consulting the manual ("lookup") or not.
  const [aiActivity, setAiActivity] = useState<"idle" | "lookup">("idle");
  // The manual source(s) grounding the AI's current/just-given answer — a live
  // "grounded by …" provenance chip. Buffered in a ref so it attaches to the
  // assistant turn at commit (the sources event lands before transcript_done).
  const [groundedBy, setGroundedBy] = useState<string[]>([]);
  const pendingSourcesRef = useRef<string[]>([]);
  // True while the AI's voice is audibly playing (Web Audio level meter).
  const [speaking, setSpeaking] = useState(false);
  // Live caption (the in-progress spoken sentence) + committed transcript turns.
  const [liveCaption, setLiveCaption] = useState("");
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const turnIdRef = useRef(0);
  // Mirror of liveCaption for the commit handler (avoids stale-closure reads).
  const liveCaptionRef = useRef("");
  // Incremented when the AI requests a snapshot (take_snapshot tool) — the App
  // watches this and runs the same capture as the Snap button.
  const [snapshotRequest, setSnapshotRequest] = useState(0);
  // The AI-composed explanatory diagram (show_model tool), or null when hidden.
  const [model, setModel] = useState<ModelSpec | null>(null);
  // The technician's in-progress spoken utterance (inputAudioTranscription
  // fragments). Committed as a "You" turn when the AI starts answering or
  // after a short idle gap — there is no explicit user-turn-complete signal.
  const userCaptionRef = useRef("");
  const userCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mic mute: track.enabled=false keeps the track LIVE (silent frames flow, so
  // the backend pipeline + device-loss detection stay untouched) but the AI
  // hears nothing — no accidental barge-in from a nearby conversation.
  const [micMuted, setMicMuted] = useState(false);
  // Ref mirror so toggleMic's side effects stay OUT of the setState updater
  // (React updaters must be pure — StrictMode double-invokes them in dev).
  const micMutedRef = useRef(false);
  // Every mark the AI ever drew this session (latest-first, deduped by label,
  // surviving TTL expiry) — feeds the tap-to-recall history rail.
  const [annotationHistory, setAnnotationHistory] = useState<Annotation[]>([]);
  // The AI's numbered steps as a glanceable progress list. Done-states are
  // HEURISTIC (later-step arrival / explicit clear) — progress tracking, not a
  // safety interlock.
  const [procedureSteps, setProcedureSteps] = useState<ProcedureStep[]>([]);
  // Ref mirrors so snapshot logic (session summary) can read the latest values
  // without putting side effects inside setState updaters.
  const transcriptRef = useRef<TranscriptTurn[]>([]);
  const historyRef = useRef<Annotation[]>([]);
  // Mirror of `model` so the record-building paths (disconnect/openRecord/the
  // teardown safety-net) can read the active diagram without a stale closure
  // and while keeping setState updaters pure.
  const modelRef = useRef<ModelSpec | null>(null);
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  useEffect(() => {
    historyRef.current = annotationHistory;
  }, [annotationHistory]);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  // Snapshot of a finished session (set on user End) — drives the summary
  // modal with copy/download, so ending a job doesn't destroy its record.
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const sessionStartRef = useRef(0);
  // startedAt of the last EXPLICITLY saved record (disconnect/openRecord) — the
  // teardown safety-net save skips when the authoritative snapshot (which
  // includes the flushed half-turns) was already persisted for this session.
  const savedAtRef = useRef(0);
  // When the session actually DIED (teardown time) — openRecord uses this so a
  // record exported ten minutes after a drop doesn't claim a longer session.
  const sessionEndRef = useRef(0);
  // True only while a session is genuinely live (SDP answer applied -> first
  // teardown). Guards the end-time stamp + safety-net save: a FAILED Retry
  // also runs teardown, and without the guard it would overwrite the dead
  // session's recorded end time (silent duration corruption in job history).
  const sessionLiveRef = useRef(false);
  // Operator-language description of the last fatal error (drives the Retry card).
  const [lastError, setLastError] = useState<string | null>(null);
  // True when the remote audio element's play() was blocked (iOS/Safari autoplay)
  // — the AI is talking but the technician hears nothing until a user gesture.
  const [audioBlocked, setAudioBlocked] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  // The AI link (Gemini) status is a separate dimension from the WebRTC transport.
  // We track it here so the two don't clobber each other's displayed state.
  const aiReconnectingRef = useRef(false);
  // Safety: auto-clear a stuck "lookup" indicator if the idle event never lands
  // (e.g. the data channel dropped mid-lookup).
  const activityResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Web Audio meters (one shared AudioContext; closed on teardown).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterIvRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const micMeterIvRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const remoteMeterStartedRef = useRef(false);
  // Local mic level (0..1, smoothed) + "no mic signal" warning.
  const [micLevel, setMicLevel] = useState(0);
  const [micSilent, setMicSilent] = useState(false);
  const micSilentSinceRef = useRef(0);

  // Prune expired annotations on a timer. The +750ms grace lets the overlay's
  // 700ms exit fade reach ~0 before the element is unmounted — without it the
  // prune could land mid-transition and pop a still-visible marker out.
  useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now();
      setAnnotations((a) => {
        const fresh = a.filter((x) => x.expiresAt + 750 > now);
        return fresh.length === a.length ? a : fresh;
      });
    }, 500);
    return () => clearInterval(iv);
  }, []);

  const addLog = useCallback((m: string) => {
    // eslint-disable-next-line no-console
    console.log(m);
    setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 12));
  }, []);

  // Commit the technician's accumulated spoken words as a "You" turn.
  const commitUserTurn = useCallback(() => {
    if (userCommitTimerRef.current) {
      clearTimeout(userCommitTimerRef.current);
      userCommitTimerRef.current = null;
    }
    const t = userCaptionRef.current.trim();
    userCaptionRef.current = "";
    if (t) {
      setTranscript((tr) =>
        [...tr, { id: ++turnIdRef.current, text: t, at: Date.now(), role: "user" as const }].slice(
          -MAX_TRANSCRIPT_TURNS
        )
      );
    }
  }, []);

  // Commit the AI's half-spoken sentence (the in-flight caption) so it is never
  // silently lost — used by every path that ends or interrupts a turn early.
  const commitAssistantPartial = useCallback(() => {
    const partial = liveCaptionRef.current.trim();
    liveCaptionRef.current = "";
    setLiveCaption("");
    if (partial) {
      const src = pendingSourcesRef.current;
      setTranscript((tr) =>
        [
          ...tr,
          {
            id: ++turnIdRef.current,
            text: partial + " — (interrupted)",
            at: Date.now(),
            role: "assistant" as const,
            ...(src.length ? { sources: [...src] } : {}),
          },
        ].slice(-MAX_TRANSCRIPT_TURNS)
      );
    }
    pendingSourcesRef.current = [];
    setGroundedBy([]);
  }, []);

  const teardown = useCallback(() => {
    // Flush both half-turns into the transcript FIRST (no-ops when empty): on
    // involuntary endings the record survives for review, and a half-spoken
    // torque spec must not vanish with the session. disconnect() clears the
    // refs before calling teardown, so its snapshot is never double-committed.
    commitUserTurn();
    commitAssistantPartial();
    // Only a LIVE session's death stamps the end time and safety-net-saves —
    // a failed Retry's teardown must not overwrite the dead session's record.
    if (sessionLiveRef.current) {
      sessionLiveRef.current = false;
      sessionEndRef.current = Date.now();
      // Safety-net persistence for INVOLUNTARY endings: an errored session's
      // record must reach localStorage even if the technician taps Retry or
      // reloads without ever opening it. Skipped when disconnect()/openRecord()
      // already saved the richer snapshot for this same session (dedupe by
      // startedAt would otherwise let this partial-less version overwrite it).
      if (
        (transcriptRef.current.length || historyRef.current.length || modelRef.current) &&
        savedAtRef.current !== sessionStartRef.current
      ) {
        saveJob({
          transcript: transcriptRef.current,
          marks: historyRef.current,
          model: modelRef.current,
          startedAt: sessionStartRef.current || Date.now(),
          endedAt: sessionEndRef.current,
        });
      }
    }
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
    aiReconnectingRef.current = false;
    if (activityResetRef.current) {
      clearTimeout(activityResetRef.current);
      activityResetRef.current = null;
    }
    setAiActivity("idle");
    setGroundedBy([]);
    pendingSourcesRef.current = [];
    if (meterIvRef.current) {
      clearInterval(meterIvRef.current);
      meterIvRef.current = null;
    }
    if (micMeterIvRef.current) {
      clearInterval(micMeterIvRef.current);
      micMeterIvRef.current = null;
    }
    remoteMeterStartedRef.current = false;
    micSilentSinceRef.current = 0;
    setMicLevel(0);
    setMicSilent(false);
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setSpeaking(false);
    liveCaptionRef.current = "";
    setLiveCaption("");
    userCaptionRef.current = "";
    if (userCommitTimerRef.current) {
      clearTimeout(userCommitTimerRef.current);
      userCommitTimerRef.current = null;
    }
    micMutedRef.current = false;
    setMicMuted(false);
    setAudioBlocked(false);
    // NOTE: transcript + annotationHistory deliberately SURVIVE teardown — on an
    // involuntary error they are exactly the record the technician still needs
    // (torque specs, part numbers). They're cleared on user End (disconnect) and
    // at the start of the next connect() instead.
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    const s = streamRef.current;
    streamRef.current = null;
    if (s) s.getTracks().forEach((t) => t.stop());
    if (dcRef.current) {
      try {
        dcRef.current.close();
      } catch {
        /* ignore */
      }
      dcRef.current = null;
    }
    const a = document.getElementById(remoteAudioId) as HTMLAudioElement | null;
    if (a) a.srcObject = null;
    for (const id of [localVideoId, cameraBgId]) {
      const v = document.getElementById(id) as HTMLVideoElement | null;
      if (v) v.srcObject = null;
    }
    setAnnotations([]);
    // NOTE: the diagram (model) is deliberately NOT cleared here. Unlike the
    // camera-anchored annotations (whose coords go stale the instant the feed
    // dies), the solution diagram is a floating card that stays meaningful with
    // no live camera — it's part of the record the technician still needs on the
    // error screen, exactly like the transcript + marks + procedure steps above.
    // It's cleared only on user End (disconnect) and at the next connect().
  }, [remoteAudioId, localVideoId, cameraBgId, commitUserTurn, commitAssistantPartial]);

  const disconnect = useCallback(() => {
    addLog("Disconnected by user.");
    setState("idle");
    // Snapshot the record BEFORE clearing it — the summary modal offers
    // copy/download so ending the job doesn't destroy its hard-won facts.
    // Reads go through ref mirrors so every setState updater stays pure.
    // BOTH half-turns are folded in: the technician's unfinished utterance AND
    // the AI's half-spoken sentence (ending mid-answer is the most natural
    // moment to tap End — that final answer must reach the export).
    const finalUser = userCaptionRef.current.trim();
    const finalAI = liveCaptionRef.current.trim();
    userCaptionRef.current = ""; // cleared now so teardown's flush can't double-commit
    liveCaptionRef.current = "";
    const full = [...transcriptRef.current];
    if (finalUser) {
      full.push({ id: ++turnIdRef.current, text: finalUser, at: Date.now(), role: "user" as const });
    }
    if (finalAI) {
      full.push({
        id: ++turnIdRef.current,
        text: finalAI + " — (interrupted)",
        at: Date.now(),
        role: "assistant" as const,
      });
    }
    const marks = historyRef.current;
    if (full.length || marks.length || modelRef.current) {
      const snapshot: SessionSummary = {
        transcript: full,
        marks,
        model: modelRef.current,
        startedAt: sessionStartRef.current || Date.now(),
        endedAt: Date.now(),
      };
      // Persist SYNCHRONOUSLY (not via effect): PastJobs re-reads storage in a
      // child effect that runs BEFORE a parent effect would — an effect-based
      // save left the list one job stale and made the first-ever job invisible.
      saveJob(snapshot);
      savedAtRef.current = snapshot.startedAt;
      setSummary(snapshot);
    }
    setTranscript([]);
    setAnnotationHistory([]);
    setProcedureSteps([]);
    setModel(null);
    teardown();
  }, [addLog, teardown]);

  const dismissSummary = useCallback(() => setSummary(null), []);
  const dismissModel = useCallback(() => setModel(null), []);
  // Tap fallback for the playback controls (the AI drives via set_diagram_step,
  // but the tech can step manually). Local view-only; clamped to real steps.
  const setModelStep = useCallback((step: number) => {
    setModel((m) =>
      m ? { ...m, activeStep: Math.max(0, Math.min(maxStep(m.parts), Math.trunc(step) || 0)) } : m,
    );
  }, []);

  // Open the session record on demand — the involuntary-ending path. After an
  // error teardown the transcript + marks survive in place; this lets the
  // technician export them from the error card exactly like a normal End.
  const openRecord = useCallback(() => {
    const full = transcriptRef.current;
    const marks = historyRef.current;
    if (!full.length && !marks.length && !modelRef.current) return;
    const snapshot: SessionSummary = {
      transcript: full,
      marks,
      model: modelRef.current,
      startedAt: sessionStartRef.current || Date.now(),
      // The session's TRUE end time — not the moment the button was tapped.
      endedAt: sessionEndRef.current || Date.now(),
    };
    saveJob(snapshot); // sync — see disconnect()
    savedAtRef.current = snapshot.startedAt;
    setSummary(snapshot);
  }, []);

  const connect = useCallback(async (source: "camera" | "screen" = "camera") => {
    // Guard re-entry: if a connection already exists (incl. while 'reconnecting'),
    // do nothing — otherwise we'd orphan the live pc/stream/dc (camera stays on).
    if (pcRef.current) {
      addLog("Already connected; ignoring duplicate Connect.");
      return;
    }
    setState("connecting");
    setLastError(null);
    setAudioBlocked(false);
    // NOTE: the surviving record (transcript/marks) is NOT cleared here — a
    // failed Retry (getUserMedia / /offer error on a still-flaky network) must
    // leave it reviewable. It is cleared only when the new session actually
    // BEGINS (SDP answer applied, below).

    // Prime the meters' shared AudioContext HERE — synchronously, still inside
    // the Connect-button gesture, BEFORE the first await. On iOS/Safari a
    // context first touched AFTER an await is born SUSPENDED and reads flat,
    // which made the mic meter look dead on iPad until the user tapped Mute.
    // Best-effort (cosmetic); the meter wiring below reuses this same context.
    primeAudioContext(audioCtxRef);

    let stream: MediaStream;
    try {
      if (source === "screen") {
        // Desktop screen share: the AI sees a screen/window/tab instead of a
        // camera. getDisplayMedia gives no microphone, so we grab the mic
        // separately and merge; if the mic is denied we go screen-only (the tech
        // can still type in chat). Clicking the browser's "Stop sharing" ends the
        // session cleanly.
        const screen = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 5 } },
          audio: false,
        });
        let micTracks: MediaStreamTrack[] = [];
        try {
          const mic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          micTracks = mic.getAudioTracks();
        } catch {
          addLog("No microphone for screen share — screen-only (use chat to type).");
        }
        stream = new MediaStream([...screen.getVideoTracks(), ...micTracks]);
        const screenTrack = screen.getVideoTracks()[0];
        if (screenTrack) screenTrack.addEventListener("ended", () => disconnect());
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      }
    } catch (e) {
      addLog("getUserMedia failed: " + e);
      setLastError(friendlyMediaError(e));
      setState("error");
      // We primed the meters' AudioContext inside the gesture (above), but this
      // attempt never acquired media so it won't be used — release it so a
      // permission-denied-and-walk-away can't leave a context open. A Retry
      // re-primes from its own button gesture (still iOS-valid).
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      return;
    }
    streamRef.current = stream;

    for (const id of [localVideoId, cameraBgId]) {
      const v = document.getElementById(id) as HTMLVideoElement | null;
      if (v) v.srcObject = stream;
    }
    addLog("Local media acquired (" + stream.getTracks().map((t) => t.kind).join("+") + ").");

    // Local mic meter: answers the #1 live-use trust question — "is the AI
    // hearing me?" — with a live level bar, and raises a warning if the mic
    // produces no signal for a sustained window while unmuted. Reuses the
    // context primed at gesture time (above); primeAudioContext is idempotent,
    // and re-running it here also retries resume() if the platform is slow.
    try {
      const ctx = primeAudioContext(audioCtxRef);
      if (ctx) {
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        let displayed = 0;
        micMeterIvRef.current = setInterval(() => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const d = (buf[i] - 128) / 128;
            sum += d * d;
          }
          const rms = Math.sqrt(sum / buf.length);
          // Perceptual-ish scaling, quantized at the floor so the zero state is
          // STABLE (an exact-zero flicker would bypass the render throttle).
          const level = rms < 0.002 ? 0 : Math.min(1, rms * 6);
          if (Math.abs(level - displayed) > 0.06 || (level === 0) !== (displayed === 0)) {
            displayed = level;
            setMicLevel(level);
          }
          // Silent-mic detection: muted is INTENTIONAL silence, and a policy-
          // suspended AudioContext reads flat zero without meaning the mic is
          // dead — neither may raise the NO MIC SIGNAL alarm.
          if (micMutedRef.current || ctx.state !== "running" || rms > 0.004) {
            micSilentSinceRef.current = 0;
            setMicSilent(false);
          } else {
            if (!micSilentSinceRef.current) micSilentSinceRef.current = Date.now();
            else if (Date.now() - micSilentSinceRef.current > 8000) setMicSilent(true);
          }
        }, 150);
      }
    } catch {
      /* meter is cosmetic — ignore */
    }

    // Device-loss: a track ending mid-call (unplug / revoked permission) leaves
    // pc "connected" but dead — surface it instead of silent dead-air.
    stream.getTracks().forEach((t) =>
      t.addEventListener("ended", () => {
        addLog(t.kind + " track ended (device lost or permission revoked).");
        setLastError(
          `The ${t.kind === "video" ? "camera" : "microphone"} was disconnected or its ` +
            "permission was revoked. Reconnect it, then retry."
        );
        setState("error");
        teardown();
      })
    );

    // Fetch ICE servers (STUN + optional TURN) from the backend; fall back to
    // STUN. Sends the API key (when configured) — /ice-config is auth-gated
    // because the response can embed TURN credentials.
    let iceServers: RTCIceServer[] = [{ urls: STUN }];
    try {
      const iceHeaders: Record<string, string> = {};
      const iceToken = authToken();
      if (iceToken) iceHeaders["X-API-Key"] = iceToken;
      const r = await fetch(apiUrl("/ice-config"), { headers: iceHeaders });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.iceServers) && j.iceServers.length) iceServers = j.iceServers;
      }
    } catch {
      /* fall back to STUN */
    }

    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;
    const thisPc = pc; // snapshot: ignore events after teardown nulls pcRef

    pc.addEventListener("track", (evt) => {
      if (pcRef.current !== thisPc) return; // session already replaced/ended
      if (evt.track.kind === "audio") {
        const stream = evt.streams[0] || new MediaStream([evt.track]);
        const a = document.getElementById(remoteAudioId) as HTMLAudioElement | null;
        if (a) {
          a.srcObject = stream;
          a.play().catch((e) => {
            // iOS/Safari autoplay policy: the AI may be talking but inaudible
            // until a user gesture calls play() again (resumeAudio below).
            // Guarded: teardown nulls srcObject which REJECTS this still-pending
            // promise (AbortError) — without the check that late rejection would
            // resurrect a phantom 'Tap to enable audio' button after the session
            // is gone.
            if (pcRef.current !== thisPc) return;
            addLog("audio play blocked: " + e);
            setAudioBlocked(true);
          });
        }
        addLog("Receiving AI audio track.");
        // Speaking meter: a tiny analyser on the remote stream (separate Web
        // Audio graph — does NOT affect the <audio> playback). Drives the
        // "Speaking" glow so the technician sees the AI is talking even with
        // the volume low or hearing protection on. Best-effort: meter failure
        // must never break the call.
        try {
          const ctx = primeAudioContext(audioCtxRef);
          if (ctx && !remoteMeterStartedRef.current) {
            remoteMeterStartedRef.current = true;
            const src = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            src.connect(analyser);
            const buf = new Uint8Array(analyser.fftSize);
            let quietSince = 0;
            meterIvRef.current = setInterval(() => {
              analyser.getByteTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i++) {
                const d = (buf[i] - 128) / 128;
                sum += d * d;
              }
              const rms = Math.sqrt(sum / buf.length);
              if (rms > 0.02) {
                quietSince = 0;
                setSpeaking(true);
              } else {
                // Hysteresis: only drop the glow after ~400ms of silence so
                // natural speech pauses don't flicker it.
                if (!quietSince) quietSince = Date.now();
                else if (Date.now() - quietSince > 400) setSpeaking(false);
              }
            }, 120);
          }
        } catch {
          /* meter is cosmetic — ignore */
        }
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pcRef.current !== thisPc) return;
      const st = thisPc.connectionState;
      addLog("PC state: " + st);
      if (st === "connected") {
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current);
          reconnectRef.current = null;
        }
        // Transport is up, but if the AI link is mid-reconnect keep showing that.
        setState(aiReconnectingRef.current ? "reconnecting" : "connected");
      } else if (st === "disconnected") {
        // Transient — ride it out; tear down only if it stays down.
        setState("reconnecting");
        if (!reconnectRef.current) {
          reconnectRef.current = setTimeout(() => {
            reconnectRef.current = null;
            if (
              pcRef.current === thisPc &&
              (thisPc.connectionState === "disconnected" || thisPc.connectionState === "failed")
            ) {
              addLog("Still down after grace period — tearing down.");
              setLastError("The connection dropped and didn't recover — the network may be unstable. Retry, or switch to a different Wi-Fi/mobile network.");
              setState("error");
              teardown();
            }
          }, 6000);
        }
      } else if (st === "failed" || st === "closed") {
        setLastError((prev) => prev ?? "Couldn't connect the live video — your network is likely blocking the media relay. Try a different Wi-Fi or mobile network, then retry.");
        setState("error");
        teardown();
      }
    });

    // UI-event channel (created on the offer side so it's negotiated in the SDP).
    // The backend pushes `annotate` events here; we turn them into highlights.
    const dc = thisPc.createDataChannel("events");
    dcRef.current = dc;
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
        if (msg && msg.type === "status") {
          // Server ended the session (idle / time limit) — explain, don't just drop.
          if (msg.state === "ended") {
            const REASONS: Record<string, string> = {
              idle: "no camera or mic activity for a while",
              max_duration: "the session reached its time limit",
              server_shutdown: "the server is restarting — reconnect in a moment",
              ai_lost: "the AI assistant's connection was lost and couldn't be restored",
            };
            // Unknown reasons get an honest generic — never a fabricated cause.
            const reason =
              REASONS[typeof msg.reason === "string" ? msg.reason : ""] ??
              "the server ended it";
            commitUserTurn();
            setLastError(`The server ended the session (${reason}). Reconnect when ready.`);
            setState("error");
            teardown();
            return;
          }
          // Gemini link status — a separate dimension from the WebRTC transport.
          if (msg.state === "reconnecting") {
            aiReconnectingRef.current = true;
            // Flush both half-turns: the link died mid-conversation. Commit
            // what was heard (marked interrupted) so it isn't lost — and so the
            // next session's fragments can't append to it into garbled text.
            commitUserTurn();
            commitAssistantPartial();
            setState("reconnecting");
            addLog("AI link reconnecting…");
          } else if (msg.state === "connected") {
            aiReconnectingRef.current = false;
            // Only show 'connected' if the transport is actually up too.
            setState(thisPc.connectionState === "connected" ? "connected" : "reconnecting");
            addLog("AI link re-established.");
          }
          return;
        }
        // Live transcription fragments — the AI's speech (assistant) or the
        // technician's own speech (user, via inputAudioTranscription).
        if (msg && msg.type === "transcript") {
          const text = typeof msg.text === "string" ? msg.text : "";
          if (!text) return;
          if (msg.role === "user") {
            userCaptionRef.current += text;
            // Idle-gap commit: no explicit user-turn-complete signal exists.
            if (userCommitTimerRef.current) clearTimeout(userCommitTimerRef.current);
            userCommitTimerRef.current = setTimeout(commitUserTurn, 2500);
          } else {
            // The AI answering means the technician's utterance is finished —
            // commit it FIRST so the transcript reads in true order.
            commitUserTurn();
            liveCaptionRef.current += text;
            setLiveCaption(liveCaptionRef.current);
          }
          return;
        }
        // Turn finished -> commit the caption into the transcript history.
        if (msg && msg.type === "transcript_done") {
          // Input transcription often lags: flush any user fragments FIRST so
          // the question lands before its answer (not inverted after a timer).
          commitUserTurn();
          const finished = liveCaptionRef.current.trim();
          liveCaptionRef.current = "";
          setLiveCaption("");
          if (finished) {
            const src = pendingSourcesRef.current;
            setTranscript((t) =>
              [
                ...t,
                {
                  id: ++turnIdRef.current,
                  text: finished,
                  at: Date.now(),
                  role: "assistant" as const,
                  ...(src.length ? { sources: [...src] } : {}),
                },
              ].slice(-MAX_TRANSCRIPT_TURNS)
            );
          }
          // The grounded answer is done: drop the live chip so it can't linger
          // and falsely attest a source over the NEXT (ungrounded) answer.
          pendingSourcesRef.current = [];
          setGroundedBy([]);
          return;
        }
        // The AI started/finished consulting the technical manual.
        if (msg && msg.type === "activity") {
          const lookup = msg.state === "lookup";
          setAiActivity(lookup ? "lookup" : "idle");
          if (activityResetRef.current) clearTimeout(activityResetRef.current);
          activityResetRef.current = lookup
            ? setTimeout(() => setAiActivity("idle"), LOOKUP_INDICATOR_SAFETY_MS)
            : null;
          return;
        }
        // Which manual source(s) grounded the answer the AI is about to speak —
        // a live provenance chip + buffered to ride into the answer's transcript
        // turn. Defensive re-validation (server already sanitized).
        if (msg && msg.type === "sources") {
          // UNION, not replace: one spoken answer can be grounded by MULTIPLE
          // concurrent lookups (each emits its own event); a later one must not
          // overwrite an earlier one's source. Cleared at every turn boundary.
          const merged = mergeTitles(pendingSourcesRef.current, msg.titles);
          pendingSourcesRef.current = merged;
          setGroundedBy(merged);
          return;
        }
        // The AI wants a snapshot saved (voice request — gloved hands).
        if (msg && msg.type === "snapshot") {
          setSnapshotRequest((n) => n + 1);
          return;
        }
        // The AI composed an explanatory 3D/2D diagram.
        if (msg && msg.type === "model") {
          const spec = normalizeModelSpec(msg); // defensive re-validation
          if (spec) {
            setModel(spec);
            addLog(`Diagram: ${spec.title} (${spec.mode.toUpperCase()})`);
          }
          return;
        }
        if (msg && msg.type === "model_clear") {
          setModel(null);
          return;
        }
        // The AI is pointing at parts of the current diagram (highlight_model_part).
        // Emphasis rides on the active spec — match the labels against what's
        // actually drawn and drop unknowns; a no-op when no diagram is shown.
        if (msg && msg.type === "model_emphasis") {
          const labels = Array.isArray(msg.labels)
            ? (msg.labels as unknown[]).filter((l): l is string => typeof l === "string")
            : [];
          setModel((m) => (m ? { ...m, emphasis: matchLabels(m.parts, labels) } : m));
          return;
        }
        // The AI is walking the technician through the diagram step by step
        // (set_diagram_step). Clamp to the steps the active diagram actually has.
        if (msg && msg.type === "model_step") {
          const raw = Number(msg.step);
          const step = Number.isFinite(raw) ? Math.trunc(raw) : 0;
          setModel((m) =>
            m ? { ...m, activeStep: Math.max(0, Math.min(maxStep(m.parts), step)) } : m,
          );
          return;
        }
        // The AI cleared a highlight (step done / no longer relevant).
        if (msg && msg.type === "annotate_clear") {
          const lbl = typeof msg.label === "string" && msg.label.trim() ? msg.label : null;
          setAnnotations((a) => (lbl ? a.filter((x) => x.label !== lbl) : []));
          // Pure reducer: a labelled clear completes that step; a no-label
          // clear-all is decluttering and never completes the checklist.
          setProcedureSteps((p) => applyProcedureClear(p, lbl));
          addLog(lbl ? `Cleared: ${lbl}` : "Cleared all highlights");
          return;
        }
        if (msg && msg.type === "annotate" && Array.isArray(msg.box) && msg.box.length === 4) {
          const box = msg.box.map(Number) as [number, number, number, number];
          if (!box.every((n) => Number.isFinite(n))) return; // drop NaN/Inf boxes
          const label = String(msg.label ?? "component");
          const shape: AnnotationShape = SHAPES.includes(msg.shape) ? msg.shape : "box";
          const level: AnnotationLevel = LEVELS.includes(msg.level) ? msg.level : "info";
          const stepNum = Number(msg.step);
          const step = Number.isFinite(stepNum) && stepNum >= 1 ? Math.floor(stepNum) : undefined;
          const now = Date.now();
          const ann: Annotation = {
            // STABLE id (per label, not per timestamp): a refresh of the same
            // component updates the existing annotation in place instead of
            // creating a new one. This keeps the world-anchored 3D marker mounted
            // so it stays pinned to its first placement (a new id would remount it
            // and re-capture the marker from the moved head pose -> it would jump).
            id: `annot:${label}`,
            label,
            detail: String(msg.detail ?? ""),
            box,
            shape,
            level,
            step,
            createdAt: now,
            expiresAt: now + ANNOTATION_TTL_MS,
          };
          // Replace any existing highlight for the same label; cap the list.
          setAnnotations((a) =>
            [...a.filter((x) => x.label !== ann.label), ann].slice(-MAX_ANNOTATIONS)
          );
          // Record in the recall history (dedupe by label, latest first).
          setAnnotationHistory((h) =>
            [ann, ...h.filter((x) => x.label !== ann.label)].slice(0, MAX_ANNOTATION_HISTORY)
          );
          // Procedure tracking: numbered marks build the checklist. Heuristics:
          // step N arriving marks 1..N-1 done; a fresh step 1 after a finished
          // step 1 (with later steps present) starts a NEW procedure.
          if (step != null) {
            // Pure reducer (lib/procedure.ts) — heuristics unit-tested there.
            setProcedureSteps((p) =>
              applyProcedureAnnotation(p, {
                step,
                label,
                detail: String(msg.detail ?? ""),
                level,
              })
            );
          }
          addLog(`Annotated: ${ann.label}${ann.detail ? " (" + ann.detail + ")" : ""}`);
        }
      } catch {
        /* ignore malformed event */
      }
    };

    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    // The backend samples video at only ~1 fps / 768px for Gemini, so streaming
    // full-rate 1280p just burns the (small) server CPU decoding frames it drops
    // and wastes relay bandwidth. Cap the VIDEO sender to a low bitrate/fps/res —
    // the AI sees the same thing, the relay + server do far less work, and the
    // local camera preview (shown from the raw stream) stays sharp. Best-effort:
    // some browsers don't expose encodings until negotiation, so only tighten an
    // existing encoding and never throw on failure.
    try {
      const vSender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (vSender) {
        const params = vSender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          params.encodings[0].maxBitrate = 350_000; // ~350 kbps — ample for ~1 fps stills
          params.encodings[0].maxFramerate = 3; // backend only samples ~1 fps
          params.encodings[0].scaleResolutionDownBy = 1.5; // 1280 -> ~853 (> the 768 used)
          await vSender.setParameters(params);
          addLog("Video sender capped (~350 kbps / 3 fps) to ease the relay + server.");
        }
      }
    } catch (e) {
      addLog("Could not cap video sender (non-fatal): " + e);
    }

    try {
      const offer = await thisPc.createOffer();
      await thisPc.setLocalDescription(offer);
      await waitForIceGathering(thisPc);
      if (pcRef.current !== thisPc) return;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = authToken();
      if (token) headers["X-API-Key"] = token;
      const res = await fetch(apiUrl("/offer"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          sdp: thisPc.localDescription!.sdp,
          type: thisPc.localDescription!.type,
        }),
      });
      if (pcRef.current !== thisPc) return;

      if (!res.ok) {
        throw new Error("Backend /offer error " + res.status + ": " + (await res.text()));
      }
      const answer = await res.json();
      if (pcRef.current !== thisPc) return;
      await thisPc.setRemoteDescription(answer);
      // The new session has genuinely begun: NOW the old record makes way.
      // (The data channel can't deliver events before the answer is applied,
      // so nothing from this session lands in the old record's arrays.)
      setTranscript([]);
      setAnnotationHistory([]);
      setProcedureSteps([]);
      setModel(null);
      setGroundedBy([]);
      pendingSourcesRef.current = [];
      liveCaptionRef.current = "";
      setLiveCaption("");
      userCaptionRef.current = "";
      sessionStartRef.current = Date.now();
      sessionLiveRef.current = true; // a real session exists from this moment
      addLog("SDP answer applied — waiting for media to flow.");
    } catch (e) {
      addLog("Negotiation failed: " + e);
      if (pcRef.current === thisPc) {
        setLastError(
          "Couldn't reach the assistant server. Check that it's running and the " +
            "network is up, then retry."
        );
        setState("error");
        teardown();
      }
    }
  }, [addLog, teardown, remoteAudioId, localVideoId]);

  const sendText = useCallback(
    (text: string): boolean => {
      const t = text.trim().slice(0, 2000);
      const dc = dcRef.current;
      if (!t) return false;
      if (!dc || dc.readyState !== "open") {
        addLog("Can't send text — the session channel isn't open.");
        return false;
      }
      // Words spoken BEFORE this typed message must land first in the record.
      commitUserTurn();
      try {
        dc.send(JSON.stringify({ type: "user_text", text: t }));
      } catch (e) {
        addLog("Text send failed: " + e);
        return false;
      }
      // Show the typed question in the transcript so the exchange reads as a
      // conversation (the AI's spoken answer lands right under it).
      setTranscript((tr) =>
        [...tr, { id: ++turnIdRef.current, text: t, at: Date.now(), role: "user" as const }].slice(
          -MAX_TRANSCRIPT_TURNS
        )
      );
      return true;
    },
    [addLog, commitUserTurn]
  );

  const resumeAudio = useCallback(() => {
    // Must be called from a user gesture (button tap) — that satisfies the
    // autoplay policy and lets play() succeed. No-op without a live session
    // (play() on a null-src element never settles — the button would stick).
    if (!pcRef.current) {
      setAudioBlocked(false);
      return;
    }
    // Also the gesture moment to un-suspend the meters' AudioContext.
    if (audioCtxRef.current?.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {});
    }
    const a = document.getElementById(remoteAudioId) as HTMLAudioElement | null;
    if (!a) return;
    a.play()
      .then(() => {
        setAudioBlocked(false);
        addLog("AI audio enabled.");
      })
      .catch((e) => addLog("audio still blocked: " + e));
  }, [remoteAudioId, addLog]);

  const recallAnnotation = useCallback(
    (label: string) => {
      const item = annotationHistory.find((x) => x.label === label);
      if (!item) return;
      const now = Date.now();
      // recalled: the camera has moved since the AI drew this — the overlay
      // renders it dashed + badged so it can't be mistaken for a live warning.
      const revived: Annotation = {
        ...item,
        createdAt: now,
        expiresAt: now + ANNOTATION_TTL_MS,
        recalled: true,
      };
      setAnnotations((a) =>
        [...a.filter((x) => x.label !== label), revived].slice(-MAX_ANNOTATIONS)
      );
      addLog(`Recalled: ${label}`);
    },
    [annotationHistory, addLog]
  );

  const toggleMic = useCallback(() => {
    const s = streamRef.current;
    if (!s) return;
    // Side effects OUTSIDE the updater (purity — StrictMode double-invokes).
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    // Muting is an explicit end-of-utterance: commit pending speech now so a
    // pre-mute fragment tail can't merge with post-unmute speech later.
    if (next) commitUserTurn();
    // A user gesture is the one chance to un-suspend a policy-suspended ctx.
    if (audioCtxRef.current?.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {});
    }
    s.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    addLog(next ? "Mic muted — the AI can't hear you." : "Mic live.");
    setMicMuted(next);
  }, [addLog, commitUserTurn]);

  return {
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
    hasRecord: transcript.length > 0 || annotationHistory.length > 0 || model != null,
    snapshotRequest,
    procedureSteps,
    model,
    dismissModel,
    setModelStep,
    groundedBy,
  };
}

/** Translate a getUserMedia DOMException into operator language. */
function friendlyMediaError(e: unknown): string {
  const name = (e as DOMException)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera & microphone access was blocked. Allow them in the browser's site settings, then retry.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera or microphone was found on this device. Connect or enable one, then retry.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera or mic is in use by another app. Close that app, then retry.";
    case "OverconstrainedError":
      return "This camera doesn't support the requested mode. Retry to use the default mode.";
    case "SecurityError":
      return "The browser blocked media access on this page — it needs HTTPS (or localhost).";
    default:
      return "Couldn't access the camera or microphone. Check permissions, then retry.";
  }
}

/** Optional API token: from ?token= in the URL, else localStorage.
 *
 * The URL token is PERSISTED to localStorage when seen: an installed PWA
 * launches at start_url "/" with no query string, so without persistence the
 * home-screen launch would silently lose auth (one tokened browser visit
 * before installing is enough). Exported so every fetch shares one source. */
export function authToken(): string {
  try {
    const fromUrl = new URL(window.location.href).searchParams.get("token");
    if (fromUrl) {
      try {
        window.localStorage.setItem("apiToken", fromUrl);
      } catch {
        /* storage unavailable — URL token still used for this visit */
      }
      return fromUrl;
    }
    return window.localStorage.getItem("apiToken") || "";
  } catch {
    return "";
  }
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    let settle: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onState);
      pc.removeEventListener("icecandidate", onCand);
      if (settle) clearTimeout(settle);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const onCand = (e: RTCPeerConnectionIceEvent) => {
      // On a LAN (the iPad/headset on the same Wi-Fi), the HOST candidate is
      // available almost instantly and is all we need; a STUN srflx is
      // irrelevant on the same subnet and otherwise stalls until timeout. Once a
      // host candidate arrives, settle briefly to collect peers, then proceed —
      // so first Connect doesn't sit on "Connecting…" for the full ceiling.
      if (e.candidate && /\btyp host\b/.test(e.candidate.candidate) && !settle) {
        settle = setTimeout(done, 400);
      }
    };
    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCand);
    setTimeout(done, 2500); // hard safety ceiling (don't hang if nothing gathers)
  });
}
