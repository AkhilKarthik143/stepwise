/**
 * Solution-model spec — pure normalization + palette, unit-tested.
 *
 * The AI composes an explanatory diagram (3D assembly or 2D schematic) from
 * labelled primitives via the `show_model` tool. The backend already sanitizes,
 * but the renderer re-validates defensively here (defense in depth) — and this
 * is the headlessly-testable surface for the shape/number/colour rules.
 */
export type ModelMode = "3d" | "2d";

export interface ModelPart {
  shape: string;
  position: number[];
  size: number[];
  rotation: number[];
  color: string;
  label: string;
  /** Optional explanatory note (what the part is / what to do with it). Longer
   *  than the short `label` (a name); shown in the legend and on the focused
   *  part. Omitted when the AI gave none. */
  note?: string;
  /** Optional (2D): draw with a dashed stroke for hidden/internal/reference
   *  geometry. Omitted (solid) unless the AI set it. */
  dashed?: boolean;
  /** Optional (3D): PBR surface finish (metal/plastic/rubber/glass/painted),
   *  independent of colour. Omitted = colour-derived finish (back-compat). */
  material?: string;
  /** Optional (3D): see-through opacity in [MIN,1). Omitted = solid (1). */
  opacity?: number;
  /** Optional (3D): a looping motion that demonstrates an action. */
  animate?: ModelAnimation;
  /** Optional tap-to-view spec sheet: key facts (torque / size / part # / …). */
  spec?: ModelSpecRow[];
  /** Optional short safety caution, shown prominently when the part is tapped. */
  warning?: string;
  /** Which sequence step this part belongs to (1-based), for step-by-step
   *  playback. Omitted = always-present scaffolding (shown at every step). */
  step?: number;
}

/** Pins a 2D diagram over the live camera at a region the AI chose, using the
 *  same [ymin,xmin,ymax,xmax] 0-1000 box convention as annotate_component. */
export interface DiagramAnchor {
  box: [number, number, number, number];
}

export interface ModelSpec {
  mode: ModelMode;
  title: string;
  caption: string;
  parts: ModelPart[];
  /** When set (2D only), the diagram pins over the camera at this box instead of
   *  the floating card. Re-validated on every normalize, so a stale/garbage box
   *  degrades to the floating card, never a crash. */
  anchor?: DiagramAnchor;
  /** Labels of parts the AI is currently emphasizing (highlight_model_part).
   *  Rides on the spec so it clears/persists with the diagram; always a subset
   *  of the parts' labels (matched case-insensitively), never raw model input. */
  emphasis: string[];
  /** Active playback step (set_diagram_step). 0 = playback off (all parts shown
   *  normally). N>0 = on step N: step-N parts glow, later steps dim. Rides on the
   *  spec so it clears/persists/resets with the diagram, clamped to [0, maxStep]. */
  activeStep: number;
  /** Optional pre-built 3D model (operator asset catalog) to display instead of
   *  drawing from primitives — the parts then overlay it as call-outs. Resolved
   *  by the backend; 3D only. Omitted = the diagram is the primitives. */
  asset?: { url: string; title?: string };
}

export const MODEL_3D_SHAPES = ["box", "cylinder", "sphere", "cone", "torus", "arrow", "plane"];
export const MODEL_2D_SHAPES = ["rect", "circle", "line", "arrow", "text", "dimension"];
/** 3D PBR finishes (mirrors the backend MODEL_MATERIALS). */
export const MODEL_MATERIALS = ["metal", "plastic", "rubber", "glass", "painted"];
/** Floor for a see-through part (mirrors backend MODEL_OPACITY_MIN). */
export const MODEL_OPACITY_MIN = 0.05;
/** Looping motion primitives (mirror the backend MODEL_ANIM_TYPES / axes). */
export const MODEL_ANIM_TYPES = ["spin", "swing", "slide", "pulse"];
export const MODEL_AXES = ["x", "y", "z"];
export const MODEL_ANIM_SPEED_MIN = 0.1;
export const MODEL_ANIM_SPEED_MAX = 4;

/** One key/value row of a part's tap-to-view spec sheet. */
export interface ModelSpecRow {
  label: string;
  value: string;
}

/** A looping motion that demonstrates an action on a 3D part. */
export interface ModelAnimation {
  /** spin | swing | slide | pulse */
  type: string;
  /** x | y | z */
  axis: string;
  /** degrees (swing) / model units (slide) / 0-1 scale fraction (pulse). */
  amount?: number;
  /** relative rate (MIN..MAX). */
  speed?: number;
  /** [x,y,z] offset from the part centre for a swing pivot. */
  pivot?: number[];
}

export const MODEL_COLOR_HEX: Record<string, string> = {
  info: "#19c37d",
  warn: "#f4c542",
  danger: "#e5484d",
  accent: "#7cc7ff",
  metal: "#b8c0c8",
  steel: "#8a949e",
  dark: "#2b333c",
  light: "#e8edf2",
};
export const modelColorHex = (c: string): string => MODEL_COLOR_HEX[c] ?? MODEL_COLOR_HEX.info;

const MAX_PARTS = 40;

function nums(value: unknown, count: number, def: number[], lo: number, hi: number): number[] {
  const out = def.slice(0, count);
  if (Array.isArray(value)) {
    for (let i = 0; i < count && i < value.length; i++) {
      const v = Number(value[i]);
      if (Number.isFinite(v)) out[i] = Math.max(lo, Math.min(hi, v));
    }
  }
  return out;
}

/** A 1-based sequence step, or undefined (always-present scaffolding). */
function stepOf(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n >= 1 && n <= MAX_PARTS ? n : undefined;
}

function normalizePart(raw: unknown, mode: ModelMode): ModelPart | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const shape = String(r.shape ?? "").trim().toLowerCase();
  const allowed = mode === "3d" ? MODEL_3D_SHAPES : MODEL_2D_SHAPES;
  if (!allowed.includes(shape)) return null;
  const color = MODEL_COLOR_HEX[String(r.color ?? "").trim().toLowerCase()] ? String(r.color).trim().toLowerCase() : "info";
  const label = String(r.label ?? "").trim().slice(0, 48);
  // Defensive mirror of the backend's MODEL_NOTE_MAX (140); empty -> undefined
  // so a persisted spec stays clean and the renderers can test `part.note`.
  const note = String(r.note ?? "").trim().slice(0, 140) || undefined;
  // Dashed stroke (2D hidden/internal geometry): true only for a real `true`
  // (mirrors the backend), else undefined so a solid part stays clean.
  const dashed = r.dashed === true ? true : undefined;
  // 3D PBR finish: a known preset or undefined (colour-derived finish).
  const matKey = String(r.material ?? "").trim().toLowerCase();
  const material = MODEL_MATERIALS.includes(matKey) ? matKey : undefined;
  // 3D see-through opacity: a finite NUMBER < 1, floored at MIN; else undefined
  // (solid). Gate on typeof number BEFORE coercion — mirrors the backend's bool
  // exclusion and also rejects null / "" (all of which Number()s to 0 and would
  // otherwise floor to a near-invisible 0.05 on the tamperable localStorage read).
  const opRaw = typeof r.opacity === "number" ? r.opacity : NaN;
  const opacity = Number.isFinite(opRaw) && opRaw < 1 ? Math.max(MODEL_OPACITY_MIN, opRaw) : undefined;
  // Looping motion (3D demonstration): a known type or undefined.
  const animate = normalizeAnimate(r.animate);
  // Tap-to-view spec rows + safety warning (interactive depth).
  const spec = normalizeSpecRows(r.spec);
  const warning = String(r.warning ?? "").trim().slice(0, 140) || undefined;
  const step = stepOf(r.step);
  if (mode === "3d") {
    return {
      shape,
      position: nums(r.position, 3, [0, 0, 0], -1000, 1000),
      size: nums(r.size, 3, [1, 1, 1], 0.001, 1000),
      rotation: nums(r.rotation, 3, [0, 0, 0], -3600, 3600),
      color,
      label,
      note,
      dashed,
      material,
      opacity,
      animate,
      spec,
      warning,
      step,
    };
  }
  return {
    shape,
    position: nums(r.position, 2, [50, 50], -50, 150),
    size: nums(r.size, 2, [10, 10], -50, 150),
    rotation: nums(r.rotation, 1, [0], -3600, 3600),
    color,
    label,
    note,
    dashed,
    material,
    opacity,
    animate,
    spec,
    warning,
    step,
  };
}

/** Normalize a raw `model` data-channel payload into a render-safe spec, or null. */
export function normalizeModelSpec(raw: unknown): ModelSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode: ModelMode = r.mode === "2d" ? "2d" : "3d";
  const title = String(r.title ?? "Diagram").trim().slice(0, 80) || "Diagram";
  const caption = String(r.caption ?? "").trim().slice(0, 240);
  const rawParts = Array.isArray(r.parts) ? r.parts.slice(0, MAX_PARTS) : [];
  const parts: ModelPart[] = [];
  for (const rp of rawParts) {
    const p = normalizePart(rp, mode);
    if (p) parts.push(p);
  }
  if (parts.length === 0) return null;
  // Emphasis may ride along on a persisted spec — re-validate it against the
  // parts that actually survived, so a stale/garbage label can never glow.
  const rawEmphasis = Array.isArray((r as Record<string, unknown>).emphasis)
    ? ((r as Record<string, unknown>).emphasis as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  const emphasis = matchLabels(parts, rawEmphasis);
  // Active playback step rides along too; clamp it to the steps that exist.
  const ms = maxStep(parts);
  const rawActive = Number((r as Record<string, unknown>).activeStep);
  const activeStep = Number.isFinite(rawActive)
    ? Math.max(0, Math.min(ms, Math.trunc(rawActive)))
    : 0;
  // Optional camera anchor (2D only): re-validate the box defensively.
  const anchor = mode === "2d" ? normalizeAnchor((r as Record<string, unknown>).anchor) : undefined;
  // Optional pre-built 3D model (3D only): a non-empty url, defensively re-validated.
  const asset = mode === "3d" ? normalizeAsset((r as Record<string, unknown>).asset) : undefined;
  return {
    mode,
    title,
    caption,
    parts,
    emphasis,
    activeStep,
    ...(anchor ? { anchor } : {}),
    ...(asset ? { asset } : {}),
  };
}

/** A render-safe anchor box, or undefined: 4 finite numbers, each clamped to
 *  [0,1000], with a positive area (xmax>xmin and ymax>ymin). */
function normalizeAnchor(raw: unknown): DiagramAnchor | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const box = (raw as Record<string, unknown>).box;
  if (!Array.isArray(box) || box.length !== 4) return undefined;
  const b = box.map((n) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.max(0, Math.min(1000, v)) : NaN;
  });
  if (b.some((v) => Number.isNaN(v))) return undefined;
  const [ymin, xmin, ymax, xmax] = b;
  if (xmax <= xmin || ymax <= ymin) return undefined; // degenerate / inverted
  return { box: [ymin, xmin, ymax, xmax] };
}

/** A render-safe pre-built-model reference, or undefined: needs a non-empty url
 *  (the backend resolved it from its catalog; re-validated here defensively). */
function normalizeAsset(raw: unknown): { url: string; title?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const url = String(r.url ?? "").trim();
  if (!url) return undefined;
  const title = String(r.title ?? "").trim().slice(0, 80) || undefined;
  return title ? { url, title } : { url };
}

/** Render-safe tap-to-view spec rows, or undefined. Each row needs a non-empty
 *  label AND value; both clamped; capped at 6 rows. Mirrors the backend. */
function normalizeSpecRows(raw: unknown): ModelSpecRow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: ModelSpecRow[] = [];
  for (const item of raw.slice(0, 6)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const label = String(r.label ?? "").trim().slice(0, 32);
    const value = String(r.value ?? "").trim().slice(0, 64);
    if (label && value) rows.push({ label, value });
  }
  return rows.length ? rows : undefined;
}

/** A render-safe looping motion, or undefined. Mirrors the backend: a known
 *  `type` is required; axis defaults to 'y'; amount/speed/pivot are bounded and
 *  only kept when a real number (or list) is given. */
function normalizeAnimate(raw: unknown): ModelAnimation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const type = String(r.type ?? "").trim().toLowerCase();
  if (!MODEL_ANIM_TYPES.includes(type)) return undefined;
  const axisRaw = String(r.axis ?? "y").trim().toLowerCase();
  const out: ModelAnimation = { type, axis: MODEL_AXES.includes(axisRaw) ? axisRaw : "y" };
  if (typeof r.amount === "number" && Number.isFinite(r.amount)) {
    out.amount = Math.max(-1000, Math.min(1000, r.amount));
  }
  if (typeof r.speed === "number" && Number.isFinite(r.speed)) {
    out.speed = Math.max(MODEL_ANIM_SPEED_MIN, Math.min(MODEL_ANIM_SPEED_MAX, r.speed));
  }
  // pivot only matters for rotation (about an offset axis); drop it for
  // slide/pulse, where it would shift the motion off the part centre.
  if ((type === "swing" || type === "spin") && Array.isArray(r.pivot)) {
    out.pivot = nums(r.pivot, 3, [0, 0, 0], -1000, 1000);
  }
  return out;
}

/** Highest step number across the parts (0 = no stepped parts / playback N/A). */
export function maxStep(parts: ModelPart[]): number {
  let m = 0;
  for (const p of parts) {
    if (typeof p.step === "number" && p.step > m) m = p.step;
  }
  return m;
}

/** The step to actually render at: the requested activeStep if some part lives
 *  on it, else 0 (show everything). Guards against the AI selecting a step that
 *  has no parts (e.g. a numbering gap), which would otherwise dim the WHOLE
 *  diagram with nothing highlighted. Applied at render so it covers every path. */
export function resolveActiveStep(parts: ModelPart[], activeStep: number): number {
  if (!activeStep || activeStep <= 0) return 0;
  return parts.some((p) => p.step === activeStep) ? activeStep : 0;
}

export type StepPhase = "off" | "always" | "current" | "past" | "future";

/** Where a part sits relative to the active playback step. "off" = playback
 *  inactive (activeStep 0); "always" = unstepped scaffolding; else current/
 *  past/future. Pure — drives the renderers' glow (current) + dim (future). */
export function stepPhase(part: ModelPart, activeStep: number): StepPhase {
  if (!activeStep || activeStep <= 0) return "off";
  if (typeof part.step !== "number") return "always";
  if (part.step === activeStep) return "current";
  return part.step < activeStep ? "past" : "future";
}

/** Subset of `labels` whose (trimmed, lower-cased) form names an actual part,
 *  de-duped, preserving the caller's original casing/order. Pure. */
export function matchLabels(parts: ModelPart[], labels: string[]): string[] {
  const have = new Set(parts.map((p) => p.label.trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const key = raw.trim().toLowerCase();
    if (!key || !have.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(raw.trim());
  }
  return out;
}

/** True when a part's label is in the emphasis set (case-insensitive, trimmed). */
export function isEmphasized(part: ModelPart, emphasis: string[]): boolean {
  if (!emphasis.length || !part.label) return false;
  const key = part.label.trim().toLowerCase();
  return emphasis.some((e) => e.trim().toLowerCase() === key);
}

/** One row of the diagram legend / tap-to-view index. */
export interface LegendEntry {
  part: ModelPart;
  color: string;
  label: string;
  note?: string;
  /** Currently emphasized (highlight / current step). */
  em: boolean;
  /** Has tap-only data (spec rows and/or a safety warning) -> an interactive row. */
  detail: boolean;
}

/**
 * Build the de-duped legend: one entry per (colour,label), capped at 12. Pure.
 *  - A part with NO label but tap-only data (spec/warning, incl. a safety
 *    warning) gets a synthesized name so it still has a tap target.
 *  - On a (colour,label) collision the entry points at the instance carrying the
 *    most tap data (warning > spec > first), so a later duplicate's warning/spec
 *    is never hidden by a detail-less earlier part.
 */
export function buildLegend(parts: ModelPart[], emphasis: string[]): LegendEntry[] {
  const score = (p: ModelPart) => (p.warning ? 2 : 0) + (p.spec?.length ? 1 : 0);
  const em = new Set(emphasis.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const byKey = new Map<string, LegendEntry>();
  const order: string[] = [];
  parts.forEach((p, i) => {
    const s = score(p);
    if (!p.label && s === 0) return; // unlabelled and nothing to tap -> not listed
    const label = p.label || `Part ${i + 1}`;
    const key = `${p.color}:${label}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        part: p,
        color: p.color,
        label,
        note: p.note,
        em: em.has(label.trim().toLowerCase()),
        detail: s > 0,
      });
      order.push(key);
    } else {
      if (!existing.note) existing.note = p.note;
      if (s > score(existing.part)) {
        existing.part = p;
        existing.detail = true;
      }
    }
  });
  return order.slice(0, 12).map((k) => byKey.get(k)!);
}
