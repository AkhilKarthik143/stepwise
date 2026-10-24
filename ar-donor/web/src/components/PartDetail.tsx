import { useEffect, useRef } from "react";
import { modelColorHex, type ModelPart } from "../lib/solutionModel";

/**
 * Tap-to-view detail card for ONE diagram part: its name, the explanatory note,
 * any safety warning (prominent), and the spec sheet (torque / size / part # /
 * …). Dismissible. Rendered as an overlay inside the solution panel when the
 * technician taps a part's legend entry.
 */
export function PartDetail({ part, onClose }: { part: ModelPart; onClose: () => void }) {
  const rows = part.spec ?? [];
  // Standard dialog contract: take focus on open, and Escape closes. (A full
  // focus trap is deferred with the geometry-tap increment.)
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // preventScroll: opening the card must not yank a scrolling container (the
    // saved-job modal body) to bring the focused card into view.
    rootRef.current?.focus({ preventScroll: true });
  }, [part]);
  return (
    <div
      ref={rootRef}
      className="part-detail"
      role="dialog"
      aria-label={`Details: ${part.label || "part"}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="part-detail__head">
        <span className="part-detail__swatch" style={{ background: modelColorHex(part.color) }} />
        <span className="part-detail__name">{part.label || "Part"}</span>
        <button className="part-detail__close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>
      {part.note ? <div className="part-detail__note">{part.note}</div> : null}
      {part.warning ? (
        <div className="part-detail__warning" role="alert">
          <span aria-hidden="true">⚠ </span>
          {part.warning}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <dl className="part-detail__spec">
          {rows.map((row, i) => (
            <div key={i} className="part-detail__row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {!part.note && !part.warning && rows.length === 0 ? (
        <div className="part-detail__empty">No extra details for this part.</div>
      ) : null}
    </div>
  );
}
