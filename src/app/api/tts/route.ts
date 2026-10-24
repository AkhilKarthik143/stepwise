// Speaks a reply with Cartesia Sonic and returns MP3. 503 when no Cartesia key is set, so the
// browser falls back to its own voice.

import { cartesiaConfigured, CartesiaError, synthesize } from "@/lib/cartesia";

const MAX_TEXT = 600;

export async function POST(request: Request) {
  if (!cartesiaConfigured()) return Response.json({ error: "No Cartesia key set." }, { status: 503 });
  let text = "";
  try {
    text = String((await request.json())?.text ?? "").trim();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!text) return Response.json({ error: "Send `text`." }, { status: 400 });

  try {
    const audio = await synthesize(text.slice(0, MAX_TEXT));
    return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  } catch (e) {
    const err = e instanceof CartesiaError ? e : new CartesiaError("Couldn't reach Cartesia.");
    console.error(err.message);
    return Response.json({ error: err.message }, { status: err.status });
  }
}
