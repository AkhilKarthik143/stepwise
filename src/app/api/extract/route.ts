// Reads one manual page image and returns the build steps on it.

import { askClaude, ClaudeError } from "@/lib/claude";
import { firstJsonObject } from "@/lib/json";

const MAX_IMAGE_CHARS = 6_000_000;

export type ExtractedPart = {
  name: string; // "red 2x4 brick", "short wooden dowel"
  color: string; // CSS color for the chip
  qty: number;
  shape: "brick" | "plate" | "tile" | "slope" | "round" | "hardware" | "panel" | "other";
  studsX?: number; // LEGO only
  studsY?: number;
};

export type ExtractedStep = {
  number: number;
  instruction: string; // spoken, imperative, ≤ 20 words
  parts: ExtractedPart[];
  watchFor: string[]; // easy mistakes on this step
  box: { x: number; y: number; w: number; h: number }; // where the step's picture sits, 0–1 of the page
};

const SYSTEM_PROMPT = `You read one page of a picture-based assembly manual (LEGO, IKEA, or similar).
Return every build step on the page, in order. A page may hold 0, 1 or several steps.
Pages with no build actions (cover, parts inventory, ads, pure safety/warning notes) return an empty list.
Some manuals (often IKEA) don't print step numbers: then treat each distinct action picture as a step
and number them yourself in reading order. Skip "don't do this" / warning pictures.

For each step:
- number: the step number printed on the page, or your own reading-order number if none is printed.
- instruction: one imperative sentence, at most 20 words, describing what to do, as you'd say it aloud.
  Name parts by color and size, and say where they go (left, right, front, on top of...).
- parts: the parts shown in that step's callout box (LEGO) or beside the step (IKEA), with quantities.
  For LEGO bricks, plates and tiles, give studsX and studsY (e.g. a 2x4 brick is 2 by 4).
  color: a CSS hex color close to the part's real color.
- watchFor: 0-2 easy mistakes on this step (orientation, which side, which hole, short vs long screw).
- box: where that step's picture sits on the page, INCLUDING its step number and parts box,
  as whole-number percentages of the page: {"left": 0-100, "top": 0-100, "right": 0-100, "bottom": 0-100}.
  Two steps side by side on one page are roughly left 0-50 and left 50-100.

Reply with JSON only, no prose:
{"steps": [{"number": 1, "instruction": "...", "parts": [{"name": "...", "color": "#rrggbb", "qty": 1, "shape": "brick", "studsX": 2, "studsY": 4}], "watchFor": ["..."], "box": {"left": 0, "top": 0, "right": 50, "bottom": 95}}]}`;

function parse(text: string): ExtractedStep[] | null {
  try {
    const steps = (firstJsonObject(text) as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) return null;
    const pct = (n: unknown, fallback: number) => {
      const v = Number(n);
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : fallback;
    };
    return steps
      .filter((s) => Number.isFinite(Number(s?.number)))
      .map((s) => {
        const left = pct(s.box?.left, 0), top = pct(s.box?.top, 0);
        const right = pct(s.box?.right, 1), bottom = pct(s.box?.bottom, 1);
        const sane = right - left > 0.05 && bottom - top > 0.05;
        return {
          number: Number(s.number),
          instruction: String(s.instruction ?? ""),
          parts: (Array.isArray(s.parts) ? s.parts : []).map((p: Record<string, unknown>) => ({
            name: String(p.name ?? "part"),
            color: typeof p.color === "string" ? p.color : "#9e9e9e",
            qty: Number(p.qty ?? p.quantity ?? 1) || 1,
            shape: (p.shape as ExtractedPart["shape"]) ?? "other",
            studsX: p.studsX ? Number(p.studsX) : undefined,
            studsY: p.studsY ? Number(p.studsY) : undefined,
          })),
          watchFor: Array.isArray(s.watchFor) ? s.watchFor.map(String) : [],
          box: sane ? { x: left, y: top, w: right - left, h: bottom - top } : { x: 0, y: 0, w: 1, h: 1 },
        };
      });
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  let page: unknown;
  try {
    page = (await request.json())?.page;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof page !== "string" || !page.startsWith("data:image/") || page.length > MAX_IMAGE_CHARS) {
    return Response.json({ error: "Send `page` as an image data URL." }, { status: 400 });
  }

  const started = Date.now();
  let lastRaw = "";
  try {
    // One retry: replies occasionally come back as prose instead of JSON.
    for (let attempt = 0; attempt < 2; attempt++) {
      lastRaw = await askClaude({
        system: SYSTEM_PROMPT,
        parts: [
          { type: "image", dataUrl: page },
          { type: "text", text: "Extract the steps on this page. JSON only." },
        ],
      });
      const steps = parse(lastRaw);
      if (steps) return Response.json({ steps, latencyMs: Date.now() - started });
      console.warn("[extract] unparseable reply:", lastRaw.slice(0, 400));
    }
  } catch (e) {
    const err = e instanceof ClaudeError ? e : new ClaudeError("Couldn't read that page.");
    return Response.json({ error: err.message }, { status: err.status });
  }
  return Response.json({ error: "Couldn't read steps from that page.", raw: lastRaw.slice(0, 300) }, { status: 502 });
}
