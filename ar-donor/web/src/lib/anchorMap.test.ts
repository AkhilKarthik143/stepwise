import { describe, expect, it } from "vitest";
import { anchorBoxToRect } from "./anchorMap";

// box convention: [ymin, xmin, ymax, xmax] normalized 0-1000.
describe("anchorBoxToRect", () => {
  it("maps a box to a percent rect (identity before the video size is known)", () => {
    // iw=ih=0 -> coverMap identity: x=nx*100, y=ny*100.
    const r = anchorBoxToRect([250, 200, 750, 600], 1000, 1000, 0, 0)!;
    expect(r).not.toBeNull();
    expect(r.width).toBeCloseTo(40, 5);
    expect(r.height).toBeCloseTo(50, 5);
    expect(r.left).toBeCloseTo(20, 5); // not clamped -> centred == top-left
    expect(r.top).toBeCloseTo(25, 5);
  });

  it("CENTRES (not top-left-pins) a box wider/taller than the max clamp", () => {
    // x spans 10%..90% (centre 50%) but width clamps to 56 -> must stay centred.
    const r = anchorBoxToRect([400, 100, 600, 900], 1000, 1000, 0, 0)!;
    expect(r.width).toBeCloseTo(56, 5);
    // centre 50 - 56/2 = 22 (NOT 10, which the old top-left pin produced)
    expect(r.left).toBeCloseTo(22, 5);
    expect(r.left + r.width / 2).toBeCloseTo(50, 5); // rect centre == box centre
  });

  it("floors a tiny box to a legible minimum and caps a huge one", () => {
    const tiny = anchorBoxToRect([500, 500, 505, 505], 1000, 1000, 0, 0)!;
    expect(tiny.width).toBeGreaterThanOrEqual(20); // MIN_W
    expect(tiny.height).toBeGreaterThanOrEqual(14); // MIN_H
    const huge = anchorBoxToRect([0, 0, 1000, 1000], 1000, 1000, 0, 0)!;
    expect(huge.width).toBeLessThanOrEqual(56); // MAX_W
    expect(huge.height).toBeLessThanOrEqual(56); // MAX_H
  });

  it("keeps the rect fully on-screen even when the anchor hugs an edge", () => {
    const r = anchorBoxToRect([950, 950, 1000, 1000], 1000, 1000, 0, 0)!;
    expect(r.left + r.width).toBeLessThanOrEqual(100 + 1e-6);
    expect(r.top + r.height).toBeLessThanOrEqual(100 + 1e-6);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.top).toBeGreaterThanOrEqual(0);
  });

  it("returns null when the target is cropped entirely off-screen (fall back to card)", () => {
    // Portrait phone (390x844) over a 16:9 camera (1280x720): cover crops the
    // sides. A left-edge-of-frame box maps fully off the left of the viewport.
    expect(anchorBoxToRect([400, 50, 600, 200], 390, 844, 1280, 720)).toBeNull();
    // A box fully off the right is also null.
    expect(anchorBoxToRect([400, 950, 600, 1000], 390, 844, 1280, 720)).toBeNull();
    // A centred box on the same device IS on-screen.
    expect(anchorBoxToRect([400, 450, 600, 550], 390, 844, 1280, 720)).not.toBeNull();
  });

  it("applies the object-fit:cover crop when the viewport aspect differs", () => {
    const r = anchorBoxToRect([0, 250, 1000, 750], 2000, 1000, 1000, 1000)!;
    expect(r.left).toBeCloseTo(25, 4);
    expect(r.width).toBeCloseTo(50, 4);
    expect(r.height).toBeLessThanOrEqual(56);
    expect(r.top).toBeGreaterThanOrEqual(0);
  });
});
