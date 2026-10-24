// Protocol types + helpers shared between the realtime hook and the panels.
// These mirror backend/app/ws/protocol.py.

export type ConnState = "disconnected" | "connecting" | "connected";
export type ConvState = "idle" | "listening" | "thinking" | "speaking";
export type VoiceMode = "cartesia" | "qwen" | "browser";
export type GuidePhase = "idle" | "awaiting_machine" | "guiding" | "report";
export interface Identification { asset_id: string | null; machine_model: string; part: string; confidence: number; provider: "claude" | "local"; mock: boolean }
export interface GuideStatus { phase: GuidePhase; problem: string; identification: Identification | null; pending_machine: string | null }
export interface SourceRef { kind: string; label: string; url?: string }

export interface RuntimeConfig {
  asset_id: string;
  input_sample_rate: number;
  output_sample_rate: number;
  vision: { width: number; height: number; fps: number; screen: { width: number; height: number } };
  session_max_seconds: number;
  providers: {
    agent: "claude" | "mock";
    claude_configured: boolean;
    cartesia_configured: boolean;
    moss_configured: boolean;
    vision: "claude" | "local";
    voice_in: VoiceMode;
    voice_out: VoiceMode;
  };
}

// ── server -> client messages ────────────────────────────────────────────────
export interface HelloMsg { type: "hello"; agent: string; display: string; asset_id: string; session_max_seconds: number }
export interface AgentMsg { type: "agent"; agent: string; display: string; reason: string }
export interface TranscriptMsg { type: "transcript"; role: "user" | "assistant"; delta: string; text: string; final: boolean }
export interface PanelMsg { type: "panel"; panel: string; data: any }
export interface AlertMsg { type: "alert"; level: "warn" | "alert" | "success"; message: string; channel?: string; value?: number; unit?: string }
export interface LogMsg { type: "log"; entry: any }
export interface ControlMsg { type: "control"; action: string; [k: string]: any }
export interface ToolMsg { type: "tool"; name: string; status: "called" | "rejected"; args: Record<string, unknown> }
export interface MetricsMsg { type: "metrics"; count: number; last_tool: string; rejected: number; latency_ms: number }
export interface StateMsg { type: "state"; status: ConvState; session_remaining?: number }
export interface InterruptedMsg { type: "interrupted" }
export interface ErrorMsg { type: "error"; message: string }
export interface ARAnnotationMsg {
  type: "ar.annotation.add";
  annotation_id: string;
  component_id?: string | null;
  label: string;
  shape: "box" | "pin" | "arrow";
  severity: "info" | "warn" | "danger";
  anchor: { type: "image_bbox" | "pending" | "region_hint"; coordinates: number[] | string | null; coordinate_system: string; source: string };
  tracking_status: "pending" | "confirmed" | "lost" | "stale";
  persistent?: boolean;
}
export interface ARAnnotationRemoveMsg { type: "ar.annotation.remove"; annotation_id: string }

export type ServerMessage =
  | HelloMsg | AgentMsg | TranscriptMsg | PanelMsg | AlertMsg | LogMsg
  | ControlMsg | ToolMsg | MetricsMsg | StateMsg | InterruptedMsg | ErrorMsg | ARAnnotationMsg | ARAnnotationRemoveMsg;

// ── helpers ──────────────────────────────────────────────────────────────────
export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export async function fetchConfig(): Promise<RuntimeConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`config ${res.status}`);
  return (await res.json()) as RuntimeConfig;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export const PANELS = ["schematic", "machine_data", "procedure", "vision", "measurement", "event_log"] as const;
export type PanelName = (typeof PANELS)[number];

export const PANEL_TITLES: Record<string, string> = {
  schematic: "Schematic",
  machine_data: "Machine Data",
  model: "3D Model",
  overview: "Machine Map",
  procedure: "Procedure / Checklist",
  vision: "Field Vision",
  measurement: "Measurements",
  event_log: "Work Order Log",
};
