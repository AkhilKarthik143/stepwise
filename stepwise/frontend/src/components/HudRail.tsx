import type { MetricsMsg } from "../lib/api";
import type { Line, ToolTick } from "../hooks/useRealtimeSocket";

const AGENTS: { id: string; label: string }[] = [
  { id: "orchestrator", label: "Orchestrator" },
  { id: "briefing", label: "Briefing" },
  { id: "safety", label: "Safety" },
  { id: "schematic", label: "Schematic" },
  { id: "diagnostic", label: "Diagnostic" },
  { id: "parts", label: "Parts" },
  { id: "procedure", label: "Procedure" },
  { id: "documentation", label: "Docs" },
  { id: "handoff", label: "Handoff" },
  { id: "field_advisor", label: "Field Advisor" },
];

export function HudRail({
  activeAgent,
  lines,
  partialUser,
  partialAssistant,
  recentTools,
  metrics,
}: {
  activeAgent: string;
  lines: Line[];
  partialUser: string;
  partialAssistant: string;
  recentTools: ToolTick[];
  metrics: MetricsMsg;
}) {
  return (
    <aside className="flex w-72 flex-shrink-0 flex-col gap-3 border-r border-stepwise-edge bg-stepwise-panel p-3">
      {/* Agent routing */}
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stepwise-muted">Agent Routing</h3>
        <div className="flex flex-wrap gap-1">
          {AGENTS.map((a) => {
            const on = a.id === activeAgent;
            return (
              <span
                key={a.id}
                className={`rounded px-2 py-0.5 text-[11px] ${
                  on ? "bg-stepwise-accent font-semibold text-white" : "bg-stepwise-bg text-stepwise-muted"
                }`}
              >
                {a.label}
              </span>
            );
          })}
        </div>
      </div>

      {/* Transcript */}
      <div className="flex min-h-0 flex-1 flex-col">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stepwise-muted">Live Transcript</h3>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-1 text-sm">
          {lines.length === 0 && !partialUser && !partialAssistant && (
            <p className="text-xs italic text-stepwise-muted">Press Talk and speak — “Brief me on this machine.”</p>
          )}
          {lines.map((l) => (
            <Bubble key={l.id} role={l.role} text={l.text} />
          ))}
          {partialUser && <Bubble role="user" text={partialUser} partial />}
          {partialAssistant && <Bubble role="assistant" text={partialAssistant} partial />}
        </div>
      </div>

      {/* Tool metrics */}
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stepwise-muted">Tool Calls</h3>
        <div className="mb-2 flex justify-between text-[11px] text-stepwise-muted">
          <span>total {metrics.count}</span>
          <span>rejected {metrics.rejected}</span>
          <span>{metrics.latency_ms}ms</span>
        </div>
        <div className="flex flex-col gap-1">
          {recentTools.slice(0, 5).map((t, i) => (
            <div key={`${t.ts}-${i}`} className="flex items-center justify-between rounded bg-stepwise-bg px-2 py-1 text-[11px]">
              <span className="font-mono text-stepwise-text">{t.name}</span>
              <span className={t.status === "rejected" ? "text-stepwise-alert" : "text-stepwise-live"}>{t.status}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Bubble({ role, text, partial }: { role: "user" | "assistant"; text: string; partial?: boolean }) {
  const isUser = role === "user";
  return (
    <div className={`rounded-lg px-2 py-1 ${isUser ? "self-end bg-stepwise-bg" : "self-start bg-stepwise-edge"} ${partial ? "opacity-70" : ""}`}>
      <div className="text-[10px] uppercase tracking-wide text-stepwise-muted">{isUser ? "Tech" : "STEPWISE"}</div>
      <div className="text-stepwise-text">{text}</div>
    </div>
  );
}
