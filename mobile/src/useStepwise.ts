import { useCallback, useEffect, useReducer, useRef } from "react";
import { type ConnState, type ConvState, type GuideStatus, type ProcedureView, type RuntimeConfig, type ServerMessage, type SourceRef, type VoiceMode, httpBase, wsUrl } from "./protocol";

export interface Line { id: number; role: "user" | "assistant"; text: string }

export interface StepwiseState {
  conn: ConnState;
  conv: ConvState;
  config: RuntimeConfig | null;
  lines: Line[];
  heard: string;
  procedure: ProcedureView | null;
  report: string | null;
  guide: GuideStatus;
  voice: { voice_in: VoiceMode; voice_out: VoiceMode } | null;
  provider: string;
  sources: SourceRef[];
  asset: string;
  error: string | null;
}

const initial: StepwiseState = {
  conn: "disconnected",
  conv: "idle",
  config: null,
  lines: [],
  heard: "",
  procedure: null,
  report: null,
  guide: { phase: "idle", problem: "", identification: null, pending_machine: null },
  voice: null,
  provider: "mock",
  sources: [],
  asset: "",
  error: null,
};

type Action =
  | { k: "conn"; v: ConnState }
  | { k: "config"; v: RuntimeConfig }
  | { k: "error"; v: string | null }
  | { k: "msg"; m: ServerMessage };

let lineId = 0;

function reducer(s: StepwiseState, a: Action): StepwiseState {
  switch (a.k) {
    case "conn":
      return { ...s, conn: a.v };
    case "config":
      return { ...s, config: a.v, asset: s.asset || a.v.asset_id };
    case "error":
      return { ...s, error: a.v };
    case "msg":
      return apply(s, a.m);
  }
}

function apply(s: StepwiseState, m: ServerMessage): StepwiseState {
  switch (m.type) {
    case "hello":
      return { ...s, asset: m.asset_id || s.asset };
    case "state":
      return { ...s, conv: m.status };
    case "transcript":
      if (m.role === "user") {
        if (m.final) return { ...s, lines: [...s.lines, { id: ++lineId, role: "user" as const, text: String(m.text) }], heard: "" };
        return { ...s, heard: m.text || s.heard + (m.delta || "") };
      }
      if (m.final) return { ...s, lines: [...s.lines, { id: ++lineId, role: "assistant" as const, text: String(m.text) }].slice(-40) };
      return s;
    case "panel":
      if (m.panel === "procedure") return { ...s, procedure: m.data };
      if (m.panel === "event_log" && m.data?.report) return { ...s, report: m.data.report };
      return s;
    case "error":
      return { ...s, error: m.message };
    case "control":
      switch (m.action) {
        case "guide":
          return { ...s, guide: m as unknown as GuideStatus };
        case "voice":
          return { ...s, voice: { voice_in: m.voice_in, voice_out: m.voice_out } };
        case "provider_status":
          return { ...s, provider: m.mock ? "mock" : m.provider, sources: Array.isArray(m.sources) ? m.sources : s.sources };
        case "asset":
          return { ...s, asset: m.label };
        default:
          return s;
      }
    default:
      return s;
  }
}

// One WebSocket to the STEPWISE backend: text turns, camera frames and mic PCM go up;
// transcripts, guide status and procedure panels come down.
export function useStepwise(serverUrl: string) {
  const [state, dispatch] = useReducer(reducer, initial);
  const ws = useRef<WebSocket | null>(null);
  const closedByUser = useRef(false);

  const connect = useCallback(async () => {
    if (!serverUrl || ws.current) return;
    closedByUser.current = false;
    dispatch({ k: "conn", v: "connecting" });
    try {
      const res = await fetch(`${httpBase(serverUrl)}/api/config`);
      dispatch({ k: "config", v: (await res.json()) as RuntimeConfig });
    } catch (e) {
      dispatch({ k: "error", v: `Can't reach ${serverUrl}: ${(e as Error).message}` });
      dispatch({ k: "conn", v: "disconnected" });
      return;
    }
    const socket = new WebSocket(wsUrl(serverUrl));
    socket.binaryType = "arraybuffer";
    ws.current = socket;
    socket.onopen = () => {
      dispatch({ k: "conn", v: "connected" });
      dispatch({ k: "error", v: null });
    };
    socket.onmessage = (e) => {
      if (typeof e.data !== "string") return; // audio comes from /api/tts on mobile
      try {
        dispatch({ k: "msg", m: JSON.parse(e.data) });
      } catch {
        /* ignore malformed */
      }
    };
    socket.onclose = () => {
      ws.current = null;
      dispatch({ k: "conn", v: "disconnected" });
      if (!closedByUser.current) setTimeout(() => void connect(), 2000);
    };
    socket.onerror = () => socket.close();
  }, [serverUrl]);

  const disconnect = useCallback(() => {
    closedByUser.current = true;
    ws.current?.close();
    ws.current = null;
  }, []);

  useEffect(() => {
    void connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const sendJson = useCallback((obj: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(obj));
  }, []);

  const sendText = useCallback((text: string) => {
    const value = text.trim();
    if (value) sendJson({ type: "control", action: "text", text: value });
  }, [sendJson]);

  const sendFrame = useCallback((jpegB64: string) => sendJson({ type: "image", jpeg_b64: jpegB64 }), [sendJson]);

  const sendPcm = useCallback((pcm: ArrayBuffer) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(pcm);
  }, []);

  const clearError = useCallback(() => dispatch({ k: "error", v: null }), []);

  return { state, sendText, sendFrame, sendPcm, clearError, reconnect: connect };
}
