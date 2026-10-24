import { describe, expect, it } from "vitest";
import {
  normalizeModelSpec,
  modelColorHex,
  MODEL_COLOR_HEX,
  matchLabels,
  isEmphasized,
  buildLegend,
  maxStep,
  stepPhase,
  resolveActiveStep,
  type ModelPart,
} from "./solutionModel";

const mkPart = (label: string): ModelPart => ({
  shape: "box",
  position: [0, 0, 0],
  size: [1, 1, 1],
  rotation: [0, 0, 0],
  color: "info",
  label,
});

describe("normalizeModelSpec", () => {
  it("returns null for non-objects and empty/invalid part lists", () => {
    expect(normalizeModelSpec(null)).toBeNull();
    expect(normalizeModelSpec("nope")).toBeNull();
    expect(normalizeModelSpec({ mode: "3d", title: "x", parts: [] })).toBeNull();
    expect(normalizeModelSpec({ mode: "3d", title: "x", parts: [{ shape: "bogus" }] })).toBeNull();
    expect(normalizeModelSpec({ mode: "3d", title: "x", parts: "notarray" })).toBeNull();
  });

  it("defaults mode to 3d and fills a title", () => {
    const spec = normalizeModelSpec({ parts: [{ shape: "box" }] })!;
    expect(spec.mode).toBe("3d");
    expect(spec.title).toBe("Diagram");
    expect(spec.parts).toHaveLength(1);
  });

  it("clamps the title to 80 chars and caption to 240", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "T".repeat(200),
      caption: "C".repeat(400),
      parts: [{ shape: "box" }],
    })!;
    expect(spec.title).toHaveLength(80);
    expect(spec.caption).toHaveLength(240);
  });

  it("drops invalid parts and keeps valid ones (3d)", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [
        { shape: "box", color: "metal", label: "housing" },
        { shape: "arrow", position: [0, Infinity, 0], color: "neon", label: "flow" },
        { shape: "rect" }, // 2d-only shape, invalid in 3d
        "junk",
        42,
      ],
    })!;
    expect(spec.parts).toHaveLength(2);
    expect(spec.parts[0].color).toBe("metal");
    // Infinity coerced to the default 0; unknown color falls back to info.
    expect(spec.parts[1].position).toEqual([0, 0, 0]);
    expect(spec.parts[1].color).toBe("info");
    // 3d parts carry 3-vectors.
    expect(spec.parts.every((p) => p.position.length === 3)).toBe(true);
    expect(spec.parts.every((p) => p.size.length === 3)).toBe(true);
    expect(spec.parts.every((p) => p.rotation.length === 3)).toBe(true);
  });

  it("uses 2-vectors and a single rotation in 2d, dropping 3d-only shapes", () => {
    const spec = normalizeModelSpec({
      mode: "2d",
      title: "Wiring",
      parts: [
        { shape: "rect", position: [10, 20], size: [30, 15], label: "relay" },
        { shape: "arrow", position: [0, 0], size: [40, 0], color: "danger" },
        { shape: "sphere" }, // 3d-only, invalid in 2d
      ],
    })!;
    expect(spec.mode).toBe("2d");
    expect(spec.parts).toHaveLength(2);
    expect(spec.parts.every((p) => p.position.length === 2)).toBe(true);
    expect(spec.parts.every((p) => p.rotation.length === 1)).toBe(true);
  });

  it("caps parts at 40", () => {
    const many = Array.from({ length: 65 }, () => ({ shape: "box" }));
    const spec = normalizeModelSpec({ mode: "3d", title: "big", parts: many })!;
    expect(spec.parts).toHaveLength(40);
  });

  it("truncates labels to 48 chars", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [{ shape: "box", label: "L".repeat(99) }],
    })!;
    expect(spec.parts[0].label).toHaveLength(48);
  });

  it("keeps an explanatory note, trimmed and clamped to 140 chars", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [
        { shape: "box", label: "housing", note: "  cast aluminium body  " },
        { shape: "cylinder", label: "shaft", note: "N".repeat(300) },
      ],
    })!;
    expect(spec.parts[0].note).toBe("cast aluminium body"); // trimmed
    expect(spec.parts[1].note).toHaveLength(140); // clamped
  });

  it("leaves note undefined when absent or blank, coerces a non-string (back-compat)", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [
        { shape: "box", label: "a" }, // no note key
        { shape: "box", label: "b", note: "   " }, // whitespace only
        { shape: "box", label: "c", note: 123 }, // non-string -> "123"
      ],
    })!;
    expect(spec.parts[0].note).toBeUndefined();
    expect(spec.parts[1].note).toBeUndefined();
    expect(spec.parts[2].note).toBe("123");
  });

  it("accepts the 2d `dimension` shape and parses `dashed` (strict true only)", () => {
    const spec = normalizeModelSpec({
      mode: "2d",
      title: "x",
      parts: [
        { shape: "dimension", position: [10, 10], size: [40, 0], label: "25 mm" },
        { shape: "rect", label: "cover", dashed: true },
        { shape: "rect", label: "solid" },
        // The frontend re-validates already-backend-shaped data (where dashed is a
        // real bool), so it is strict: a "true" string is NOT treated as dashed.
        { shape: "rect", label: "str", dashed: "true" },
      ],
    })!;
    expect(spec.parts).toHaveLength(4);
    expect(spec.parts[0].shape).toBe("dimension");
    expect(spec.parts[1].dashed).toBe(true);
    expect(spec.parts[2].dashed).toBeUndefined();
    expect(spec.parts[3].dashed).toBeUndefined();
  });

  it("keeps a 3d `asset` with a non-empty url; drops it url-less or in 2d", () => {
    const m3 = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [{ shape: "box" }],
      asset: { url: "/m.glb", title: "Machine" },
    })!;
    expect(m3.asset).toEqual({ url: "/m.glb", title: "Machine" });
    expect(
      normalizeModelSpec({ mode: "3d", title: "x", parts: [{ shape: "box" }], asset: { title: "no url" } })!.asset,
    ).toBeUndefined();
    expect(
      normalizeModelSpec({ mode: "2d", title: "x", parts: [{ shape: "rect" }], asset: { url: "/m.glb" } })!.asset,
    ).toBeUndefined();
  });

  it("drops `dimension` in 3d mode (it is a 2d-only shape)", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [{ shape: "dimension" }, { shape: "box" }],
    })!;
    expect(spec.parts).toHaveLength(1);
    expect(spec.parts[0].shape).toBe("box");
  });

  it("parses 3d `material` (known preset only) and see-through `opacity`", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [
        { shape: "box", label: "housing", material: "glass", opacity: 0.3 },
        { shape: "box", label: "bad", material: "unobtanium", opacity: 2 }, // both invalid
        { shape: "box", label: "tiny", opacity: 0.001 }, // floored to MIN
        { shape: "box", label: "solid" },
      ],
    })!;
    expect(spec.parts[0].material).toBe("glass");
    expect(spec.parts[0].opacity).toBe(0.3);
    expect(spec.parts[1].material).toBeUndefined(); // unknown preset dropped
    expect(spec.parts[1].opacity).toBeUndefined(); // 2 is not < 1 -> solid
    expect(spec.parts[2].opacity).toBe(0.05); // floored to MODEL_OPACITY_MIN
    expect(spec.parts[3].material).toBeUndefined();
    expect(spec.parts[3].opacity).toBeUndefined();
  });

  it("rejects a non-number opacity (bool/null/empty) instead of coercing to 0.05", () => {
    // Number(false)/Number(null)/Number("") all === 0, which is < 1 — without a
    // typeof guard they would floor to a near-invisible 0.05. Mirrors the backend,
    // which drops non-numbers, so a solid part stays solid on a tampered read.
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [
        { shape: "box", label: "f", opacity: false },
        { shape: "box", label: "n", opacity: null },
        { shape: "box", label: "e", opacity: "" },
        { shape: "box", label: "s", opacity: "0.3" }, // a numeric STRING is not a number either
      ],
    })!;
    expect(spec.parts[0].opacity).toBeUndefined();
    expect(spec.parts[1].opacity).toBeUndefined();
    expect(spec.parts[2].opacity).toBeUndefined();
    expect(spec.parts[3].opacity).toBeUndefined();
  });

  it("parses 3d `animate` (known type, axis default, clamps) and drops unknown", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [
        { shape: "box", label: "blade", animate: { type: "swing", axis: "z", amount: 35, speed: 9, pivot: [0, -1, 0] } },
        { shape: "box", label: "weird", animate: { type: "wobble" } },
        { shape: "box", label: "badaxis", animate: { type: "spin", axis: "q" } },
        { shape: "box", label: "still" },
      ],
    })!;
    expect(spec.parts[0].animate).toEqual({
      type: "swing",
      axis: "z",
      amount: 35,
      speed: 4, // clamped to MODEL_ANIM_SPEED_MAX
      pivot: [0, -1, 0],
    });
    expect(spec.parts[1].animate).toBeUndefined(); // unknown type
    expect(spec.parts[2].animate!.axis).toBe("y"); // bad axis -> default
    expect(spec.parts[3].animate).toBeUndefined();
  });

  it("parses tap-to-view `spec` rows (clean only) and a `warning`", () => {
    const m = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [
        {
          shape: "box",
          label: "bolt",
          warning: "  Hot surface  ",
          spec: [
            { label: "Torque", value: "25 Nm" },
            { label: " ", value: "x" }, // blank label -> dropped
            { label: "Size", value: "" }, // blank value -> dropped
            "junk", // non-object -> dropped
          ],
        },
        { shape: "box", label: "plain" },
      ],
    })!;
    expect(m.parts[0].warning).toBe("Hot surface");
    expect(m.parts[0].spec).toEqual([{ label: "Torque", value: "25 Nm" }]);
    expect(m.parts[1].spec).toBeUndefined();
    expect(m.parts[1].warning).toBeUndefined();
  });

  it("keeps a swing pivot but drops pivot for non-rotation motions (pulse/slide)", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [
        { shape: "box", label: "blade", animate: { type: "swing", pivot: [0, -1, 0] } },
        { shape: "box", label: "pulse", animate: { type: "pulse", amount: 0.3, pivot: [1, 0, 0] } },
        { shape: "box", label: "slide", animate: { type: "slide", amount: 2, pivot: [1, 0, 0] } },
      ],
    })!;
    expect(spec.parts[0].animate!.pivot).toEqual([0, -1, 0]); // swing keeps it
    expect(spec.parts[1].animate!.pivot).toBeUndefined(); // pulse drops it
    expect(spec.parts[1].animate!.amount).toBe(0.3); // ...but keeps amount
    expect(spec.parts[2].animate!.pivot).toBeUndefined(); // slide drops it
  });

  it("clamps out-of-range numbers rather than dropping the part", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [{ shape: "box", position: [99999, -99999, 0], size: [0, 0, 0] }],
    })!;
    expect(spec.parts[0].position[0]).toBe(1000); // upper clamp
    expect(spec.parts[0].position[1]).toBe(-1000); // lower clamp
    expect(spec.parts[0].size[0]).toBeGreaterThan(0); // size floored above 0
  });
});

describe("matchLabels", () => {
  const parts = [mkPart("Gasket"), mkPart("M8 bolt"), mkPart("")];
  it("keeps only labels that name an actual part (case-insensitive, trimmed)", () => {
    expect(matchLabels(parts, ["  gasket ", "UNKNOWN", "M8 BOLT"])).toEqual(["gasket", "M8 BOLT"]);
  });
  it("de-dups case-insensitively, preserving first casing", () => {
    expect(matchLabels(parts, ["Gasket", "GASKET", "gasket"])).toEqual(["Gasket"]);
  });
  it("drops blanks, non-strings, and empty-label parts", () => {
    expect(matchLabels(parts, ["", "   ", "Gasket"])).toEqual(["Gasket"]);
    expect(matchLabels(parts, [42 as unknown as string, "M8 bolt"])).toEqual(["M8 bolt"]);
  });
  it("returns [] for no parts or no labels", () => {
    expect(matchLabels([], ["x"])).toEqual([]);
    expect(matchLabels(parts, [])).toEqual([]);
  });
});

describe("isEmphasized", () => {
  it("matches a part label case-insensitively/trimmed", () => {
    expect(isEmphasized(mkPart("Housing"), ["  housing "])).toBe(true);
    expect(isEmphasized(mkPart("Housing"), ["gasket"])).toBe(false);
  });
  it("is false for empty emphasis or empty label", () => {
    expect(isEmphasized(mkPart("Housing"), [])).toBe(false);
    expect(isEmphasized(mkPart(""), ["x"])).toBe(false);
  });
});

describe("buildLegend", () => {
  it("dedups by colour+label, keeping one entry in order", () => {
    const out = buildLegend([mkPart("Bolt"), mkPart("Bolt"), mkPart("Nut")], []);
    expect(out.map((e) => e.label)).toEqual(["Bolt", "Nut"]);
  });

  it("lists a labelless part with tap-only data under a synthesized name; skips bare ones", () => {
    const out = buildLegend([{ ...mkPart(""), warning: "Hot" }, mkPart("")], []);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Part 1");
    expect(out[0].detail).toBe(true);
  });

  it("on a colour+label collision, points the entry at the instance carrying the warning", () => {
    const plain = mkPart("Valve"); // listed first, no detail
    const withWarn = { ...mkPart("Valve"), warning: "Live — isolate" };
    const out = buildLegend([plain, withWarn], []);
    expect(out).toHaveLength(1);
    expect(out[0].detail).toBe(true);
    expect(out[0].part.warning).toBe("Live — isolate");
  });

  it("prefers a warning part over a spec-only part for the same key", () => {
    const specOnly = { ...mkPart("Pump"), spec: [{ label: "Flow", value: "5 L/min" }] };
    const warn = { ...mkPart("Pump"), warning: "Pressurised" };
    expect(buildLegend([specOnly, warn], [])[0].part.warning).toBe("Pressurised");
  });

  it("flags emphasis and caps at 12", () => {
    expect(buildLegend([mkPart("Gasket")], ["  gasket "])[0].em).toBe(true);
    const many = Array.from({ length: 20 }, (_, i) => mkPart(`P${i}`));
    expect(buildLegend(many, [])).toHaveLength(12);
  });
});

describe("emphasis normalization", () => {
  it("defaults emphasis to [] when absent", () => {
    const spec = normalizeModelSpec({ mode: "3d", title: "x", parts: [{ shape: "box", label: "a" }] })!;
    expect(spec.emphasis).toEqual([]);
  });
  it("re-validates a persisted emphasis against surviving parts", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [{ shape: "box", label: "Housing" }],
      emphasis: ["Housing", "nope", 42],
    })!;
    expect(spec.emphasis).toEqual(["Housing"]); // 'nope' + non-string dropped
  });
  it("ignores a non-array emphasis", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [{ shape: "box", label: "a" }],
      emphasis: "Housing",
    })!;
    expect(spec.emphasis).toEqual([]);
  });
});

describe("step-by-step playback", () => {
  const stepped = normalizeModelSpec({
    mode: "3d",
    title: "Assembly",
    parts: [
      { shape: "box", label: "base" }, // no step -> scaffolding
      { shape: "box", label: "a", step: 1 },
      { shape: "box", label: "b", step: 2.0 }, // float -> 2
      { shape: "box", label: "c", step: 3 },
      { shape: "box", label: "bad", step: 0 }, // 0 -> dropped (undefined)
      { shape: "box", label: "neg", step: -1 }, // negative -> dropped
    ],
    activeStep: 2,
  })!;

  it("parses valid 1-based steps and drops invalid ones", () => {
    const byLabel = Object.fromEntries(stepped.parts.map((p) => [p.label, p.step]));
    expect(byLabel.base).toBeUndefined();
    expect(byLabel.a).toBe(1);
    expect(byLabel.b).toBe(2);
    expect(byLabel.c).toBe(3);
    expect(byLabel.bad).toBeUndefined();
    expect(byLabel.neg).toBeUndefined();
  });

  it("maxStep is the highest part step", () => {
    expect(maxStep(stepped.parts)).toBe(3);
    expect(maxStep([{ shape: "box", position: [0, 0, 0], size: [1, 1, 1], rotation: [0, 0, 0], color: "info", label: "x" }])).toBe(0);
  });

  it("clamps activeStep to [0, maxStep]", () => {
    expect(stepped.activeStep).toBe(2);
    expect(normalizeModelSpec({ mode: "3d", title: "x", parts: [{ shape: "box", step: 1 }], activeStep: 99 })!.activeStep).toBe(1);
    expect(normalizeModelSpec({ mode: "3d", title: "x", parts: [{ shape: "box", step: 1 }], activeStep: -5 })!.activeStep).toBe(0);
    expect(normalizeModelSpec({ mode: "3d", title: "x", parts: [{ shape: "box" }] })!.activeStep).toBe(0);
  });

  it("stepPhase classifies parts relative to the active step", () => {
    const part = (step?: number): ModelPart => ({
      shape: "box", position: [0, 0, 0], size: [1, 1, 1], rotation: [0, 0, 0], color: "info", label: "x", step,
    });
    expect(stepPhase(part(2), 0)).toBe("off"); // playback off -> everything normal
    expect(stepPhase(part(undefined), 2)).toBe("always"); // scaffolding
    expect(stepPhase(part(2), 2)).toBe("current");
    expect(stepPhase(part(1), 2)).toBe("past");
    expect(stepPhase(part(3), 2)).toBe("future");
  });

  it("step + activeStep survive a JSON persistence round-trip", () => {
    const round = normalizeModelSpec(JSON.parse(JSON.stringify(stepped)));
    expect(round).toEqual(stepped);
  });

  it("resolveActiveStep falls back to show-all when the active step has no parts", () => {
    // Steps present: 1,2,3. Selecting a populated step keeps it; an empty/gap
    // step (e.g. a numbering gap) resolves to 0 so the whole diagram stays shown.
    expect(resolveActiveStep(stepped.parts, 2)).toBe(2);
    expect(resolveActiveStep(stepped.parts, 0)).toBe(0);
    const gap = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [{ shape: "box", step: 2 }, { shape: "box", step: 3 }], // no step 1
    })!;
    expect(resolveActiveStep(gap.parts, 1)).toBe(0); // step 1 empty -> show all
    expect(resolveActiveStep(gap.parts, 2)).toBe(2); // populated -> keep
  });
});

describe("camera anchor (AR-pin)", () => {
  it("carries a valid 2d anchor through, clamped", () => {
    const spec = normalizeModelSpec({
      mode: "2d",
      title: "Wiring",
      parts: [{ shape: "rect" }],
      anchor: { box: [100, 200, 400, 600] },
    })!;
    expect(spec.anchor).toEqual({ box: [100, 200, 400, 600] });
    // out-of-range values clamp to [0,1000]
    const clamped = normalizeModelSpec({
      mode: "2d",
      title: "x",
      parts: [{ shape: "rect" }],
      anchor: { box: [-50, 100, 2000, 600] },
    })!;
    expect(clamped.anchor).toEqual({ box: [0, 100, 1000, 600] });
  });

  it("strips the anchor on a 3d spec (never anchored)", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "x",
      parts: [{ shape: "box" }],
      anchor: { box: [100, 200, 400, 600] },
    })!;
    expect(spec.anchor).toBeUndefined();
  });

  it("drops a malformed/inverted/non-finite anchor (degrades to floating card)", () => {
    const mk = (anchor: unknown) =>
      normalizeModelSpec({ mode: "2d", title: "x", parts: [{ shape: "rect" }], anchor })!.anchor;
    expect(mk({ box: [Infinity, 0, 100, 100] })).toBeUndefined();
    expect(mk({ box: [1, 2, 3] })).toBeUndefined(); // wrong length
    expect(mk({ box: "nope" })).toBeUndefined();
    expect(mk({ box: [400, 600, 100, 200] })).toBeUndefined(); // inverted
    expect(mk(null)).toBeUndefined();
    expect(mk(undefined)).toBeUndefined();
  });

  it("a 2d anchored spec round-trips through JSON + re-normalize unchanged", () => {
    const spec = normalizeModelSpec({
      mode: "2d",
      title: "Wiring",
      parts: [{ shape: "rect", label: "K1" }],
      anchor: { box: [120, 240, 480, 720] },
    })!;
    expect(normalizeModelSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });
});

describe("persistence contract", () => {
  it("a normalized spec survives a JSON round-trip + re-normalize unchanged", () => {
    // This is the contract jobHistory + the summary modal rely on.
    const spec = normalizeModelSpec({
      mode: "2d",
      title: "Relay wiring",
      caption: "12V control side",
      parts: [
        { shape: "rect", position: [50, 50], size: [20, 10], color: "info", label: "K1" },
        { shape: "arrow", position: [10, 10], size: [30, 0], color: "danger", label: "coil+" },
      ],
    })!;
    const round = normalizeModelSpec(JSON.parse(JSON.stringify(spec)));
    expect(round).toEqual(spec);
  });

  it("a 3d spec round-trips unchanged too", () => {
    const spec = normalizeModelSpec({
      mode: "3d",
      title: "Bolt order",
      parts: [{ shape: "cylinder", position: [0, 0, 0], size: [1, 2, 1], color: "metal", label: "M8" }],
    })!;
    expect(normalizeModelSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });
});

describe("modelColorHex", () => {
  it("maps known palette colours and falls back to info", () => {
    expect(modelColorHex("danger")).toBe(MODEL_COLOR_HEX.danger);
    expect(modelColorHex("metal")).toBe(MODEL_COLOR_HEX.metal);
    expect(modelColorHex("totally-unknown")).toBe(MODEL_COLOR_HEX.info);
  });
});
