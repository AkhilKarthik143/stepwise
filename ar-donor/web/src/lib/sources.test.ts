import { describe, expect, it } from "vitest";
import { sanitizeTitles, mergeTitles } from "./sources";

describe("sanitizeTitles", () => {
  it("returns [] for non-arrays (incl. a tampered string)", () => {
    expect(sanitizeTitles("boom")).toEqual([]);
    expect(sanitizeTitles(null)).toEqual([]);
    expect(sanitizeTitles(42)).toEqual([]);
    expect(sanitizeTitles(undefined)).toEqual([]);
  });

  it("keeps strings, trims, drops blanks + non-strings, dedupes ci, caps 3", () => {
    expect(sanitizeTitles(["  A  ", "a", "B", 5, "", "C", "D"])).toEqual(["A", "B", "C"]);
  });
});

describe("mergeTitles", () => {
  it("unions existing + incoming, deduped case-insensitively", () => {
    expect(mergeTitles(["A"], ["a", "B"])).toEqual(["A", "B"]);
  });

  it("caps at 3 with existing taking precedence (concurrent-lookup accumulation)", () => {
    expect(mergeTitles(["A", "B", "C"], ["D"])).toEqual(["A", "B", "C"]);
  });

  it("tolerates garbage incoming without throwing", () => {
    expect(mergeTitles(["A"], "boom")).toEqual(["A"]);
    expect(mergeTitles([], null)).toEqual([]);
    expect(mergeTitles(["A"], [1, null, "B"])).toEqual(["A", "B"]);
  });
});
