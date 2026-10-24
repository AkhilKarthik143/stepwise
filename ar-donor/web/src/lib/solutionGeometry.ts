/**
 * Pure geometry helpers for the solution-diagram renderers — kept out of the
 * .tsx components so the math is headlessly unit-testable (node env, no DOM).
 *
 * 2D: rotation-aware bounding box so the SVG viewBox never clips a rotated or
 *     labelled part. 3D: torus tube clamp + per-shape label clearance.
 */
import type { ModelPart } from "./solutionModel";

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Rotate (px,py) about pivot (cx,cy) by `deg` degrees (SVG screen space). */
export function rotatePointDeg(
  px: number,
  py: number,
  cx: number,
  cy: number,
  deg: number,
): [number, number] {
  if (!deg) return [px, py];
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = px - cx;
  const dy = py - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function expand(b: Box, x: number, y: number): void {
  b.minX = Math.min(b.minX, x);
  b.minY = Math.min(b.minY, y);
  b.maxX = Math.max(b.maxX, x);
  b.maxY = Math.max(b.maxY, y);
}

/** Half-width of a centre-anchored label at `fontSize` (rough glyph metric). */
function labelHalf(label: string, fontSize: number): number {
  return (label.length || 0) * fontSize * 0.32;
}

/**
 * Bounding box that encloses every part's ACTUAL drawn geometry — including its
 * per-part rotation (Shape applies `rotate(rot x y)`) and its text label — so
 * the computed viewBox reserves space for rotated/labelled parts instead of
 * clipping them.
 */
export function diagram2DBounds(parts: ModelPart[]): Box {
  const b: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of parts) {
    const [x, y] = p.position;
    const [w, h] = p.size;
    const rot = p.rotation[0] || 0;
    const pts: Array<[number, number]> = [];

    if (p.shape === "line" || p.shape === "arrow" || p.shape === "dimension") {
      // Endpoint shapes span position -> position+size; the label (a measurement
      // for `dimension`) sits at the midpoint. Tick marks extend a couple units
      // perpendicular, comfortably inside the viewBox pad.
      pts.push([x, y], [x + w, y + h]);
      if (p.label) {
        const mx = x + w / 2;
        const my = y + h / 2;
        const hw = labelHalf(p.label, 5);
        pts.push([mx - hw, my - 4], [mx + hw, my - 4]);
      }
    } else if (p.shape === "circle") {
      const r = Math.abs(w) / 2;
      pts.push([x - r, y - r], [x + r, y - r], [x - r, y + r], [x + r, y + r]);
      if (p.label) {
        const hw = labelHalf(p.label, 5);
        pts.push([x - hw, y + r + 7], [x + hw, y + r + 7]);
      }
    } else if (p.shape === "text") {
      const tw = (p.label.length || 1) * 3.6;
      pts.push([x, y - 6], [x + tw, y - 6], [x, y + 2], [x + tw, y + 2]);
    } else {
      // rect (and any unknown 2D shape rendered as a rect)
      const rw = Math.abs(w);
      const rh = Math.abs(h);
      pts.push(
        [x - rw / 2, y - rh / 2],
        [x + rw / 2, y - rh / 2],
        [x - rw / 2, y + rh / 2],
        [x + rw / 2, y + rh / 2],
      );
      if (p.label) {
        const hw = labelHalf(p.label, 5);
        pts.push([x - hw, y], [x + hw, y]);
      }
    }

    // Every part rotates about its own position (x,y) — see Shape's transform.
    for (const [ux, uy] of pts) {
      const [rx, ry] = rotatePointDeg(ux, uy, x, y, rot);
      expand(b, rx, ry);
    }
  }
  if (!Number.isFinite(b.minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return b;
}

/** Round to 3 decimals — keeps generated transform strings short + stable. */
function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Motion-only SVG transform for an animated 2D part at time `t` SECONDS — to be
 * applied to a wrapper <g> that sits OUTSIDE the part's static-rotation <g>, so
 * it composes cleanly. Mirrors the 3D motion vocabulary:
 *   spin  — continuous in-plane rotation about the part centre;
 *   swing — oscillating rotation (±amount°) about the pivot (centre + pivot xy);
 *   slide — oscillating translation along the x or y axis;
 *   pulse — oscillating scale about the part centre (floored so it never vanishes).
 * Returns "" for a part with no animation. At t=0 every type yields an identity
 * transform (rest pose). PURE + unit-tested; the renderer just sets the string.
 */
export function motionTransform2D(part: ModelPart, t: number): string {
  const a = part.animate;
  if (!a) return "";
  const [x, y] = part.position;
  const tt = t * (a.speed ?? 1);
  if (a.type === "spin") {
    return `rotate(${r3((tt * 60) % 360)} ${r3(x)} ${r3(y)})`; // 60 deg/s * speed
  }
  if (a.type === "swing") {
    const amp = Math.min(180, Math.abs(a.amount ?? 30));
    const px = x + (a.pivot?.[0] ?? 0);
    const py = y + (a.pivot?.[1] ?? 0);
    return `rotate(${r3(Math.sin(tt) * amp)} ${r3(px)} ${r3(py)})`;
  }
  if (a.type === "slide") {
    const off = r3(Math.sin(tt) * Math.min(50, Math.abs(a.amount ?? 5)));
    return a.axis === "y" ? `translate(0 ${off})` : `translate(${off} 0)`;
  }
  if (a.type === "pulse") {
    const amp = Math.min(1, Math.abs(a.amount ?? 0.15));
    const s = r3(Math.max(0.05, 1 + Math.sin(tt) * amp));
    return `translate(${r3(x)} ${r3(y)}) scale(${s}) translate(${r3(-x)} ${r3(-y)})`;
  }
  return "";
}

/**
 * Torus tube radius derived from size, clamped so it can never reach the ring
 * radius (sx/2) — otherwise THREE sweeps the tube through the centre and the
 * hole collapses into a pinched lump. Floor keeps it visible.
 */
export function torusTube(sx: number, sy: number): number {
  return Math.min(Math.max(0.02, sy / 4), sx * 0.45);
}

/**
 * Vertical clearance for a 3D part's label, measured from the part's centre to
 * just above its furthest extent — so the label clears the mesh for ANY
 * rotation (the label is placed in world-up, outside the rotated group).
 */
export function labelReach(shape: string, size: number[]): number {
  const sx = size[0] ?? 1;
  const sy = size[1] ?? 1;
  const sz = size[2] ?? 1;
  if (shape === "sphere") return sx / 2;
  if (shape === "torus") return sx / 2 + torusTube(sx, sy);
  // Bounding-sphere radius guarantees the label clears the part at any rotation.
  return 0.5 * Math.hypot(sx, sy, sz);
}
