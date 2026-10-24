// One place that talks to Claude. Uses the Anthropic API directly when ANTHROPIC_API_KEY is set,
// otherwise falls back to OpenRouter (OPENROUTER_API_KEY). Server-only.

import Anthropic from "@anthropic-ai/sdk";

export type Part = { type: "text"; text: string } | { type: "image"; dataUrl: string };

type Ask = {
  system: string;
  parts: Part[];
  effort?: "low" | "medium" | "high";
  // "off" skips thinking for transcription-style calls (reading a page, short answers), which
  // cuts latency. Checks keep it on. Anthropic API only; OpenRouter ignores it.
  thinking?: "on" | "off";
};

export class ClaudeError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-5.5";
// Thinking happens inside this budget too, so leave plenty of room.
const MAX_TOKENS = 16000;

type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const IMAGE_TYPES = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function splitDataUrl(dataUrl: string): { mediaType: ImageType; data: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m || !IMAGE_TYPES.has(m[1])) throw new ClaudeError("Images must be JPEG, PNG, GIF or WebP data URLs.", 400);
  return { mediaType: m[1] as ImageType, data: m[2] };
}

export function claudeConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim());
}

let client: Anthropic | null = null;

async function viaAnthropic({ system, parts, effort = "low", thinking = "on" }: Ask): Promise<string> {
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!.trim() });
  const content: Anthropic.Beta.BetaContentBlockParam[] = parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    const { mediaType, data } = splitDataUrl(p.dataUrl);
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  });

  try {
    const response = await client.beta.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort },
      // Sonnet 5.5 can't disable thinking outright; between_tools turns it off for a plain reply.
      ...(thinking === "off" ? { thinking: { type: "between_tools" as const } } : {}),
      // If a safety filter wrongly declines, the API re-runs the request on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal") throw new ClaudeError("Claude declined this request.", 422);
    return response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  } catch (e) {
    if (e instanceof ClaudeError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new ClaudeError("Anthropic rejected the API key.", 500);
    if (e instanceof Anthropic.RateLimitError) throw new ClaudeError("Rate limited by Anthropic. Try again in a moment.", 429);
    if (e instanceof Anthropic.APIError) throw new ClaudeError(`Anthropic error ${e.status}: ${e.message}`);
    throw new ClaudeError("Couldn't reach Anthropic.");
  }
}

async function viaOpenRouter({ system, parts }: Ask): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY!.trim()}`,
      "Content-Type": "application/json",
      "X-Title": "BuildSight",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: p.dataUrl } })),
        },
      ],
    }),
  });
  if (!res.ok) throw new ClaudeError(`OpenRouter error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

/** Sends one request to Claude and returns its text reply. */
export async function askClaude(ask: Ask): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return viaAnthropic(ask);
  if (process.env.OPENROUTER_API_KEY?.trim()) return viaOpenRouter(ask);
  throw new ClaudeError("No Claude key set. Add ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) to .env.local and to Vercel.", 500);
}
