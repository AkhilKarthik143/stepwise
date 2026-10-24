// "Where am I?": finds the builder's place from the camera. Gets contact sheets of the manual's
// step pictures (each tile labeled with its step number) and a camera frame, and returns the last
// step that looks finished.

import { askClaude, ClaudeError, type Part } from "@/lib/claude";
import { firstJsonObject } from "@/lib/json";

const MAX_IMAGE_CHARS = 4_000_000;
const MAX_SHEETS = 8;

export type LocateResult = { completed_step: number; confidence: number; say: string };

type LocateRequest = {
  frame?: string; // camera frame, data URL
  sheets?: { image: string; numbers: number[] }[]; // contact sheets of step pictures, data URLs
  complete?: boolean; // false while the rest of the book is still being read
};

const SYSTEM_PROMPT = `A builder is partway through a build and asks where they are.
You get contact sheets of the manual: each tile is one step's picture, labeled with its step number in the top-left corner. Then a CAMERA photo of the real build now.
Find the last step whose picture matches the real build: everything up to that step is built, and the next step's new parts are not attached yet.
Compare shape, size, colors and which parts are present. Ignore camera angle, lighting, the drawing style and loose parts lying beside the build.
Reply with JSON only, no other text:
{"completed_step": number (0 if nothing is built yet), "confidence": number between 0 and 1, "say": "one short sentence for the builder"}
Set confidence below 0.7 when two steps look alike, the view is unclear, or no tile matches well.`;

function isImage(s: unknown): s is string {
  return typeof s === "string" && s.startsWith("data:image/") && s.length <= MAX_IMAGE_CHARS;
}

export async function POST(request: Request) {
  let body: LocateRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const sheets = (body.sheets ?? []).filter((s) => isImage(s.image) && Array.isArray(s.numbers) && s.numbers.length).slice(0, MAX_SHEETS);
  if (!isImage(body.frame) || !sheets.length) return Response.json({ error: "Send `frame` and at least one contact sheet." }, { status: 400 });

  const parts: Part[] = [];
  for (const s of sheets) parts.push({ type: "text", text: `Manual steps ${s.numbers[0]} to ${s.numbers[s.numbers.length - 1]}:` }, { type: "image", dataUrl: s.image });
  parts.push(
    { type: "text", text: "CAMERA, the real build now:" },
    { type: "image", dataUrl: body.frame },
    { type: "text", text: body.complete === false ? "These are only the steps read so far; later steps may be missing. Which step has the builder just finished?" : "Which step has the builder just finished?" },
  );

  const valid = new Set([0, ...sheets.flatMap((s) => s.numbers)]);
  const started = Date.now();
  try {
    const text = await askClaude({ system: SYSTEM_PROMPT, parts, effort: "medium" });
    const r = firstJsonObject(text) as { completed_step?: unknown; confidence?: unknown; say?: unknown } | null;
    const step = Number(r?.completed_step);
    if (!r || !valid.has(step) || typeof r.confidence !== "number") {
      return Response.json({ error: "Couldn't tell where you are.", raw: text.slice(0, 300) }, { status: 502 });
    }
    const result: LocateResult = { completed_step: step, confidence: Math.max(0, Math.min(1, r.confidence)), say: typeof r.say === "string" ? r.say : "" };
    return Response.json({ ...result, latencyMs: Date.now() - started });
  } catch (e) {
    const err = e instanceof ClaudeError ? e : new ClaudeError("Couldn't tell where you are.");
    return Response.json({ error: err.message }, { status: err.status });
  }
}
