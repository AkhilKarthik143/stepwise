import { describe, expect, it } from "vitest";
import {
  applyProcedureAnnotation,
  applyProcedureClear,
  MAX_PROCEDURE_STEPS,
  type ProcedureStep,
} from "./procedure";

const ann = (step: number, label: string, detail = "", level = "info" as const) => ({
  step,
  label,
  detail,
  level,
});

const run = (inputs: Parameters<typeof applyProcedureAnnotation>[1][]) =>
  inputs.reduce<ProcedureStep[]>((acc, a) => applyProcedureAnnotation(acc, a), []);

describe("applyProcedureAnnotation", () => {
  it("builds an ordered list and marks earlier steps done when later ones arrive", () => {
    const steps = run([ann(1, "drain plug"), ann(2, "filter"), ann(3, "gasket")]);
    expect(steps.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(steps.map((s) => s.done)).toEqual([true, true, false]);
  });

  it("handles out-of-order arrival (3, 1, 2) without nonsense", () => {
    const steps = run([ann(3, "gasket"), ann(1, "drain plug"), ann(2, "filter")]);
    expect(steps.map((s) => s.step)).toEqual([1, 2, 3]);
    // step 2 arriving last marks step 1 done; step 3 stays pending.
    expect(steps.find((s) => s.step === 1)?.done).toBe(true);
    expect(steps.find((s) => s.step === 3)?.done).toBe(false);
  });

  it("re-annotating a done step with the SAME label preserves its done state", () => {
    const steps = run([ann(1, "drain plug"), ann(2, "filter"), ann(1, "drain plug")]);
    expect(steps.find((s) => s.step === 1)?.done).toBe(true); // re-show, not regression
    expect(steps).toHaveLength(2);
  });

  it("re-annotating with a DIFFERENT label resets that step to pending", () => {
    const steps = run([ann(1, "drain plug"), ann(2, "filter"), ann(2, "oil filter")]);
    expect(steps.find((s) => s.step === 2)?.label).toBe("oil filter");
    expect(steps.find((s) => s.step === 2)?.done).toBe(false);
  });

  it("starts a NEW procedure only when all steps are done AND step-1 label changes", () => {
    let steps = run([ann(1, "drain plug"), ann(2, "filter")]);
    steps = applyProcedureClear(steps, "filter"); // everything now done
    expect(steps.every((s) => s.done)).toBe(true);
    // Same label -> re-show, list intact.
    const reshown = applyProcedureAnnotation(steps, ann(1, "drain plug"));
    expect(reshown).toHaveLength(2);
    // Different label -> new procedure.
    const fresh = applyProcedureAnnotation(steps, ann(1, "belt tensioner"));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ step: 1, label: "belt tensioner", done: false });
  });

  it("does NOT reset while earlier procedure still has pending steps", () => {
    const steps = run([ann(1, "drain plug"), ann(2, "filter"), ann(3, "gasket")]);
    // step 3 pending -> a step-1 re-annotation (any label) must not wipe.
    const next = applyProcedureAnnotation(steps, ann(1, "different label"));
    expect(next).toHaveLength(3);
  });

  it("caps the list", () => {
    const inputs = Array.from({ length: MAX_PROCEDURE_STEPS + 10 }, (_, i) =>
      ann(i + 1, `step ${i + 1}`)
    );
    const steps = run(inputs);
    expect(steps).toHaveLength(MAX_PROCEDURE_STEPS);
    expect(steps[steps.length - 1].step).toBe(MAX_PROCEDURE_STEPS + 10); // newest kept
  });
});

describe("applyProcedureClear", () => {
  it("a labelled clear completes exactly that step", () => {
    const steps = run([ann(1, "drain plug"), ann(2, "filter")]);
    const next = applyProcedureClear(steps, "filter");
    expect(next.find((s) => s.step === 2)?.done).toBe(true);
  });

  it("a no-label clear-all NEVER completes the checklist (decluttering)", () => {
    const steps = run([ann(1, "drain plug"), ann(2, "filter")]);
    const next = applyProcedureClear(steps, null);
    expect(next.find((s) => s.step === 2)?.done).toBe(false);
  });
});
