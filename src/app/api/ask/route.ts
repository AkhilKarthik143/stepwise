// Answers a spoken question about the current step, from the manual's own picture and step
// text (plus the camera, when there is a frame). Short answers, as a person beside you would give.

import { askClaude, ClaudeError, type Part } from "@/lib/claude";

const MAX_IMAGE_CHARS = 4_000_000;

type AskRequest = {
  question?: string;
  frame?: string; // camera frame, data URL (optional)
  expected?: string; // manual picture of this step, data URL (optional)
  step?: { number: number; instruction: string; parts: { name: string; qty: number }[]; watchFor: string[] };
  history?: { q: string; a: string }[]; // last few exchanges, for follow-ups like "what color again?"
  known?: { number: number; instruction: string; parts: string }[]; // every step read so far in this manual
};

const SYSTEM_PROMPT = `You are BuildSight, a hands-free build assistant. The builder is following a picture manual and asks you something out loud.
Answer exactly what was asked, as briefly as a person standing next to them would: often a few words ("It's gray.", "The left side.", "Two of them."), never more than two sentences.
Use the manual's picture for this step to read colors, sides and orientation. Name parts by color and size.
Answer only from the manual picture, the steps listed and the camera. You only know the pages read so far; if a step isn't listed, say you haven't read that far yet and that they can say "go to step" and the number.
Never invent sizes, part numbers, torques or steps. Plain text only, no markdown: it is spoken aloud.`;

function isImage(s: unknown): s is string {
  return typeof s === "string" && s.startsWith("data:image/") && s.length <= MAX_IMAGE_CHARS;
}

export async function POST(request: Request) {
  let body: AskRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const question = body.question?.trim();
  if (!question) return Response.json({ error: "Send `question`." }, { status: 400 });

  const parts: Part[] = [];
  if (isImage(body.expected)) parts.push({ type: "text", text: "Manual picture for this step:" }, { type: "image", dataUrl: body.expected });
  if (isImage(body.frame)) parts.push({ type: "text", text: "Camera, the real build now:" }, { type: "image", dataUrl: body.frame });
  const s = body.step;
  if (s) {
    const partList = s.parts.map((p) => `${p.qty > 1 ? `${p.qty}x ` : ""}${p.name}`).join(", ") || "none listed";
    parts.push({ type: "text", text: `Step ${s.number}: ${s.instruction}\nParts: ${partList}\nWatch for: ${s.watchFor.join("; ") || "nothing noted"}` });
  }
  const known = (body.known ?? []).slice(0, 120);
  if (known.length) parts.push({ type: "text", text: `Steps read so far in this manual:\n${known.map((k) => `Step ${k.number}: ${k.instruction}${k.parts ? ` (parts: ${k.parts})` : ""}`).join("\n")}` });
  const recent = (body.history ?? []).slice(-4).map((h) => `Builder: ${h.q}\nBuildSight: ${h.a}`).join("\n");
  if (recent) parts.push({ type: "text", text: `Recent conversation:\n${recent}` });
  parts.push({ type: "text", text: question });

  const started = Date.now();
  try {
    const text = (await askClaude({ system: SYSTEM_PROMPT, parts, thinking: "off" })).trim();
    return Response.json({ text, latencyMs: Date.now() - started });
  } catch (e) {
    const err = e instanceof ClaudeError ? e : new ClaudeError("Couldn't answer that.");
    return Response.json({ error: err.message }, { status: err.status });
  }
}
