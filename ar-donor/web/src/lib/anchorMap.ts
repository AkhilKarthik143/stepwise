/**
 * Map a Gemini anchor box ([ymin,xmin,ymax,xmax] normalized 0-1000 over the
 * camera frame) to a viewport-percent rect for pinning the 2D diagram over the
 * live camera. Pure + unit-tested. Goes through the SAME object-fit:cover
 * transform as the annotations (coverMap), so the diagram lands on the real
 * pixels even when the viewport aspect differs from the camera's.
 */
import { coverMap } from "./coverMap";

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// A pinned diagram needs a legible minimum size, but must not swallow the whole
// view — clamp the mapped box to this band (viewport percent).
const MIN_W = 20;
const MIN_H = 14;
const MAX_W = 56;
const MAX_H = 56;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function anchorBoxToRect(
  box: number[],
  cw: number,
  ch: number,
  iw: number,
  ih: number,
): ScreenRect | null {
  const [ymin, xmin, ymax, xmax] = box;
  const tl = coverMap(xmin / 1000, ymin / 1000, cw, ch, iw, ih);
  const br = coverMap(xmax / 1000, ymax / 1000, cw, ch, iw, ih);
  const minX = Math.min(tl.x, br.x);
  const maxX = Math.max(tl.x, br.x);
  const minY = Math.min(tl.y, br.y);
  const maxY = Math.max(tl.y, br.y);
  // The target is entirely cropped off-screen on an axis (e.g. edge-of-frame
  // equipment on a portrait phone over a wide camera): there is no honest place
  // to pin — return null so the caller falls back to the floating card rather
  // than gluing the diagram to a screen edge over equipment that isn't there.
  if (maxX <= 0 || minX >= 100 || maxY <= 0 || minY >= 100) return null;
  const width = clamp(maxX - minX, MIN_W, MAX_W);
  const height = clamp(maxY - minY, MIN_H, MAX_H);
  // CENTRE the (possibly clamped) rect on the target's midpoint, then pull it
  // inside the viewport — so when the box is larger than the max clamp the
  // diagram stays centred over the equipment instead of drifting to the corner.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const left = clamp(cx - width / 2, 0, 100 - width);
  const top = clamp(cy - height / 2, 0, 100 - height);
  return { left, top, width, height };
}
