import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Alerts } from "./components/Alerts";
import { Panel } from "./components/Panel";
import { EventLogPanel } from "./components/panels/EventLogPanel";
import { FieldVisionPanel } from "./components/panels/FieldVisionPanel";
import { MachineDataPanel } from "./components/panels/MachineDataPanel";
import { MeasurementPanel } from "./components/panels/MeasurementPanel";
import { OverviewPanel } from "./components/panels/OverviewPanel";
import { ProcedurePanel } from "./components/panels/ProcedurePanel";
import { RepairCard } from "./components/RepairCard";
import { SchematicPanel } from "./components/panels/SchematicPanel";
import { useRealtimeSocket } from "./hooks/useRealtimeSocket";
import { PANEL_TITLES, fetchConfig, type RuntimeConfig } from "./lib/api";

const ModelPanel = lazy(() => import("./components/panels/ModelPanel").then((m) => ({ default: m.ModelPanel })));

const PANEL_ORDER = ["machine_data", "overview", "model", "schematic", "procedure", "measurement", "event_log"];
const ACCENTS: Record<string, string> = {
  machine_data: "#65d9ff", overview: "#65d9ff", model: "#a8b7c8", schematic: "#65d9ff",
  procedure: "#f6bf55", measurement: "#ff6d6d", event_log: "#39e58c",
};

export default function ConsoleApp() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const { state, connect, toggleMic, registerFrameProvider, registerScreenProvider, bargeIn, micActive, manualVision, setManualVision, clearError, dismissAlert, sendText, confirmAnchor } = useRealtimeSocket(config);

  useEffect(() => {
    fetchConfig().then(setConfig).catch((e) => setConfigError(String(e)));
  }, []);

  useEffect(() => {
    if (config) {
      connect();
      setManualVision(true);
    }
  }, [config, connect, setManualVision]);

  const lastAssistant = useMemo(() => {
    if (state.partialAssistant) return state.partialAssistant;
    for (let i = state.lines.length - 1; i >= 0; i -= 1) if (state.lines[i].role === "assistant") return state.lines[i].text;
    return "Ask STEPWISE what you are looking at.";
  }, [state.lines, state.partialAssistant]);

  const visiblePanels = PANEL_ORDER.filter((p) => state.visible[p] || (p === "overview" && state.highlight) || (p === "procedure" && state.panels.procedure));
  const providerLabel = state.provider === "claude" ? "CLAUDE" : state.provider === "guide" ? "MANUAL-GUIDED" : "MOCK / LOCAL";
  const currentStep = state.panels.procedure;
  const asset = state.assetLabel || config?.asset_id || "PL45LM-01";
  const report: string | undefined = state.panels.event_log?.report;
  const p = config?.providers;
  const voiceOut = state.voice?.voice_out ?? p?.voice_out ?? "browser";
  const statusPills: [string, string, boolean][] = [
    ["Brain", p?.agent === "claude" ? "Claude" : "mock", p?.agent === "claude"],
    ["Vision", p?.vision === "claude" ? "Claude" : "confirm by voice", p?.vision === "claude"],
    ["Voice", voiceOut === "cartesia" ? "Cartesia Sonic + Ink" : voiceOut === "qwen" ? "Qwen" : "browser", voiceOut === "cartesia"],
    ["Search", p?.moss_configured ? "Moss" : "local catalog", !!p?.moss_configured],
  ];

  function submitCommand(value = command) {
    const text = value.trim();
    if (!text) return;
    sendText(text);
    setCommand("");
  }

  return (
    <div className="stepwise-app">
      <header className="stepwise-header">
        <div className="stepwise-brand"><span className="stepwise-mark">F</span><div><strong>STEPWISE AR</strong><small>field maintenance copilot</small></div></div>
        <div className="stepwise-header-meta"><span className="stepwise-asset">{asset}</span><span className={`stepwise-connection stepwise-connection--${state.conn}`}>{state.conn}</span></div>
      </header>

      <main className="stepwise-main">
        <section className="stepwise-camera-card" aria-label="Field camera">
          <div className="stepwise-camera-topline"><span className="stepwise-live-dot" /> <span>{manualVision ? "FIELD VIEW LIVE" : "CAMERA OFF"}</span><span className="stepwise-camera-source">rear camera · selected frames</span><span className={`stepwise-provider stepwise-provider--${state.provider}`}>{providerLabel}</span></div>
          <div className="stepwise-camera-viewport">
            <FieldVisionPanel active={manualVision} width={config?.vision.width ?? 320} height={config?.vision.height ?? 240} screen={config?.vision.screen ?? { width: 768, height: 768 }} perception={state.partialAssistant || lastAssistant} annotate={state.annotate} annotations={state.annotations} onConfirmAnchor={confirmAnchor} registerFrameProvider={registerFrameProvider} registerScreenProvider={registerScreenProvider} />
          </div>
          <div className="stepwise-camera-actions">
            <button className={`stepwise-control ${manualVision ? "is-on" : ""}`} onClick={() => setManualVision((value) => !value)}>{manualVision ? "Camera on" : "Enable camera"}</button>
            <button className="stepwise-control" onClick={bargeIn}>Stop voice</button>
            <button className="stepwise-control stepwise-control--primary" onClick={() => void toggleMic()} disabled={state.conn !== "connected"}>{micActive ? "Mute mic" : "Talk"}</button>
          </div>
        </section>

        <div className="stepwise-status-row" aria-label="Live services">
          {statusPills.map(([label, value, live]) => <span key={label} className={`stepwise-pill ${live ? "is-live" : ""}`}><b>{label}</b> {value}</span>)}
        </div>

        <section className="stepwise-guidance" aria-live="polite">
          <div className="stepwise-guidance-label"><span className={`stepwise-state-dot stepwise-state-dot--${state.conv}`} /> {state.conv === "thinking" ? "PROCESSING" : state.conv.toUpperCase()} <span className="stepwise-guidance-label__source">grounded · {state.sources[0]?.label || "STEPWISE catalog"}</span></div>
          {state.partialUser && <p className="stepwise-heard">“{state.partialUser}”</p>}
          <p>{lastAssistant}</p>
          <RepairCard guide={state.guide} step={currentStep} report={report} sources={state.sources} onSay={submitCommand} />
        </section>

        <div className="stepwise-command-row">
          <form className="stepwise-command" onSubmit={(event) => { event.preventDefault(); submitCommand(); }}>
            <span className="stepwise-command-icon">⌕</span>
            <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Say or type what's wrong…" aria-label="Ask STEPWISE" />
            <button type="submit">Send</button>
          </form>
          <button className={`stepwise-evidence-toggle ${evidenceOpen ? "is-open" : ""}`} onClick={() => setEvidenceOpen((value) => !value)}>{evidenceOpen ? "Hide evidence" : "Open evidence"} <span>({visiblePanels.length})</span></button>
        </div>

        {state.guide.phase === "idle" && <div className="stepwise-quick-actions" aria-label="Demo commands">
          {[["The nozzle is clogged", "Clogged nozzle (Prusa)"], ["What am I looking at?", "Identify CNC"], ["Walk me through the drawbar inspection.", "CNC procedure"]].map(([value, label]) => <button key={value} onClick={() => submitCommand(value)}>{label}</button>)}
        </div>}

        {configError && <div className="stepwise-inline-error">Backend config unavailable: {configError}. The UI remains available in local mode.</div>}
        {state.error && <div className="stepwise-inline-error">{state.error}<button onClick={clearError}>Dismiss</button></div>}
        <Alerts alerts={state.alerts} onDismiss={dismissAlert} />

        {evidenceOpen && <section className="stepwise-evidence-grid" aria-label="Evidence panels">
          {visiblePanels.length === 0 ? <div className="stepwise-empty-evidence">Use a quick action to open grounded machine evidence.</div> : visiblePanels.map((panel) => <Panel key={panel} title={PANEL_TITLES[panel]} accent={ACCENTS[panel]}>{renderPanel(panel)}</Panel>)}
        </section>}
      </main>
    </div>
  );

  function renderPanel(panel: string) {
    const data = state.panels[panel] || {};
    switch (panel) {
      case "machine_data": return <MachineDataPanel data={data} />;
      case "overview": return <OverviewPanel highlight={state.highlight} />;
      case "model": return <Suspense fallback={<div className="stepwise-loading">Loading CNC model…</div>}><ModelPanel cmd={state.modelCmd} /></Suspense>;
      case "schematic": return <SchematicPanel data={data} />;
      case "procedure": return <ProcedurePanel data={data} />;
      case "measurement": return <MeasurementPanel data={data} />;
      case "event_log": return <EventLogPanel data={data} events={state.events} />;
      default: return null;
    }
  }
}
