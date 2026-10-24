import { useEffect, useState } from "react";
import { apiUrl, type BuildMetrics } from "./lib/api";

const KIND_LABEL: Record<string, string> = { command: "Commands", check: "Step checks", question: "Questions", part: "Part matching" };

// Second-screen dashboard for the demo table: polls the backend's live numbers every second.
export function Dashboard() {
  const [m, setM] = useState<BuildMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetch(apiUrl("/api/metrics"))
        .then((r) => r.json())
        .then((d) => { if (alive) { setM(d); setError(null); } })
        .catch((e) => alive && setError(String(e)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const last = m?.step_seconds.slice(-12) ?? [];
  const maxSec = Math.max(1, ...last);

  return (
    <div className="bs-dash">
      <header className="bs-dash-head">
        <div><strong>BuildSight</strong><span>live session</span></div>
        <span>{m?.build_title || "No build loaded"}{m?.total_steps ? ` · step ${m.step} of ${m.total_steps}` : ""}</span>
      </header>
      {error && <p className="bs-dash-error">Can't reach the backend: {error}</p>}
      <section className="bs-dash-tiles">
        <Tile label="Steps completed" value={m?.steps_done ?? 0} />
        <Tile label="Mistakes caught" value={m?.mistakes_caught ?? 0} tone="amber" />
        <Tile label="Avg time per step" value={m?.avg_step_seconds != null ? `${m.avg_step_seconds} s` : "–"} />
        <Tile label="Overrides" value={m?.overrides ?? 0} sub={`${m?.checks ?? 0} checks · ${m?.closer_looks ?? 0} closer looks`} />
      </section>
      <section className="bs-dash-row">
        <div className="bs-dash-card">
          <h2>Time per step (last {last.length})</h2>
          {last.length === 0 ? <p className="bs-dash-empty">No steps finished yet.</p> : (
            <div className="bs-bars" role="img" aria-label="Seconds per step">
              {last.map((s, i) => (
                <div key={i} className="bs-bar" title={`${s} s`}>
                  <span style={{ height: `${(s / maxSec) * 100}%` }} />
                  <small>{Math.round(s)}s</small>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="bs-dash-card">
          <h2>Latency per turn (median)</h2>
          {Object.keys(m?.median_ms ?? {}).length === 0 ? <p className="bs-dash-empty">No turns yet.</p> : (
            <table className="bs-lat">
              <tbody>
                {Object.entries(m!.median_ms).map(([k, ms]) => (
                  <tr key={k}><td>{KIND_LABEL[k] ?? k}</td><td>{ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: number | string; sub?: string; tone?: "amber" }) {
  return (
    <div className={`bs-tile ${tone ? `bs-tile--${tone}` : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}
