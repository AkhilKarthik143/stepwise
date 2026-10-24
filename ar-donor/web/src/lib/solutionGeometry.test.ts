import { describe, expect, it } from "vitest";
import {
  rotatePointDeg,
  diagram2DBounds,
  torusTube,
  labelReach,
  motionTransform2D,
} from "./solutionGeometry";
import type { ModelPart } from "./solutionModel";

const part = (over: Partial<ModelPart>): ModelPart => ({
  shape: "rect",
  position: [50, 50],
  size: [10, 10],
  rotation: [0],
  color: "info",
  label: "",
  ...over,
});

describe("rotatePointDeg", () => {
  it("is identity at 0 degrees", () => {
    expect(rotatePointDeg(5, 7, 0, 0, 0)).toEqual([5, 7]);
  });
  it("rotates 90deg about a pivot", () => {
    const [x, y] = rotatePointDeg(10, 0, 0, 0, 90);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(10, 6);
  });
});

describe("diagram2DBounds", () => {
  it("encloses an unrotated rect (centre +/- half size)", () => {
    const b = diagram2DBounds([part({ shape: "rect", position: [50, 50], size: [40, 20] })]);
    expect(b.minX).toBeCloseTo(30, 6);
    expect(b.maxX).toBeCloseTo(70, 6);
    expect(b.minY).toBeCloseTo(40, 6);
    expect(b.maxY).toBeCloseTo(60, 6);
  });

  it("reserves space for a part rotated 90deg (the clipping repro)", () => {
    // rect 120 wide x 10 tall, rotated 90deg about its centre, sweeps ~120 tall.
    const b = diagram2DBounds([
      part({ shape: "rect", position: [50, 50], size: [120, 10], rotation: [90] }),
    ]);
    // Unrotated bounds() would give Y in [45,55]; rotation-aware must span ~[-10,110].
    expect(b.maxY - b.minY).toBeGreaterThan(110);
    expect(b.minY).toBeLessThan(0);
    expect(b.maxY).toBeGreaterThan(100);
    // And the X extent should now be the small (10) dimension, ~[45,55].
    expect(b.maxX - b.minX).toBeLessThan(20);
  });

  it("encloses a rotated line's endpoints", () => {
    const b = diagram2DBounds([
      part({ shape: "line", position: [0, 0], size: [100, 0], rotation: [90] }),
    ]);
    // A horizontal 100-long line rotated 90deg becomes vertical from (0,0)..(0,100).
    expect(b.maxY).toBeGreaterThan(95);
    expect(Math.abs(b.maxX)).toBeLessThan(20);
  });

  it("includes label extent for a labelled part", () => {
    const noLabel = diagram2DBounds([part({ shape: "circle", position: [50, 50], size: [4] })]);
    const labelled = diagram2DBounds([
      part({ shape: "circle", position: [50, 50], size: [4], label: "long valve label" }),
    ]);
    // The label widens the box and drops below the circle.
    expect(labelled.maxX - labelled.minX).toBeGreaterThan(noLabel.maxX - noLabel.minX);
    expect(labelled.maxY).toBeGreaterThan(noLabel.maxY);
  });

  it("never returns a non-finite box", () => {
    const b = diagram2DBounds([]);
    expect(Number.isFinite(b.minX)).toBe(true);
    expect(b.maxX).toBeGreaterThan(b.minX);
  });
});

describe("torusTube", () => {
  it("keeps the tube below the ring radius (no pinch)", () => {
    // size=[0.2,4]: ring radius 0.1; naive sy/4=1.0 would pinch.
    const tube = torusTube(0.2, 4);
    expect(tube).toBeLessThan(0.2 / 2); // strictly under ring radius
    expect(tube).toBeCloseTo(0.09, 6); // sx*0.45
  });
  it("honours the visibility floor", () => {
    expect(torusTube(10, 0.001)).toBeCloseTo(0.02, 6);
  });
  it("uses sy/4 when it fits under the ring", () => {
    expect(torusTube(10, 4)).toBeCloseTo(1, 6); // sy/4=1 < sx*0.45=4.5
  });
});

describe("labelReach", () => {
  it("uses the sphere radius (sx/2), not sy", () => {
    expect(labelReach("sphere", [2, 0.5, 2])).toBeCloseTo(1, 6);
  });
  it("clears a flat torus ring (sx/2 + tube)", () => {
    const r = labelReach("torus", [4, 0.2, 4]);
    expect(r).toBeCloseTo(2 + torusTube(4, 0.2), 6);
    expect(r).toBeGreaterThan(2); // above the ring radius
  });
  it("uses the bounding-sphere radius for box-like shapes", () => {
    expect(labelReach("box", [1, 1, 1])).toBeCloseTo(0.5 * Math.hypot(1, 1, 1), 6);
  });
  it("is large enough to clear a long box at any rotation", () => {
    // A 6-long box rotated could reach ~3 from centre along its long axis.
    expect(labelReach("box", [6, 1, 1])).toBeGreaterThanOrEqual(3);
  });
});

describe("motionTransform2D", () => {
  it("returns empty for a non-animated part", () => {
    expect(motionTransform2D(part({}), 1.23)).toBe("");
  });

  it("is an identity (rest) transform at t=0 for every type", () => {
    expect(
      motionTransform2D(part({ position: [50, 40], animate: { type: "spin", axis: "y" } }), 0),
    ).toBe("rotate(0 50 40)");
    expect(
      motionTransform2D(part({ position: [50, 40], animate: { type: "swing", axis: "y", amount: 30 } }), 0),
    ).toBe("rotate(0 50 40)");
    expect(motionTransform2D(part({ animate: { type: "slide", axis: "x", amount: 5 } }), 0)).toBe(
      "translate(0 0)",
    );
    expect(
      motionTransform2D(part({ position: [50, 40], animate: { type: "pulse", axis: "y", amount: 0.2 } }), 0),
    ).toBe("translate(50 40) scale(1) translate(-50 -40)");
  });

  it("swing reaches +amount about the (centre + pivot) point at sin=1", () => {
    const p = part({ position: [50, 40], animate: { type: "swing", axis: "y", amount: 30, pivot: [0, -10, 0] } });
    expect(motionTransform2D(p, Math.PI / 2)).toBe("rotate(30 50 30)"); // py = 40 + (-10)
  });

  it("slide moves along x or y per axis", () => {
    expect(motionTransform2D(part({ animate: { type: "slide", axis: "x", amount: 6 } }), Math.PI / 2)).toBe(
      "translate(6 0)",
    );
    expect(motionTransform2D(part({ animate: { type: "slide", axis: "y", amount: 6 } }), Math.PI / 2)).toBe(
      "translate(0 6)",
    );
  });

  it("clamps swing amplitude (<=180) and floors pulse scale (>=0.05)", () => {
    expect(
      motionTransform2D(part({ position: [0, 0], animate: { type: "swing", axis: "y", amount: 999 } }), Math.PI / 2),
    ).toBe("rotate(180 0 0)");
    // pulse amount 1 at sin=-1 -> 1 + (-1) = 0 -> floored to 0.05
    expect(
      motionTransform2D(part({ position: [10, 10], animate: { type: "pulse", axis: "y", amount: 1 } }), (3 * Math.PI) / 2),
    ).toBe("translate(10 10) scale(0.05) translate(-10 -10)");
  });
});
