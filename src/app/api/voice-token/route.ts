// Hands the browser what it needs to open Cartesia's Ink speech-to-text websocket directly:
// a short-lived STT-only token (never the API key), the model and the API version.

import { cartesia, CARTESIA_VERSION, cartesiaConfigured, CartesiaError, sttToken } from "@/lib/cartesia";

export async function POST() {
  if (!cartesiaConfigured()) return Response.json({ error: "No Cartesia key set." }, { status: 503 });
  try {
    return Response.json({ token: await sttToken(), model: cartesia.sttModel(), version: CARTESIA_VERSION }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const err = e instanceof CartesiaError ? e : new CartesiaError("Couldn't reach Cartesia.");
    console.error(err.message);
    return Response.json({ error: err.message }, { status: err.status });
  }
}
