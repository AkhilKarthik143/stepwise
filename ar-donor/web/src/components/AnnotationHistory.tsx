import { useState } from "react";
import type { Annotation } from "../lib/useWebRTC";

/**
 * Tap-to-recall rail of every component the AI has marked this session.
 *
 * Live marks expire after ~8s — a technician with both hands inside a machine
 * can't stare at the screen waiting. Every mark lands here (deduped by label,
 * latest first) and ONE TAP re-draws it for another full TTL: "M8 head bolt —
 * 25 N·m" is back instantly, offline, without costing a model turn to re-ask.
 */
export function AnnotationHistory({
  history,
  onRecall,
}: {
  history: Annotation[];
  onRecall: (label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;

  return (
    <div className="ann-history">
      {open && (
        <div className="ann-history-list">
          {history.map((a) => (
            <button
              key={a.label}
              className="ann-history-item"
              onClick={() => onRecall(a.label)}
              title="Tap to show this mark again"
            >
              <span className={`ann-history-dot lvl-${a.level}`} />
              {a.step != null && <span className="ann-history-step">{a.step}</span>}
              <span className="ann-history-label">{a.label}</span>
              {a.detail && <span className="ann-history-detail">{a.detail}</span>}
            </button>
          ))}
        </div>
      )}
      <button className="ann-history-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide marks" : `Marks (${history.length})`}
      </button>
    </div>
  );
}
