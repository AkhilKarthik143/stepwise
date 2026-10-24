"use client";

// Voice in. Streams the mic to Cartesia Ink (realtime speech-to-text with turn detection) using a
// short-lived token from /api/voice-token, so Cartesia decides when the builder has finished a
// sentence. Without a Cartesia key it falls back to the browser's speech recognition (Chrome,
// Safari). Whatever is heard while the app is speaking is dropped (see isSpeaking).

import { isSpeaking } from "@/lib/speech";

export type VoiceIn = "cartesia" | "browser";

export type Listener = { mode: VoiceIn; stop: () => void };

type Handlers = {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
};

const RATE = 16000;

// Float32 mic samples at the context's rate → 16 kHz PCM16, which Ink expects.
function toPcm16(input: Float32Array, fromRate: number): ArrayBuffer {
  const ratio = fromRate / RATE;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const s = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

async function cartesiaListener(h: Handlers): Promise<Listener | null> {
  const res = await fetch("/api/voice-token", { method: "POST" });
  if (res.status === 503) return null; // no key: use the browser instead
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Couldn't start Cartesia.");

  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is old but works in every phone browser without a separate worklet file.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;

  let stopped = false;
  let ws: WebSocket | null = null;
  let token: string = data.token;

  const open = () => {
    const url = new URL("wss://api.cartesia.ai/stt/turns/websocket");
    url.searchParams.set("model", data.model);
    url.searchParams.set("encoding", "pcm_s16le");
    url.searchParams.set("sample_rate", String(RATE));
    url.searchParams.set("cartesia_version", data.version);
    url.searchParams.set("access_token", token);
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data) as { type?: string; transcript?: string; message?: string };
      if (isSpeaking()) return;
      if (msg.type === "turn.update" && msg.transcript) h.onPartial(msg.transcript);
      else if (msg.type === "turn.end" && msg.transcript?.trim()) h.onFinal(msg.transcript.trim());
      else if (msg.type === "error") h.onError(msg.message ?? "Cartesia speech error.");
    };
    ws.onclose = async () => {
      if (stopped) return;
      // Connections time out after a while; reopen with a fresh token.
      try {
        const again = await fetch("/api/voice-token", { method: "POST" });
        if (again.ok) token = (await again.json()).token;
      } catch {}
      if (!stopped) setTimeout(open, 500);
    };
  };
  open();

  processor.onaudioprocess = (e) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    // While the app talks, send silence so the turn detector doesn't hear the speaker.
    const samples = isSpeaking() ? new Float32Array(e.inputBuffer.length) : e.inputBuffer.getChannelData(0);
    ws.send(toPcm16(samples, ctx.sampleRate));
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  return {
    mode: "cartesia",
    stop: () => {
      stopped = true;
      try {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "close" }));
        ws?.close();
      } catch {}
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function browserListener(h: Handlers): Listener | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  let stopped = false;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  rec.onresult = (e) => {
    if (isSpeaking()) return;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) h.onFinal(r[0].transcript.trim());
      else h.onPartial(r[0].transcript);
    }
  };
  rec.onerror = (e) => {
    if (e.error !== "no-speech" && e.error !== "aborted") h.onError(`Speech recognition: ${e.error}`);
  };
  rec.onend = () => !stopped && rec.start(); // browsers stop after a pause; keep listening
  rec.start();
  return {
    mode: "browser",
    stop: () => {
      stopped = true;
      rec.stop();
    },
  };
}

/** Starts listening. Call from a tap (the mic needs a user gesture on phones). */
export async function startListening(h: Handlers): Promise<Listener> {
  const live = await cartesiaListener(h);
  if (live) return live;
  const fallback = browserListener(h);
  if (fallback) return fallback;
  throw new Error("This browser can't do speech recognition. Use the buttons, or set the Cartesia key on the server.");
}
