import { describe, expect, it } from "vitest";
import { coverInverse, coverMap } from "../../stepwise/frontend/src/lib/coverMap";

describe("camera object-fit: cover mapping", () => {
  it("maps an exact-aspect frame without distortion", () => {
    expect(coverMap(0.25, 0.75, 400, 300, 1600, 1200)).toEqual({ x: 25, y: 75 });
    expect(coverInverse(100, 225, 400, 300, 1600, 1200)).toEqual({ x: 0.25, y: 0.75 });
  });

  it("accounts for horizontal crop in a square viewport", () => {
    const left = coverMap(0, 0.5, 400, 400, 1600, 900);
    const center = coverMap(0.5, 0.5, 400, 400, 1600, 900);
    const right = coverMap(1, 0.5, 400, 400, 1600, 900);
    expect(left.x).toBeCloseTo(-38.8889, 3);
    expect(center).toEqual({ x: 50, y: 50 });
    expect(right.x).toBeCloseTo(138.8889, 3);
  });

  it("round-trips visible points and clamps taps outside the crop", () => {
    const mapped = coverMap(0.7, 0.5, 400, 400, 1600, 900);
    const roundTrip = coverInverse((mapped.x / 100) * 400, (mapped.y / 100) * 400, 400, 400, 1600, 900);
    expect(roundTrip.x).toBeCloseTo(0.7, 5);
    expect(roundTrip.y).toBeCloseTo(0.5, 5);
    expect(coverInverse(-300, 200, 400, 400, 1600, 900).x).toBe(0);
    expect(coverInverse(800, 200, 400, 400, 1600, 900).x).toBe(1);
  });

  it("uses normalized percentages while video metadata is unavailable", () => {
    expect(coverMap(0.2, 0.8, 400, 400, 0, 0)).toEqual({ x: 20, y: 80 });
    expect(coverInverse(100, 200, 400, 400, 0, 0)).toEqual({ x: 0.25, y: 0.5 });
  });
});
