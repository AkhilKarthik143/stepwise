import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AudioPlayer } from "../audio/player";
import { BrowserListener, speak, stopSpeaking } from "../audio/browserSpeech";
import { MicRecorder } from "../audio/recorder";
import {
  type AlertMsg,
  type ARAnnotationMsg,
  type BuildMetrics,
  type BuildStatus,
  type ARAnnotationRemoveMsg,
  type ConnState,
  type ConvState,
  type GuideStatus,
  type MetricsMsg,
  type SourceRef,
  type VoiceMode,
  type RuntimeConfig,
  type ServerMessage,
  wsUrl,
} from "../lib/api";

export interface Line { id: number; role: "user" | "assistant"; text: string }
export interface ToolTick { name: string; status: string; ts: number }
export type Rot = { x: number; y: number; z: number };  // absolute model rotation in degrees

interface State {
  conn: ConnState;
  conv: ConvState;
  agent: { agent: string; display: string };
  lines: Line[];
  partialUser: string;
  partialAssistant: string;
  panels: Record<string, any>;
  visible: Record<string, boolean>;
  alerts: AlertMsg[];
  events: any[];
  metrics: MetricsMsg;
  sessionRemaining: number;
  visionActive: boolean;
  recentTools: ToolTick[];
  error: string | null;
  modelCmd: { action: "set_abs" | "reset" | "none"; rotation?: Rot; seq: number };
  highlight: { component: string; svg_id: string; label: string; seq: number } | null;
  annotate: { label: string; region: string; seq: number } | null;
  assetLabel: string | null;
  provider: "claude" | "mock" | "guide" | "buildsight";
  sources: SourceRef[];
  annotations: ARAnnotationMsg[];
  guide: GuideStatus;
  voice: { voice_in: VoiceMode; voice_out: VoiceMode } | null;
  build: BuildStatus | null;
  buildMetrics: BuildMetrics | null;
}

const initial: State = {
  conn: "disconnected",
  conv: "idle",
  agent: { agent: "orchestrator", display: "Orchestrator" },
  lines: [],
  partialUser: "",
  partialAssistant: "",
  panels: {},
  visible: {},
  alerts: [],
  events: [],
  metrics: { type: "metrics", count: 0, last_tool: "", rejected: 0, latency_ms: 0 },
  sessionRemaining: 0,
  visionActive: false,
  recentTools: [],
  error: null,
  modelCmd: { action: "none", seq: 0 },
  highlight: null,
  annotate: null,
  assetLabel: null,
  provider: "mock",
  sources: [],
  annotations: [],
  guide: { phase: "idle", problem: "", identification: null, pending_machine: null },
  voice: null,
  build: null,
  buildMetrics: null,
};

type Action =
  | { k: "conn"; v: ConnState }
  | { k: "msg"; m: ServerMessage }
  | { k: "error"; v: string | null }
  | { k: "tick" }
  | { k: "dismissAlert"; i: number }
  | { k: "partial"; v: string }
  | { k: "reset" };

let lineId = 0;

function reducer(s: State, a: Action): State {
  switch (a.k) {
    case "conn":
      return { ...s, conn: a.v };
    case "error":
      return { ...s, error: a.v };
    case "tick":
      return { ...s, sessionRemaining: Math.max(0, s.sessionRemaining - 1) };
    case "dismissAlert":
      return { ...s, alerts: s.alerts.filter((_, idx) => idx !== a.i) };
    case "partial":
      return { ...s, partialUser: a.v };
    case "reset":
      return { ...initial, conn: s.conn };
    case "msg":
      return applyMsg(s, a.m);
  }
}

function applyMsg(s: State, m: ServerMessage): State {
  switch (m.type) {
    case "hello":
      return { ...s, agent: { agent: m.agent, display: m.display }, sessionRemaining: m.session_max_seconds };
    case "agent":
      return { ...s, agent: { agent: m.agent, display: m.display } };
    case "state":
      return { ...s, conv: m.status as ConvState, sessionRemaining: m.session_remaining ?? s.sessionRemaining };
    case "transcript": {
      if (m.role === "user") {
        if (m.final) return { ...s, lines: [...s.lines, { id: ++lineId, role: "user", text: m.text || s.partialUser }], partialUser: "" };
        // Cartesia turn.update carries the whole turn so far (text); Qwen streams deltas.
        return { ...s, partialUser: m.text ? m.text : s.partialUser + m.delta };
      }
      if (m.final) return { ...s, lines: [...s.lines, { id: ++lineId, role: "assistant", text: m.text || s.partialAssistant }], partialAssistant: "" };
      return { ...s, partialAssistant: s.partialAssistant + m.delta };
    }
    case "interrupted":
      return { ...s, partialAssistant: "", conv: "listening" };
    case "panel": {
      const prev = s.panels[m.panel] || {};
      // The "procedure" panel (procedures + safety) and "machine_data" panel (nameplate / specs /
      // telemetry / faults / part / torque / diagnosis) each send a FULL self-contained view —
      // REPLACE so stale fields never leak across views. Other panels keep the shallow merge:
      // event_log relies on it (report/handoff persist across log updates) and schematic uses
      // partial `navigate` updates.
      const full = m.panel === "procedure" || m.panel === "machine_data";
      const data = full ? m.data : { ...prev, ...m.data };
      return { ...s, panels: { ...s.panels, [m.panel]: data }, visible: { ...s.visible, [m.panel]: true } };
    }
    case "alert":
      return { ...s, alerts: [m, ...s.alerts].slice(0, 6) };
    case "log":
      return { ...s, events: [m.entry, ...s.events].slice(0, 60) };
    case "tool":
      return { ...s, recentTools: [{ name: m.name, status: m.status, ts: Date.now() }, ...s.recentTools].slice(0, 8) };
    case "metrics":
      return { ...s, metrics: m };
    case "control":
      return applyControl(s, m.action, m as Record<string, unknown>);
    case "ar.annotation.add":
      return { ...s, annotations: [...s.annotations.filter((a) => a.annotation_id !== m.annotation_id), m as ARAnnotationMsg] };
    case "ar.annotation.remove":
      return { ...s, annotations: s.annotations.filter((a) => a.annotation_id !== (m as ARAnnotationRemoveMsg).annotation_id) };
    case "error":
      return { ...s, error: m.message };
    default:
      return s;
  }
}

function applyControl(s: State, action: string, payload: Record<string, unknown>): State {
  switch (action) {
    case "provider_status":
      return {
        ...s,
        provider: payload.mock === true ? "mock" : payload.provider === "claude" || payload.provider === "guide" || payload.provider === "buildsight" ? payload.provider : s.provider,
        sources: Array.isArray(payload.sources) ? payload.sources as SourceRef[] : s.sources,
      };
    case "guide":
      return { ...s, guide: payload as unknown as GuideStatus };
    case "voice":
      return { ...s, voice: { voice_in: payload.voice_in as VoiceMode, voice_out: payload.voice_out as VoiceMode } };
    case "build": {
      const { type: _t, action: _a, ...rest } = payload;
      return { ...s, build: rest as unknown as BuildStatus };
    }
    case "metrics_update": {
      const { type: _t, action: _a, ...rest } = payload;
      return { ...s, buildMetrics: rest as unknown as BuildMetrics };
    }
    case "activate_vision":
      return { ...s, visionActive: true, visible: { ...s.visible, vision: true } };
    case "deactivate_vision":
      return { ...s, visionActive: false };
    case "show_panel": {
      const p = String(payload.panel || "");
      if (p === "all") return { ...s, visible: { schematic: true, machine_data: true, procedure: true, vision: s.visionActive, measurement: true, event_log: true } };
      return { ...s, visible: { ...s.visible, [p]: true } };
    }
    case "hide_panel": {
      const p = String(payload.panel || "");
      // "hide everything" must also clear the floating alert overlay (it's not a panel).
      if (p === "all") return { ...s, visible: {}, alerts: [] };
      if (p === "alert" || p === "alerts") return { ...s, alerts: [] };
      return { ...s, visible: { ...s.visible, [p]: false } };
    }
    case "set_panels": {
      // "show only X / hide everything except X": visibility becomes EXACTLY the named set.
      const names = (payload.panels as string[]) || [];
      const next: Record<string, boolean> = {};
      for (const p of names) next[p] = true;
      if (s.visionActive) next.vision = true;  // keep a voice/manually-activated camera up
      return { ...s, visible: next };
    }
    case "dismiss_alert":
      return { ...s, alerts: [] };
    // rotate_model / set_rotation carry the resulting ABSOLUTE rotation {x,y,z} — the mesh is SET
    // to it (single source of truth), so a deduped/missed control can't drift the render.
    case "rotate_model":
    case "set_rotation":
      return {
        ...s,
        visible: { ...s.visible, model: true },
        modelCmd: { action: "set_abs", rotation: (payload.rotation as Rot) || { x: 0, y: 0, z: 0 }, seq: s.modelCmd.seq + 1 },
      };
    case "reset_view":
      return {
        ...s,
        visible: { ...s.visible, model: true },
        modelCmd: { action: "reset", rotation: (payload.rotation as Rot) || { x: 0, y: 0, z: 0 }, seq: s.modelCmd.seq + 1 },
      };
    case "highlight":
      return {
        ...s,
        // reveal=false (passing mention) pulses only if the map is already open.
        visible: payload.reveal === false ? s.visible : { ...s.visible, overview: true },
        highlight: { component: String(payload.component || ""), svg_id: String(payload.svg_id || ""), label: String(payload.label || ""), seq: (s.highlight?.seq ?? 0) + 1 },
      };
    case "clear_highlight":
      return { ...s, highlight: null };
    case "annotate_field":
      return { ...s, annotate: { label: String(payload.label || ""), region: String(payload.region || "center"), seq: (s.annotate?.seq ?? 0) + 1 } };
    case "asset":
      return { ...s, assetLabel: String(payload.label || "") };
    default:
      return s;
  }
}

// Snapshot the on-screen UI for a reconnect resync (read flat from panels — the reducer stores
// m.data directly under panels[panel]). Best-effort: only fields the server can re-resolve by id.
function buildResync(s: State) {
  const visible = Object.keys(s.visible).filter((k) => s.visible[k]);
  const proc = s.panels.procedure || {};
  const procedure = proc.mode === "procedure" && proc.id
    ? { id: proc.id, index: proc.index ?? 0, completed_count: Array.isArray(proc.completed) ? proc.completed.length : 0, complete: !!proc.complete }
    : null;
  const safety = proc.mode === "safety" && proc.id
    ? { check_type: proc.id, index: proc.index ?? 0, complete: !!proc.complete }
    : null;
  const sch = s.panels.schematic || {};
  const schematic = sch.diagram_type ? { diagram: sch.diagram_type, focus: sch.navigate?.target ?? null } : null;
  // Machine-data is a server-authoritative nested section state; the server rebuilds a FRESH
  // per-connection state on reconnect, so re-assert the sections we still hold in React state
  // (fixes the post-reconnect "SPECS-only" artifact).
  const mdSecs = s.panels.machine_data?.sections;
  const machine_data = Array.isArray(mdSecs) && mdSecs.length ? { sections: mdSecs } : null;
  return {
    type: "control" as const,
    action: "resync",
    state: { visible, model_rotation: s.modelCmd.rotation ?? { x: 0, y: 0, z: 0 }, procedure, safety, schematic, highlight: s.highlight?.component ?? null, machine_data },
  };
}

export type FrameProvider = () => string | null; // returns base64 JPEG, no data: prefix

export function useRealtimeSocket(config: RuntimeConfig | null) {
  const [state, dispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;  // always-fresh snapshot for the reconnect onopen closure
  // Manual vision override: lets you preview/stream a camera or a loaded video file
  // for testing without first issuing the "what do you see?" voice command.
  const [manualVision, setManualVision] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const player = useRef<AudioPlayer | null>(null);
  const recorder = useRef<MicRecorder | null>(null);
  const userClosed = useRef(false);
  const wasConnected = useRef(false);  // set after the first open — later opens are reconnects
  const frameProvider = useRef<FrameProvider | null>(null);
  const screenProvider = useRef<FrameProvider | null>(null);
  const micOn = useRef(false);
  const listener = useRef<BrowserListener | null>(null);
  const voiceIn = state.voice?.voice_in ?? config?.providers.voice_in ?? "browser";
  const voiceOut = state.voice?.voice_out ?? config?.providers.voice_out ?? "browser";

  const send = useCallback((obj: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(obj));
  }, []);

  const sendText = useCallback((text: string) => {
    const value = text.trim();
    if (value && ws.current?.readyState === WebSocket.OPEN) send({ type: "control", action: "text", text: value });
  }, [send]);

  const confirmAnchor = useCallback((componentId: string, coordinates: [number, number, number, number]) => {
    send({ type: "control", action: "confirm_anchor", component_id: componentId, coordinates, source: "user_confirmed" });
  }, [send]);

  const connect = useCallback(() => {
    if (!config || ws.current) return;
    userClosed.current = false;
    dispatch({ k: "conn", v: "connecting" });
    if (!player.current) player.current = new AudioPlayer(config.output_sample_rate);

    const socket = new WebSocket(wsUrl());
    socket.binaryType = "arraybuffer";
    ws.current = socket;

    socket.onopen = () => {
      dispatch({ k: "conn", v: "connected" });
      // On a RE-open after a drop, re-assert the on-screen UI so the server's SCREEN STATE matches
      // what's actually displayed (panels, rotation, the active checklist, schematic, highlight).
      if (wasConnected.current) send(buildResync(stateRef.current));
      wasConnected.current = true;
    };
    socket.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        player.current?.enqueue(e.data);
        return;
      }
      try {
        const m = JSON.parse(e.data as string) as ServerMessage;
        if (m.type === "interrupted") player.current?.drain();
        dispatch({ k: "msg", m });
      } catch {
        /* ignore malformed */
      }
    };
    socket.onclose = () => {
      ws.current = null;
      dispatch({ k: "conn", v: "disconnected" });
      if (!userClosed.current) setTimeout(() => connect(), 1500); // auto-reconnect
    };
    socket.onerror = () => socket.close();
  }, [config]);

  const disconnect = useCallback(() => {
    userClosed.current = true;
    recorder.current?.stop();
    recorder.current = null;
    micOn.current = false;
    setMicActive(false);
    ws.current?.close();
    ws.current = null;
    player.current?.close();
    player.current = null;
    dispatch({ k: "conn", v: "disconnected" });
  }, []);

  const toggleMic = useCallback(async () => {
    if (!config) return;
    if (micOn.current) {
      listener.current?.stop();
      listener.current = null;
      recorder.current?.stop();
      recorder.current = null;
      micOn.current = false;
      setMicActive(false);
      dispatch({ k: "msg", m: { type: "state", status: "idle" } });
      return;
    }
    if (voiceIn === "browser") {
      // No server STT: the browser transcribes and each final phrase is a normal text turn.
      try {
        const l = new BrowserListener(
          (text) => send({ type: "control", action: "text", text }),
          (partial) => dispatch({ k: "partial", v: partial }),
        );
        l.start();
        listener.current = l;
        micOn.current = true;
        setMicActive(true);
        dispatch({ k: "error", v: null });
        dispatch({ k: "msg", m: { type: "state", status: "listening" } });
      } catch (e) {
        dispatch({ k: "error", v: (e as Error).message });
      }
      return;
    }
    try {
      await player.current?.resume(); // unlock playback on the user gesture
      const rec = new MicRecorder();
      let frames = 0;
      await rec.start(config.input_sample_rate, (pcm) => {
        // Stream the mic continuously so the user can BARGE IN over STEPWISE. Echo is handled by
        // the browser's acoustic echo cancellation (getUserMedia echoCancellation:true) plus
        // backend guards (empty-turn drop + STEPWISE-word echo match) — NOT by muting the user.
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(pcm);
          if (frames++ === 0) console.info("[STEPWISE] mic capturing →", rec.mode);
        }
      });
      recorder.current = rec;
      micOn.current = true;
      setMicActive(true);
      dispatch({ k: "error", v: null });
      dispatch({ k: "msg", m: { type: "state", status: "listening" } });
      console.info("[STEPWISE] mic started (mode=%s)", rec.mode);
    } catch (e) {
      console.error("[STEPWISE] mic start failed:", e);
      recorder.current?.stop();
      recorder.current = null;
      micOn.current = false;
      setMicActive(false);
      dispatch({ k: "error", v: `Microphone: ${(e as Error).message}` });
    }
  }, [config, voiceIn, send]);

  // Browser voice out: read each final assistant reply aloud (server voice streams PCM instead).
  const lastSpoken = useRef(0);
  useEffect(() => {
    if (voiceOut !== "browser") return;
    const last = state.lines[state.lines.length - 1];
    if (!last || last.role !== "assistant" || last.id === lastSpoken.current) return;
    lastSpoken.current = last.id;
    speak(last.text, listener.current);
  }, [state.lines, voiceOut]);

  // BuildSight: ask the server to compare this frame with the manual's picture.
  const requestCheck = useCallback((jpegB64: string, trigger: "stillness" | "button") => {
    send({ type: "control", action: "check", jpeg_b64: jpegB64, trigger });
  }, [send]);

  const clearError = useCallback(() => dispatch({ k: "error", v: null }), []);
  const dismissAlert = useCallback((i: number) => dispatch({ k: "dismissAlert", i }), []);

  const registerFrameProvider = useCallback((fn: FrameProvider | null) => {
    frameProvider.current = fn;
  }, []);

  const registerScreenProvider = useCallback((fn: FrameProvider | null) => {
    screenProvider.current = fn;
  }, []);

  const bargeIn = useCallback(() => {
    const wasSpeaking = player.current?.speaking ?? false;
    player.current?.drain();
    stopSpeaking();
    // Only cancel a response that's actually playing (avoids a "no active response" warning).
    if (wasSpeaking) send({ type: "control", action: "barge_in" });
  }, [send]);

  // 1 fps vision frame sender, gated on the agent's vision state OR the manual override.
  const visionStreaming = state.visionActive || manualVision;
  useEffect(() => {
    if (!visionStreaming || !config) return;
    const period = Math.max(250, Math.round(1000 / config.vision.fps));
    const id = window.setInterval(() => {
      const frame = frameProvider.current?.();
      if (frame) send({ type: "image", jpeg_b64: frame });
      // Optional SCADA screen frame (only sent while sharing is on).
      const screen = screenProvider.current?.();
      if (screen) send({ type: "image", jpeg_b64: screen });
    }, period);
    return () => window.clearInterval(id);
  }, [visionStreaming, config, send]);

  // Tell the server when vision is on/off so it forwards frames + adds vision context.
  // (The server drops image frames unless it knows vision is active.)
  useEffect(() => {
    if (state.conn !== "connected") return;
    send({ type: "control", action: visionStreaming ? "vision_on" : "vision_off" });
  }, [visionStreaming, state.conn, send]);

  // session countdown
  useEffect(() => {
    if (state.conn !== "connected") return;
    const id = window.setInterval(() => dispatch({ k: "tick" }), 1000);
    return () => window.clearInterval(id);
  }, [state.conn]);

  // Checklist completion: show the ✅ ~5s, then auto-hide the panel and raise a green toast.
  const completeShown = useRef(false);
  useEffect(() => {
    const proc = state.panels.procedure;
    const done = !!proc?.complete;
    if (!done) { completeShown.current = false; return; }
    if (completeShown.current) return;
    completeShown.current = true;
    const title = proc?.title || "Checklist";
    const t = window.setTimeout(() => {
      dispatch({ k: "msg", m: { type: "control", action: "hide_panel", panel: "procedure" } as unknown as ServerMessage });
      dispatch({ k: "msg", m: { type: "alert", level: "success", message: `${title} complete — all items done.` } as unknown as ServerMessage });
    }, 5000);
    return () => window.clearTimeout(t);
  }, [state.panels.procedure]);

  // Success toasts auto-dismiss after a few seconds (warn/alert persist until dismissed).
  useEffect(() => {
    const i = state.alerts.findIndex((a) => a.level === "success");
    if (i < 0) return;
    const t = window.setTimeout(() => dispatch({ k: "dismissAlert", i }), 4000);
    return () => window.clearTimeout(t);
  }, [state.alerts]);

  useEffect(() => () => disconnect(), [disconnect]);

  return useMemo(
    () => ({ state, connect, disconnect, toggleMic, registerFrameProvider, registerScreenProvider, bargeIn, micActive, manualVision, setManualVision, visionStreaming, clearError, dismissAlert, sendText, confirmAnchor, requestCheck }),
    [state, connect, disconnect, toggleMic, registerFrameProvider, registerScreenProvider, bargeIn, micActive, manualVision, visionStreaming, clearError, dismissAlert, sendText, confirmAnchor, requestCheck],
  );
}
