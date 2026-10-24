import type { AnnotationLevel } from "./useWebRTC";

/**
 * Procedure checklist reducer — pure, unit-tested.
 *
 * The AI's numbered annotations build a progress list. Done-states are
 * HEURISTIC (progress tracking, not a safety interlock):
 *   - step N arriving marks all earlier steps done;
 *   - the AI clearing a step's labelled mark marks that step done;
 *   - a no-label clear-all is screen decluttering — it never completes steps;
 *   - a fresh step 1 starts a NEW procedure only when every existing step is
 *     done AND the step-1 label changed (a re-show must never wipe progress);
 *   - re-annotating a done step with the same label preserves its done state.
 */
export interface ProcedureStep {
  step: number;
  label: string;
  detail: string;
  level: AnnotationLevel;
  done: boolean;
}

export const MAX_PROCEDURE_STEPS = 40;

export interface ProcedureAnnotation {
  step: number;
  label: string;
  detail: string;
  level: AnnotationLevel;
}

export function applyProcedureAnnotation(
  steps: ProcedureStep[],
  a: ProcedureAnnotation
): ProcedureStep[] {
  const prevMax = steps.reduce((m, s) => Math.max(m, s.step), 0);
  const existing1 = steps.find((s) => s.step === 1);
  const existingSame = steps.find((s) => s.step === a.step);
  let base = steps;
  if (
    a.step === 1 &&
    prevMax > 1 &&
    existing1?.done &&
    steps.every((s) => s.done) &&
    existing1.label !== a.label
  ) {
    base = []; // new procedure begins
  }
  const entry: ProcedureStep = {
    step: a.step,
    label: a.label,
    detail: a.detail,
    level: a.level,
    done: existingSame?.label === a.label ? existingSame.done : false,
  };
  const next = [...base.filter((s) => s.step !== a.step), entry].map((s) =>
    s.step < a.step ? { ...s, done: true } : s
  );
  next.sort((x, y) => x.step - y.step);
  return next.slice(-MAX_PROCEDURE_STEPS);
}

export function applyProcedureClear(
  steps: ProcedureStep[],
  label: string | null
): ProcedureStep[] {
  if (!label) return steps; // clear-all = decluttering, not completion
  return steps.map((s) => (s.label === label ? { ...s, done: true } : s));
}
