import { useEffect, useRef } from "react";
import {
  modelColorHex,
  isEmphasized,
  stepPhase,
  resolveActiveStep,
  type ModelPart,
  type ModelSpec,
} from "../lib/solutionModel";
import { diagram2DBounds, motionTransform2D } from "../lib/solutionGeometry";

// Pure SVG — no three/r3f imports, so this is safe to load eagerly. The AI
// composes a flat schematic (wiring, circuit, flow) in a screen-like coordinate
// space; `position` is the part centre, `size` its extent (line/arrow read size
// as a delta to the end point).

function Shape({
  part,
  emphasized,
  dimmed,
  interactive = false,
}: {
  part: ModelPart;
  emphasized: boolean;
  dimmed: boolean;
  /** When tappable, line-family shapes (no fill area) get a transparent wide
   *  hit-stroke so they aren't a hairline tap target. */
  interactive?: boolean;
}) {
  const [x, y] = part.position;
  const [w, h] = part.size;
  const rot = part.rotation[0] || 0;
  const hex = modelColorHex(part.color);
  const xform = rot ? `rotate(${rot} ${x} ${y})` : undefined;
  const label = part.label;
  // Emphasis (highlight / current playback step) thickens the stroke, bolds the
  // label, and adds a glow; a future playback step is faded — purely
  // presentational, no coordinate/viewBox change.
  const sw = emphasized ? 2.6 : 1.4;
  const glow = emphasized ? "url(#emph-glow)" : undefined;
  const fw = emphasized ? "bold" : undefined;
  const op = dimmed ? 0.22 : undefined;
  // Dashed = hidden / internal / reference geometry (vs a solid visible edge).
  const dash = part.dashed ? "3 2" : undefined;
  // Transparent wide hit-stroke for a tappable line-family shape (no fill area,
  // so pointer-events:all alone would leave only a hairline target).
  const hit = interactive ? (
    <line x1={x} y1={y} x2={x + w} y2={y + h} stroke="transparent" strokeWidth={8} strokeLinecap="round" />
  ) : null;

  switch (part.shape) {
    case "circle": {
      const r = Math.max(0.5, Math.abs(w) / 2);
      return (
        <g transform={xform} filter={glow} opacity={op}>
          <circle cx={x} cy={y} r={r} fill="none" stroke={hex} strokeWidth={sw} strokeDasharray={dash} />
          {label ? <text x={x} y={y + r + 5} fill={hex} fontSize={5} fontWeight={fw} textAnchor="middle">{label}</text> : null}
        </g>
      );
    }
    case "line":
      return (
        <g transform={xform} filter={glow} opacity={op}>
          {hit}
          <line x1={x} y1={y} x2={x + w} y2={y + h} stroke={hex} strokeWidth={sw} strokeLinecap="round" strokeDasharray={dash} />
          {label ? <text x={(x + x + w) / 2} y={(y + y + h) / 2 - 2} fill={hex} fontSize={5} fontWeight={fw} textAnchor="middle">{label}</text> : null}
        </g>
      );
    case "arrow":
      return (
        <g transform={xform} filter={glow} opacity={op}>
          {hit}
          <line x1={x} y1={y} x2={x + w} y2={y + h} stroke={hex} strokeWidth={sw} strokeLinecap="round" strokeDasharray={dash} markerEnd={`url(#arrowhead-${part.color})`} />
          {label ? <text x={(x + x + w) / 2} y={(y + y + h) / 2 - 2} fill={hex} fontSize={5} fontWeight={fw} textAnchor="middle">{label}</text> : null}
        </g>
      );
    case "dimension": {
      // Engineering-style measurement call-out: a span with oblique end ticks
      // and the value reading ALONG the line, nudged to its perpendicular side —
      // so the measurement (the whole point of this shape) is never struck
      // through by the line, at ANY orientation. Reuses position -> position+size
      // (like line/arrow), so auto-framing already bounds it.
      const x2 = x + w;
      const y2 = y + h;
      const len = Math.hypot(w, h) || 1;
      const ux = -h / len; // unit perpendicular to the span
      const uy = w / len;
      const tick = 2.4; // tick half-length
      // Label anchor: midpoint, nudged off the line (above, for a horizontal dim).
      const lx = (x + x2) / 2 - ux * 2.6;
      const ly = (y + y2) / 2 - uy * 2.6;
      let ang = (Math.atan2(h, w) * 180) / Math.PI;
      if (ang > 90 || ang < -90) ang += 180; // keep the value upright
      return (
        <g transform={xform} filter={glow} opacity={op}>
          {hit}
          <line x1={x - ux * tick} y1={y - uy * tick} x2={x + ux * tick} y2={y + uy * tick} stroke={hex} strokeWidth={sw} strokeLinecap="round" />
          <line x1={x2 - ux * tick} y1={y2 - uy * tick} x2={x2 + ux * tick} y2={y2 + uy * tick} stroke={hex} strokeWidth={sw} strokeLinecap="round" />
          <line x1={x} y1={y} x2={x2} y2={y2} stroke={hex} strokeWidth={sw} strokeLinecap="round" strokeDasharray={dash} />
          {label ? (
            <text
              x={lx}
              y={ly}
              fill={hex}
              fontSize={5}
              fontWeight={fw}
              textAnchor="middle"
              transform={`rotate(${ang} ${lx} ${ly})`}
            >
              {label}
            </text>
          ) : null}
        </g>
      );
    }
    case "text":
      return (
        <g transform={xform} filter={glow} opacity={op}>
          <text x={x} y={y} fill={hex} fontSize={6} fontWeight="bold">{label || "•"}</text>
        </g>
      );
    case "rect":
    default: {
      const rw = Math.max(1, Math.abs(w));
      const rh = Math.max(1, Math.abs(h));
      return (
        <g transform={xform} filter={glow} opacity={op}>
          <rect x={x - rw / 2} y={y - rh / 2} width={rw} height={rh} rx={1.5} fill="none" stroke={hex} strokeWidth={sw} strokeDasharray={dash} />
          {label ? <text x={x} y={y + 1.8} fill={hex} fontSize={5} fontWeight={fw} textAnchor="middle">{label}</text> : null}
        </g>
      );
    }
  }
}

/** Auto-framed flat schematic. `paused` freezes any looping part motion (the
 *  panel's toggle / prefers-reduced-motion; saved-job views pass it true).
 *  `onSelect`, when given, makes parts that carry tap-only data (spec / warning)
 *  clickable — opening the detail popover (omitted for the pinned overlay, which
 *  has no popover and surfaces warnings inline instead). */
export default function Diagram2D({
  spec,
  paused = false,
  onSelect,
  selectable,
}: {
  spec: ModelSpec;
  paused?: boolean;
  onSelect?: (part: ModelPart) => void;
  /** Parts that are tap targets (the legend set, so each also has a keyboard
   *  path). When omitted, falls back to "has spec/warning". */
  selectable?: ReadonlySet<ModelPart>;
}) {
  const b = diagram2DBounds(spec.parts);
  const pad = 8;
  const vbW = Math.max(10, b.maxX - b.minX) + pad * 2;
  const vbH = Math.max(10, b.maxY - b.minY) + pad * 2;
  const colors = Array.from(new Set(spec.parts.map((p) => p.color)));

  // Looping motion: one rAF loop sets the wrapper <g> transform of every
  // animated part each frame from the pure motionTransform2D(). Paused (or no
  // animated part) holds the rest pose (t=0) and runs no loop. Mirrors the 3D
  // viewer's behaviour; the transform math is unit-tested in solutionGeometry.
  const gRefs = useRef<(SVGGElement | null)[]>([]);
  // Key the loop on the stable `parts` array, NOT the whole `spec`: an emphasis
  // or playback-step change spreads a NEW spec object but keeps the SAME parts
  // reference, so depending on `spec` here would tear down the loop and snap the
  // motion back to t=0 on every highlight/step. `parts` only changes when a
  // genuinely new diagram arrives — which SHOULD restart the clock. (The 3D
  // viewer is immune already: it reads r3f's continuous clock.)
  const parts = spec.parts;
  const hasMotion = parts.some((p) => p.animate);
  useEffect(() => {
    const apply = (t: number) => {
      for (let i = 0; i < parts.length; i++) {
        const el = gRefs.current[i];
        if (el && parts[i].animate) el.setAttribute("transform", motionTransform2D(parts[i], t));
      }
    };
    if (paused || !hasMotion) {
      apply(0); // rest pose
      return;
    }
    let raf = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      apply((now - start) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [parts, paused, hasMotion]);

  return (
    <svg
      viewBox={`${b.minX - pad} ${b.minY - pad} ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "100%" }}
      role="img"
      aria-label={spec.title}
    >
      <defs>
        {colors.map((c) => (
          <marker key={c} id={`arrowhead-${c}`} markerWidth={6} markerHeight={6} refX={5} refY={3} orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L6,3 L0,6 Z" fill={modelColorHex(c)} />
          </marker>
        ))}
        {/* Soft glow for emphasized (highlighted) parts. */}
        <filter id="emph-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={1.6} result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {spec.parts.map((part, i) => {
        const phase = stepPhase(part, resolveActiveStep(spec.parts, spec.activeStep));
        const emphasized = isEmphasized(part, spec.emphasis) || phase === "current";
        // A part is a tap target when the parent says so (the legend set, so it
        // also has a keyboard-reachable legend row); fall back to has-detail when
        // no set is supplied. pointer-events:all (inherited by the shape) makes the
        // whole fill region a hit target for rect/circle/text; line-family shapes
        // (no fill) get a transparent wide hit-stroke from Shape instead.
        const interactive =
          !!onSelect && (selectable ? selectable.has(part) : !!(part.spec?.length || part.warning));
        const shape = (
          <Shape
            part={part}
            emphasized={emphasized}
            dimmed={phase === "future" && !emphasized}
            interactive={interactive}
          />
        );
        const onClick = interactive ? () => onSelect!(part) : undefined;
        const style = interactive
          ? ({ cursor: "pointer", pointerEvents: "all" } as const)
          : undefined;
        // Animated parts are wrapped in a motion <g> (its transform is driven by
        // the rAF loop above, composing OUTSIDE the part's static-rotation <g>).
        return part.animate ? (
          <g
            key={i}
            ref={(el) => {
              gRefs.current[i] = el;
            }}
            transform={motionTransform2D(part, 0)}
            onClick={onClick}
            style={style}
          >
            {shape}
          </g>
        ) : (
          <g key={i} onClick={onClick} style={style}>
            {shape}
          </g>
        );
      })}
    </svg>
  );
}
