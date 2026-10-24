import { useEffect, useState } from "react";
import type { SessionSummary } from "../lib/useWebRTC";
import { modelColorHex, buildLegend, type ModelPart } from "../lib/solutionModel";
import Diagram2D from "./Diagram2D";
import { PartDetail } from "./PartDetail";

/**
 * End-of-session summary: the job's record (everything said + every mark) with
 * one-tap copy and a .txt download — shown when the technician taps End, so
 * finishing a session no longer destroys its hard-won facts (torque specs,
 * part numbers, completed steps).
 */
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

function toText(s: SessionSummary): string {
  const lines: string[] = [
    `AR Technician Assistant — session record`,
    `${new Date(s.startedAt).toLocaleString()} · duration ${fmtDuration(s.endedAt - s.startedAt)}`,
    ``,
    `— Conversation —`,
  ];
  for (const t of s.transcript) {
    lines.push(`[${fmtTime(t.at)}] ${t.role === "user" ? "You" : "AI"}: ${t.text}`);
    if (Array.isArray(t.sources) && t.sources.length) {
      lines.push(`    Sources: ${t.sources.join(", ")}`);
    }
  }
  if (s.marks.length) {
    lines.push(``, `— Marked components —`);
    for (const m of s.marks) {
      const step = m.step != null ? `step ${m.step} · ` : "";
      const detail = m.detail ? ` — ${m.detail}` : "";
      lines.push(`• ${step}${m.label}${detail} [${m.level}]`);
    }
  }
  if (s.model) {
    lines.push(``, `— Diagram (${s.model.mode.toUpperCase()}) —`, s.model.title);
    if (s.model.caption) lines.push(s.model.caption);
    for (const p of s.model.parts) {
      const label = p.label || "(unlabelled)";
      const note = p.note ? ` — ${p.note}` : "";
      lines.push(`• ${label} (${p.shape}, ${p.color})${note}`);
      if (p.warning) lines.push(`    ⚠ ${p.warning}`);
      for (const row of p.spec ?? []) lines.push(`    ${row.label}: ${row.value}`);
    }
  }
  return lines.join("\n");
}

export function SessionSummaryModal({
  summary,
  onClose,
}: {
  summary: SessionSummary;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // Tap-to-view part detail in the saved-job diagram, same as the live panel
  // (reuses the shared buildLegend + PartDetail). Cleared when a different job
  // is opened. Geometry-tap is gated to the legend set for keyboard parity.
  const [selected, setSelected] = useState<ModelPart | null>(null);
  useEffect(() => setSelected(null), [summary]);
  const legend = summary.model ? buildLegend(summary.model.parts, summary.model.emphasis) : [];
  const tappable = new Set(legend.filter((l) => l.detail).map((l) => l.part));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toText(summary));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (http / permissions) — download still works */
    }
  };

  const download = () => {
    const blob = new Blob([toText(summary)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date(summary.startedAt);
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
      d.getDate()
    ).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(
      2,
      "0"
    )}`;
    a.href = url;
    a.download = `session-${stamp}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <div className="summary-backdrop" role="dialog" aria-label="Session summary">
      <div className="summary-card">
        <header className="summary-head">
          <strong>Session complete</strong>
          <span className="summary-meta">
            {fmtDuration(summary.endedAt - summary.startedAt)} ·{" "}
            {summary.transcript.length} turns · {summary.marks.length} marks
            {summary.model ? " · diagram" : ""}
          </span>
        </header>

        <div className="summary-body">
          {summary.transcript.map((t) => (
            <div key={t.id} className={`summary-turn${t.role === "user" ? " is-user" : ""}`}>
              <span className="summary-role">{t.role === "user" ? "You" : "AI"}</span>
              {t.text}
              {Array.isArray(t.sources) && t.sources.length > 0 ? (
                <div className="transcript-sources">Sources: {t.sources.join(", ")}</div>
              ) : null}
            </div>
          ))}
          {summary.marks.length > 0 && (
            <div className="summary-marks">
              <div className="summary-marks-title">Marked components</div>
              {summary.marks.map((m) => (
                <div key={m.label} className="summary-mark">
                  <span className={`ann-history-dot lvl-${m.level}`} />
                  {m.step != null ? <span className="ann-history-step">{m.step}</span> : null}
                  {m.label}
                  {m.detail ? <span className="summary-mark-detail">{m.detail}</span> : null}
                </div>
              ))}
            </div>
          )}
          {summary.model && (
            <div className="summary-diagram">
              <div className="summary-marks-title">
                Diagram
                <span className="summary-diagram-badge">{summary.model.mode.toUpperCase()}</span>
              </div>
              <div className="summary-diagram-name">{summary.model.title}</div>
              {/* 2D schematics are pure SVG — render them inline (read-only). A 3D
                  spec is shown as title/caption/legend only: importing the r3f
                  viewer here would pull the heavy three stack into this modal. */}
              {summary.model.mode === "2d" && (
                <div className="summary-diagram-stage">
                  {/* Recall shows the WHOLE schematic: there are no playback
                      controls here, so reset activeStep to 0 — otherwise a
                      diagram saved mid-playback would render frozen with later
                      steps permanently dimmed and no way to reveal them. */}
                  <Diagram2D
                    spec={{ ...summary.model, activeStep: 0 }}
                    paused
                    onSelect={setSelected}
                    selectable={tappable}
                  />
                </div>
              )}
              {summary.model.caption ? (
                <div className="summary-diagram-caption">{summary.model.caption}</div>
              ) : null}
              {legend.length > 0 && (
                <ul className="summary-diagram-legend">
                  {legend.map((l, i) => {
                    const body = (
                      <>
                        <span
                          className="solution-panel__swatch"
                          style={{ background: modelColorHex(l.color) }}
                        />
                        <span className="solution-panel__legend-text">
                          <span className="solution-panel__legend-name">{l.label}</span>
                          {l.note ? (
                            <span className="solution-panel__legend-note">{l.note}</span>
                          ) : null}
                        </span>
                        {l.detail ? (
                          <span className="solution-panel__legend-badge" aria-hidden="true">
                            {l.part.warning ? "⚠" : "ⓘ"}
                          </span>
                        ) : null}
                      </>
                    );
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
              )}
              {selected ? <PartDetail part={selected} onClose={() => setSelected(null)} /> : null}
            </div>
          )}
        </div>

        <footer className="summary-actions">
          <button className="btn btn--ghost btn--pill" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn btn--ghost btn--pill" onClick={download}>
            Download .txt
          </button>
          <button className="btn btn--primary btn--pill" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
