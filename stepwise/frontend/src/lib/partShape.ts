import type { BuildPart } from "./api";

// Which 3D shape to show for the part to grab. Plain LEGO bricks, plates and tiles are drawn to
// real proportions from their size. Everything else (slopes, bolts, dowels, panels, cam locks…)
// gets a stand-in from its shape family; the caption always names the real part, so the shape
// is a cue, never the source of truth. Sub-assemblies get no hologram.

export type Shape = "brick" | "plate" | "tile" | "slope" | "round" | "bolt" | "dowel" | "ring" | "cam" | "key" | "panel" | "leg" | "block";

export interface HoloPart { shape: Shape; x: number; y: number; color: string; label: string }

// LEGO color names as the manual reader writes them (Rebrickable / BrickLink hex values), plus
// common furniture finishes.
const COLORS: Record<string, string> = {
  white: "#f4f4f4", black: "#1b2a34", red: "#c91a09", "dark red": "#720e0f", blue: "#0055bf",
  "dark blue": "#0a3463", "medium blue": "#5a93db", "medium azure": "#36aebf", "dark azure": "#078bc9",
  yellow: "#f2cd37", orange: "#fe8a18", green: "#237841", "dark green": "#184632", "bright green": "#4b9f4a",
  lime: "#bbe90b", "lime green": "#bbe90b", tan: "#e4cd9e", "dark tan": "#958a73", brown: "#583927",
  "reddish brown": "#582a12", "light gray": "#9ba19d", "light grey": "#9ba19d", "light bluish gray": "#a0a5a9",
  "light bluish grey": "#a0a5a9", "dark gray": "#6d6e5c", "dark grey": "#6d6e5c", "dark bluish gray": "#6c6e68",
  "dark bluish grey": "#6c6e68", gray: "#a0a5a9", grey: "#a0a5a9", pink: "#fc97ac", "bright pink": "#e4adc8",
  "dark pink": "#c870a0", purple: "#81007b", "dark purple": "#3f3691", "medium lavender": "#ac78ba",
  lavender: "#e1d5ed", magenta: "#923978", "sand green": "#a0bcac", "sand blue": "#6074a1", "olive green": "#9b9a5a",
  "dark orange": "#a95500", "bright light orange": "#f8bb3d", "bright light yellow": "#fff03a",
  silver: "#c0c4c8", metal: "#b4b8bc", steel: "#b4b8bc", chrome: "#d8dce0", zinc: "#b4b8bc", brass: "#c9a74a",
  wood: "#c8a26b", birch: "#e2c99a", oak: "#c49a5c", pine: "#dcb77a", "white stained oak": "#e8dcc4",
  "black-brown": "#3a2a22", "black brown": "#3a2a22", beige: "#e3d3b4",
};

const METAL = /\b(screw|bolt|nut|washer|cam|key|allen|hex|bracket|hinge|nail|pin)\b/i;
const WOOD = /\b(panel|board|shelf|side|top|leg|dowel|rail|plank|door|drawer|back)\b/i;

// [pattern, shape]; the first match wins, so specific names come before general ones.
const FAMILIES: [RegExp, Shape][] = [
  [/\b(slope|wedge|ramp)\b/i, "slope"],
  [/\b(round|cone|dish|cylinder|disc|wheel|tire|tyre)\b/i, "round"],
  [/\b(screw|bolt|nail)\b/i, "bolt"],
  [/\b(dowel|pin|peg|axle|rod)\b/i, "dowel"],
  [/\b(nut|washer|ring|spacer)\b/i, "ring"],
  [/\bcam\b|\bcam lock\b|\bcam fitting\b/i, "cam"],
  [/\b(allen|hex key|key)\b/i, "key"],
  [/\b(leg|post|column)\b/i, "leg"],
  [/\b(panel|board|shelf|top|side|door|back|plank|drawer)\b/i, "panel"],
];

const LEGO = /^(brick|plate|tile)\s+(\d{1,2})\s*[x×]\s*(\d{1,2})$|^(\d{1,2})\s*[x×]\s*(\d{1,2})\s+(brick|plate|tile)$/i;
const SIZE = /(\d{1,2})\s*[x×]\s*(\d{1,2})/;

function colorFor(part: BuildPart): string {
  const named = COLORS[part.color.trim().toLowerCase()];
  if (named) return named;
  if (METAL.test(part.name)) return COLORS.steel;
  if (WOOD.test(part.name)) return COLORS.wood;
  return "#a8b4bc";
}

function label(part: BuildPart): string {
  const words = [part.color, part.name].filter(Boolean).join(" ");
  return part.qty > 1 ? `${part.qty}× ${words}` : words;
}

export function holoPart(part: BuildPart): HoloPart | null {
  const name = part.name.trim();
  if (!name || /\b(sub-?assembly|assembly from|from steps?)\b/i.test(name)) return null;
  const color = colorFor(part);
  const lego = name.match(LEGO);
  if (lego) {
    const shape = (lego[1] ?? lego[6]).toLowerCase() as Shape;
    const x = Number(lego[2] ?? lego[4]);
    const y = Number(lego[3] ?? lego[5]);
    if (x >= 1 && y >= 1 && x <= 16 && y <= 16) return { shape, x, y, color, label: label(part) };
  }
  const size = name.match(SIZE);
  const x = size ? Math.min(8, Math.max(1, Number(size[1]))) : 2;
  const y = size ? Math.min(8, Math.max(1, Number(size[2]))) : 2;
  const shape = FAMILIES.find(([re]) => re.test(name))?.[1] ?? "block";
  return { shape, x, y, color, label: label(part) };
}

export function firstHoloPart(parts: BuildPart[]): HoloPart | null {
  for (const p of parts) {
    const h = holoPart(p);
    if (h) return h;
  }
  return null;
}
