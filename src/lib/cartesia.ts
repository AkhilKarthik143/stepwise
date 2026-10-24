// Cartesia voice, server side. Sonic speaks the replies; Ink listens for commands. The API key
// stays here: the browser gets either audio bytes (/api/tts) or a short-lived token that only
// allows speech-to-text (/api/voice-token). Server-only.

const API = "https://api.cartesia.ai";
// API version the official @cartesia/cartesia-js 4.2 client sends.
export const CARTESIA_VERSION = "2026-08-14";

export const cartesia = {
  key: () => process.env.CARTESIA_API_KEY?.trim() || "",
  voice: () => process.env.CARTESIA_VOICE_ID?.trim() || "ef191366-f52f-447a-a398-ed8c0f2943a1",
  ttsModel: () => process.env.CARTESIA_TTS_MODEL?.trim() || "sonic-latest",
  sttModel: () => process.env.CARTESIA_STT_MODEL?.trim() || "ink-2",
};

export function cartesiaConfigured() {
  return Boolean(cartesia.key());
}

function headers() {
  return { Authorization: `Bearer ${cartesia.key()}`, "Cartesia-Version": CARTESIA_VERSION, "Content-Type": "application/json" };
}

export class CartesiaError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

/** Speaks `text` with Sonic and returns MP3 bytes (plays everywhere, including iPhone Safari). */
export async function synthesize(text: string): Promise<ArrayBuffer> {
  const res = await fetch(`${API}/tts/bytes`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model_id: cartesia.ttsModel(),
      transcript: text,
      voice: { mode: "id", id: cartesia.voice() },
      language: "en",
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    }),
  });
  if (!res.ok) throw new CartesiaError(`Cartesia TTS error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.arrayBuffer();
}

/** A token the browser uses to open the Ink STT websocket itself. STT only, 10 minutes. */
export async function sttToken(): Promise<string> {
  const res = await fetch(`${API}/access-token`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ grants: { stt: true }, expires_in: 600 }),
  });
  if (!res.ok) throw new CartesiaError(`Cartesia token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { token: string }).token;
}
