import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { modelColorHex, maxStep, buildLegend, type ModelPart, type ModelSpec } from "../lib/solutionModel";
import Diagram2D from "./Diagram2D";
import { PartDetail } from "./PartDetail";

// The 3D viewer pulls the whole three/r3f/drei stack — load it ONLY when a 3D
// diagram actually arrives, so 2D schematics (and the rest of the app) never pay
// for it. Diagram2D is pure SVG and stays eager.
const ModelViewer3D = lazy(() => import("./ModelViewer3D"));

/** Floating card showing the AI's explanatory diagram. Anchored to the right so
 *  it stays clear of centre annotations and the bottom caption/HUD stack.
 *  Persists until the AI replaces/clears it or the tech closes it. */
export function SolutionPanel({
  spec,
  onClose,
  onStep,
}: {
  spec: ModelSpec;
  onClose: () => void;
  onStep?: (step: number) => void;
}) {
  const steps = maxStep(spec.parts); // >0 when the diagram has step-by-step playback
  const active = spec.activeStep;
  // Legend: distinct (colour,label) entries (de-dup prefers the instance carrying
  // a warning/spec), each an annotated key with its note; a labelless part with
  // tap-only data still gets a synthesized row. Pure + unit-tested.
  const legend = useMemo(() => buildLegend(spec.parts, spec.emphasis), [spec]);

  // The part whose tap-to-view detail popover is open. Cleared when a genuinely
  // NEW diagram arrives (parts array identity changes) — but NOT on an emphasis
  // or step update (same parts array), so highlighting doesn't close the card.
  const [selected, setSelected] = useState<ModelPart | null>(null);
  useEffect(() => setSelected(null), [spec.parts]);

  // Geometry-tap is gated to EXACTLY the parts that earned a legend row, so every
  // tappable part also has a keyboard-reachable legend button (no pointer-only
  // parts beyond the legend's 12-row cap / de-dup).
  const tappable = useMemo(
    () => new Set(legend.filter((l) => l.detail).map((l) => l.part)),
    [legend],
  );

  // Looping part motion (3D). Let the tech freeze it to inspect a pose, and
  // default to paused when the OS asks for reduced motion (accessibility).
  const hasMotion = useMemo(() => spec.parts.some((p) => p.animate), [spec]);
  const [motionPaused, setMotionPaused] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  // Track the OS reduced-motion preference at RUNTIME, not just at mount: this
  // panel is long-lived (the spec is replaced in place), so a user enabling
  // "Reduce motion" mid-session must still take effect. The OS request wins.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => setMotionPaused(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="solution-panel" role="dialog" aria-label={`Diagram: ${spec.title}`}>
      <div className="solution-panel__bar">
        <span className="solution-panel__badge">{spec.mode.toUpperCase()}</span>
        <span className="solution-panel__title" title={spec.title}>{spec.title}</span>
        <button className="solution-panel__close" onClick={onClose} aria-label="Close diagram">×</button>
      </div>

      <div className="solution-panel__stage">
        {spec.mode === "3d" ? (
          <Suspense fallback={<div className="solution-panel__loading">Loading 3D…</div>}>
            <ModelViewer3D spec={spec} paused={motionPaused} onSelect={setSelected} selectable={tappable} />
          </Suspense>
        ) : (
          <Diagram2D spec={spec} paused={motionPaused} onSelect={setSelected} selectable={tappable} />
        )}
      </div>

      {hasMotion ? (
        <div className="solution-panel__motion">
          <button
            className="solution-panel__motion-btn"
            type="button"
            onClick={() => setMotionPaused((p) => !p)}
            aria-pressed={!motionPaused}
            aria-label="Animate motion"
          >
            {/* aria-hidden: the glyph + label are decorative; aria-pressed +
                the stable aria-label carry the state to a screen reader. */}
            <span aria-hidden="true">{motionPaused ? "▶ Play motion" : "⏸ Pause motion"}</span>
          </button>
        </div>
      ) : null}

      {steps > 0 && onStep ? (
        <div className="solution-panel__playback">
          <button
            className="solution-panel__step-btn"
            onClick={() => onStep(Math.max(0, active - 1))}
            disabled={active <= 0}
            aria-label="Previous step"
          >
            ◀
          </button>
          <span className="solution-panel__step-label">
            {active === 0 ? "All steps" : `Step ${active} / ${steps}`}
          </span>
          <button
            className="solution-panel__step-btn"
            onClick={() => onStep(Math.min(steps, active + 1))}
            disabled={active >= steps}
            aria-label="Next step"
          >
            ▶
          </button>
        </div>
      ) : null}

      {spec.caption ? <div className="solution-panel__caption">{spec.caption}</div> : null}

      {legend.length > 0 ? (
        <ul className="solution-panel__legend">
          {legend.map((l, i) => {
            const body = (
              <>
                <span className="solution-panel__swatch" style={{ background: modelColorHex(l.color) }} />
                <span className="solution-panel__legend-text">
                  <span className="solution-panel__legend-name">{l.label}</span>
                  {l.note ? <span className="solution-panel__legend-note">{l.note}</span> : null}
                </span>
                {l.detail ? (
                  <span className="solution-panel__legend-badge" aria-hidden="true">
                    {l.part.warning ? "⚠" : "ⓘ"}
                  </span>
                ) : null}
              </>
            );
            // Parts with tap-only data (spec / warning) become buttons that open
            // the detail popover; the rest stay plain list items.
            return (
              <li key={i} className={l.em ? "is-emphasized" : undefined}>
                {l.detail ? (
                  <button
                    type="button"
                    className="solution-panel__legend-btn"
                    onClick={() => setSelected(l.part)}
                    aria-label={`Show details for ${l.label}${l.part.warning ? " (has safety warning)" : ""}`}
                  >
                    {body}
                  </button>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {selected ? <PartDetail part={selected} onClose={() => setSelected(null)} /> : null}

      {spec.mode === "3d" ? <div className="solution-panel__hint">Drag to rotate · scroll to zoom</div> : null}
    </div>
  );
}
