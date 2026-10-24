import { useState } from "react";
import type { ProcedureStep } from "../lib/useWebRTC";

/**
 * Glanceable procedure progress — the AI's numbered steps as a checklist.
 *
 * Answers "where was I?" after any interruption without scroll-reading the
 * transcript. Done-states are heuristic (inferred from later-step arrival and
 * the AI clearing marks) — progress tracking, NOT a safety interlock, and the
 * UI says so.
 */
export function ProcedureTracker({ steps }: { steps: ProcedureStep[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;

  const total = steps.length;
  // Denominator = highest known step NUMBER (the list may have gaps — "Step 5
  // of 3" would be nonsense when only steps 2/4/5 were ever annotated).
  const maxStep = steps[steps.length - 1]?.step ?? total;
  const doneCount = steps.filter((s) => s.done).length;
  const current = steps.find((s) => !s.done);

  return (
    <div className="procedure">
      {open && (
        <div className="procedure-list">
          <div className="procedure-caveat">auto-tracked progress — confirm with the AI</div>
          {steps.map((s) => (
            <div key={s.step} className={`procedure-step${s.done ? " done" : ""}`}>
              <span className={`procedure-dot lvl-${s.level}`}>{s.done ? "✓" : s.step}</span>
              <span className="procedure-label">
                {s.label}
                {s.detail ? <span className="procedure-detail"> — {s.detail}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
      <button className="procedure-toggle" onClick={() => setOpen((o) => !o)}>
        {current ? `Step ${current.step} of ${maxStep}` : `Done (${doneCount}/${total})`}
      </button>
    </div>
  );
}
