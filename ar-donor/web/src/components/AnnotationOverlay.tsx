import { useEffect, useState, type CSSProperties } from "react";
import type { Annotation } from "../lib/useWebRTC";
import { coverMap } from "../lib/coverMap";
import { useCoverGeometry } from "../lib/useCoverGeometry";

/**
 * Premium screen-space component highlights driven by Gemini's annotate tools.
 *
 * Accuracy: Gemini's box is normalized 0-1000 over the IMAGE it was sent (the
 * downscaled camera JPEG). The camera <video> is shown full-screen with
 * `object-fit: cover`, which scales-to-fill and centre-crops. We map the box
 * through that SAME cover transform so a highlight lands on the real pixels even
 * when the viewport aspect ratio differs from the camera's — otherwise every box
 * is shifted/scaled by the crop amount.
 *
 * Features: three shapes (box / point pin / pointer arrow), severity colours
 * (info green · warn amber · danger red), an optional numbered step badge, a
 * precise centre crosshair, a label chip that's clamped on-screen, and a
 * freshness fade so the newest guidance reads strongest.
 */
const TTL_MS = 8000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// coverMap lives in ../lib/coverMap (pure + unit-tested); useCoverGeometry in
// ../lib/useCoverGeometry (shared with the anchored diagram overlay).

export function AnnotationOverlay({ annotations }: { annotations: Annotation[] }) {
  const geo = useCoverGeometry("camera-bg");
  // Light tick so the freshness fade advances smoothly between annotate events.
  // Only runs while highlights exist — no idle timer / tab wakeup when there's
  // nothing to fade.
  const [, tick] = useState(0);
  const hasAnnotations = annotations.length > 0;
  useEffect(() => {
    if (!hasAnnotations) return;
    const iv = window.setInterval(() => tick((n) => (n + 1) % 1_000_000), 600);
    return () => window.clearInterval(iv);
  }, [hasAnnotations]);

  const now = Date.now();
  return (
    <div className="annotations" aria-hidden="true">
      {annotations.map((a) => {
        const [ymin, xmin, ymax, xmax] = a.box;
        const tl = coverMap(xmin / 1000, ymin / 1000, geo.cw, geo.ch, geo.iw, geo.ih);
        const br = coverMap(xmax / 1000, ymax / 1000, geo.cw, geo.ch, geo.iw, geo.ih);
        const left = Math.min(tl.x, br.x);
        const top = Math.min(tl.y, br.y);
        const w = Math.abs(br.x - tl.x);
        const h = Math.abs(br.y - tl.y);
        const cx = clamp((tl.x + br.x) / 2, 0, 100);
        const cy = clamp((tl.y + br.y) / 2, 0, 100);

        // Freshness: full strength when new, easing to 0.5 by the TTL — then a
        // graceful fade to 0 over the final 700ms before expiry, so the prune
        // (which deletes the element) lands on an already-invisible marker
        // instead of popping it out mid-strength. The 0.6s CSS opacity
        // transition smooths between the 600ms ticks.
        const freshness = clamp(1 - ((now - a.createdAt) / TTL_MS) * 0.5, 0.5, 1);
        const remaining = a.expiresAt - now;
        const exitFade = clamp(remaining / 700, 0, 1);
        const wrapStyle: CSSProperties = { opacity: freshness * exitFade };

        // Label chip: above the marker, flipped below if near the top edge, and
        // clamped horizontally so the chip stays fully on-screen. The chip is
        // centre-anchored (translateX(-50%)), so the clamp must account for its
        // HALF-WIDTH: we estimate rendered width from the text length (~7px/char
        // + padding + badges) capped at the CSS max-width min(72vw, 420px) —
        // kept in sync with .ann-chip in styles.css. Short labels stay precisely
        // over their target; long ones pull inward just enough to fit.
        const placeBelow = top < 12;
        // Glyph-aware width estimate: ~8.5px/char for Latin at 700-weight 0.8rem,
        // ~13px for CJK/fullwidth glyphs (codepoints >= U+2E80). Underestimating
        // here would under-clamp and let long chips clip off-screen.
        const chipText = a.label + (a.detail ? "  " + a.detail : "");
        let estWidthPx = 28 + (a.step != null ? 26 : 0) + (a.level !== "info" ? 24 : 0);
        if (a.recalled) estWidthPx += 64; // "recalled" badge
        for (const ch of chipText) {
          estWidthPx += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 13 : 8.5;
        }
        const vw = geo.cw || window.innerWidth || 1000;
        estWidthPx = Math.min(estWidthPx, 0.72 * vw, 420);
        const halfVw = (estWidthPx / 2 / vw) * 100;
        const chipX = clamp(cx, halfVw + 1, 99 - halfVw);
        const chipY = clamp(placeBelow ? Math.min(top + h, 96) : top, 7, 93);
        const chip = (
          <div
            className="ann-chip"
            style={{
              left: `${chipX}%`,
              top: `${chipY}%`,
              transform: `translate(-50%, ${placeBelow ? "10px" : "calc(-100% - 10px)"})`,
            }}
          >
            {a.step != null ? <span className="ann-step">{a.step}</span> : null}
            {/* Severity is never colour-only: warn/danger carry a glyph too,
                so the ~8% of male technicians with CVD still read the level. */}
            {a.level === "danger" ? (
              <span className="ann-glyph ann-glyph--danger">▲</span>
            ) : a.level === "warn" ? (
              <span className="ann-glyph ann-glyph--warn">!</span>
            ) : null}
            <span className="ann-label">{a.label}</span>
            {a.detail ? <span className="ann-detail">{a.detail}</span> : null}
            {a.recalled ? <span className="ann-recalled-badge">recalled</span> : null}
          </div>
        );

        const cls = `annotation lvl-${a.level} shape-${a.shape}${a.recalled ? " recalled" : ""}`;

        if (a.shape === "box") {
          return (
            <div key={a.id} className={cls} style={wrapStyle}>
              <div
                className="ann-rect"
                style={{ left: `${left}%`, top: `${top}%`, width: `${w}%`, height: `${h}%` }}
              >
                <span className="ann-cross" />
              </div>
              {chip}
            </div>
          );
        }
        // point (pin) + arrow (pointer chevron) both target the box centre.
        return (
          <div key={a.id} className={cls} style={wrapStyle}>
            <div className="ann-center" style={{ left: `${cx}%`, top: `${cy}%` }}>
              {a.shape === "arrow" ? <span className="ann-chevron" /> : <span className="ann-pin" />}
            </div>
            {chip}
          </div>
        );
      })}
    </div>
  );
}
