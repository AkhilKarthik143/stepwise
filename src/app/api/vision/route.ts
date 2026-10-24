// Answers a question about one camera frame. The key stays on the server.

import { askClaude, ClaudeError } from "@/lib/claude";

const MAX_IMAGE_CHARS = 4_000_000; // ~3 MB of base64; frames are resized well below this

const SYSTEM_PROMPT =
  "You are BuildSight, a hands-free build assistant looking down at a work surface " +
  "through an overhead camera. Answer in at most two short sentences, as if spoken aloud. " +
  "Name pieces by color and size (for example 'red 2x4 brick'). If you can't see clearly, say so.";

export async function POST(request: Request) {
  let body: { image?: string; question?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const { image, question } = body;
  if (!image || !image.startsWith("data:image/")) {
    return Response.json({ error: "Send `image` as a data URL (data:image/jpeg;base64,...)." }, { status: 400 });
  }
  if (image.length > MAX_IMAGE_CHARS) return Response.json({ error: "Image too large." }, { status: 413 });

  const started = Date.now();
  try {
    const text = await askClaude({
      system: SYSTEM_PROMPT,
      parts: [
        { type: "image", dataUrl: image },
        { type: "text", text: question?.trim() || "What do you see on the work surface?" },
      ],
    });
    return Response.json({ text, latencyMs: Date.now() - started });
  } catch (e) {
    const err = e instanceof ClaudeError ? e : new ClaudeError("Request failed.");
    return Response.json({ error: err.message }, { status: err.status });
  }
}
