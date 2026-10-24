import { describe, expect, it } from "vitest";
import { coverMap } from "./coverMap";

// Camera frame 1280x720 (16:9) shown via object-fit:cover.
const IW = 1280;
const IH = 720;

describe("coverMap", () => {
  it("is identity-ish (percent passthrough) until the video size is known", () => {
    expect(coverMap(0.5, 0.25, 1000, 800, 0, 0)).toEqual({ x: 50, y: 25 });
    expect(coverMap(0.5, 0.25, 0, 0, IW, IH)).toEqual({ x: 50, y: 25 });
  });

  it("matches exactly when viewport aspect equals camera aspect", () => {
    // 1600x900 is also 16:9 — no crop, pure scale.
    const p = coverMap(0.25, 0.75, 1600, 900, IW, IH);
    expect(p.x).toBeCloseTo(25, 6);
    expect(p.y).toBeCloseTo(75, 6);
  });

  it("crops VERTICALLY when the viewport is wider than the camera (16:9 -> 21:9)", () => {
    // 2100x900 viewport: scale = 2100/1280; displayed height > 900 -> oy < 0.
    const cw = 2100;
    const ch = 900;
    const centre = coverMap(0.5, 0.5, cw, ch, IW, IH);
    expect(centre.x).toBeCloseTo(50, 6); // centre is invariant
    expect(centre.y).toBeCloseTo(50, 6);
    const top = coverMap(0.5, 0, cw, ch, IW, IH);
    expect(top.y).toBeLessThan(0); // the frame's top edge is OFF-SCREEN (cropped)
    const scale = cw / IW;
    const oy = (ch - IH * scale) / 2;
    expect(top.y).toBeCloseTo((oy / ch) * 100, 6); // exact crop math
  });

  it("crops HORIZONTALLY when the viewport is taller (portrait phone)", () => {
    // 390x844 portrait vs a 16:9 landscape camera: massive horizontal crop.
    const cw = 390;
    const ch = 844;
    const left = coverMap(0, 0.5, cw, ch, IW, IH);
    const right = coverMap(1, 0.5, cw, ch, IW, IH);
    expect(left.x).toBeLessThan(0); // frame edges far off-screen
    expect(right.x).toBeGreaterThan(100);
    const mid = coverMap(0.5, 0.5, cw, ch, IW, IH);
    expect(mid.x).toBeCloseTo(50, 6);
    // Vertical axis has no crop in this case: 0 maps to 0, 1 maps to 100.
    expect(coverMap(0.5, 0, cw, ch, IW, IH).y).toBeCloseTo(0, 6);
    expect(coverMap(0.5, 1, cw, ch, IW, IH).y).toBeCloseTo(100, 6);
  });

  it("is monotonic: larger normalized coords never map left/above smaller ones", () => {
    const cw = 777;
    const ch = 533;
    let prevX = -Infinity;
    for (let i = 0; i <= 10; i++) {
      const { x } = coverMap(i / 10, 0.5, cw, ch, IW, IH);
      expect(x).toBeGreaterThan(prevX);
      prevX = x;
    }
  });
});
