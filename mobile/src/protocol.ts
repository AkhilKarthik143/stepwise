// Mirrors stepwise/backend/app/ws/protocol.py (the subset the mobile app uses).

export type ConnState = "disconnected" | "connecting" | "connected";
export type ConvState = "idle" | "listening" | "thinking" | "speaking";
export type VoiceMode = "cartesia" | "qwen" | "browser";
export type GuidePhase = "idle" | "awaiting_machine" | "guiding" | "report";

export interface Identification {
  asset_id: string | null;
  machine_model: string;
  part: string;
  confidence: number;
  provider: "claude" | "local";
  mock: boolean;
}

export interface GuideStatus {
  phase: GuidePhase;
  problem: string;
  identification: Identification | null;
  pending_machine: string | null;
}

export interface SourceRef {
  kind: string;
  label: string;
  url?: string;
}

export interface Step {
  n: number;
  text: string;
  confirm?: boolean;
  confirm_prompt?: string;
  figure_url?: string;
  expect?: string;
}

// The "procedure" panel payload: a guided procedure or a safety checklist.
export interface ProcedureView {
  mode?: "procedure" | "safety";
  id?: string;
  title?: string;
  steps?: Step[];
  items?: { n: number; text: string; prompt?: string }[];
  index?: number;
  current?: number;
  complete?: boolean;
  awaiting_confirmation?: boolean;
  tools?: string[];
  source?: { title: string; url: string } | null;
}

export interface RuntimeConfig {
  asset_id: string;
  input_sample_rate: number;
  providers: {
    agent: "claude" | "mock";
    moss_configured: boolean;
    vision: "claude" | "local";
    voice_in: VoiceMode;
    voice_out: VoiceMode;
  };
}

export type ServerMessage = { type: string; [k: string]: any };

export function httpBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function wsUrl(base: string): string {
  return `${httpBase(base).replace(/^http/, "ws")}/ws?client=mobile`;
}
