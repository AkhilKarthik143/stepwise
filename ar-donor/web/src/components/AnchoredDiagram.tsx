import { useCoverGeometry } from "../lib/useCoverGeometry";
import { anchorBoxToRect } from "../lib/anchorMap";
import type { ModelSpec } from "../lib/solutionModel";
import Diagram2D from "./Diagram2D";
import { SolutionPanel } from "./SolutionPanel";

/**
 * A 2D diagram PINNED over the live camera at the region the AI chose, instead
 * of the floating card — so a wiring/flow schematic sits over the equipment it
 * explains. Screen-space (reuses the annotation cover-mapping); like the 2D
 * annotations it goes stale when the camera moves and re-pins on the next
 * show_model. 3D specs are never anchored (they stay in the lazy floating card).
 *
 * If the anchor maps entirely off-screen (e.g. edge-of-frame equipment cropped
 * away on a portrait phone), there's no honest place to pin it, so we fall back
 * to the floating SolutionPanel rather than gluing it to a misleading edge.
 */
export function AnchoredDiagram({
  spec,
  onClose,
  onStep,
}: {
  spec: ModelSpec;
  onClose: () => void;
  onStep?: (step: number) => void;
}) {
  const geo = useCoverGeometry("camera-bg");
  // The pinned overlay has no room for a motion toggle, so it just honours the
  // OS reduced-motion preference (read per-render; the overlay is short-lived
  // and re-pins on each show_model).
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const r = spec.anchor ? anchorBoxToRect(spec.anchor.box, geo.cw, geo.ch, geo.iw, geo.ih) : null;
  // No anchor, or the anchor is fully cropped off-screen -> floating card.
  if (!r) return <SolutionPanel spec={spec} onClose={onClose} onStep={onStep} />;
  // The pinned overlay has no legend (the tap-to-view detail lives in the
  // floating card). Safety WARNINGS must never be silently dropped, so surface
  // them inline here; the rest of the spec stays in the floating panel.
  const warnings = Array.from(
    new Set(spec.parts.map((p) => p.warning).filter((w): w is string => !!w)),
  ).slice(0, 3);
  return (
    <div
      className="anchored-diagram"
      style={{
        left: `${r.left}%`,
        top: `${r.top}%`,
        width: `${r.width}%`,
        height: `${r.height}%`,
      }}
      role="img"
      aria-label={`Diagram pinned over the equipment: ${spec.title}`}
    >
      <div className="anchored-diagram__title" title={spec.title}>
        {spec.title}
      </div>
      <div className="anchored-diagram__stage">
        <Diagram2D spec={spec} paused={reducedMotion} />
      </div>
      {warnings.length > 0 ? (
        <div className="anchored-diagram__warnings" role="alert">
          {warnings.map((w, i) => (
            <div key={i} className="anchored-diagram__warning">
              <span aria-hidden="true">⚠ </span>
              {w}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
