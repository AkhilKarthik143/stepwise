import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Alerts } from "./components/Alerts";
import { Panel } from "./components/Panel";
import { EventLogPanel } from "./components/panels/EventLogPanel";
import { FieldVisionPanel } from "./components/panels/FieldVisionPanel";
import { MachineDataPanel } from "./components/panels/MachineDataPanel";
import { MeasurementPanel } from "./components/panels/MeasurementPanel";
import { OverviewPanel } from "./components/panels/OverviewPanel";
import { ProcedurePanel } from "./components/panels/ProcedurePanel";
import { SchematicPanel } from "./components/panels/SchematicPanel";
import { useRealtimeSocket } from "./hooks/useRealtimeSocket";
import { PANEL_TITLES, fetchConfig, type RuntimeConfig } from "./lib/api";

const ModelPanel = lazy(() => import("./components/panels/ModelPanel").then((m) => ({ default: m.ModelPanel })));

const PANEL_ORDER = ["machine_data", "overview", "model", "schematic", "procedure", "measurement", "event_log"];
const ACCENTS: Record<string, string> = {
  machine_data: "#65d9ff", overview: "#65d9ff", model: "#a8b7c8", schematic: "#65d9ff",
  procedure: "#f6bf55", measurement: "#ff6d6d", event_log: "#39e58c",
};

export default function App() {
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
    return "Ask FORGE what you are looking at.";
  }, [state.lines, state.partialAssistant]);

  const visiblePanels = PANEL_ORDER.filter((p) => state.visible[p] || (p === "overview" && state.highlight) || (p === "procedure" && state.panels.procedure));
  const providerLabel = state.provider === "claude" ? "CLAUDE" : "MOCK / LOCAL";
  const currentStep = state.panels.procedure;
  const asset = state.assetLabel || config?.asset_id || "PL45LM-01";

  function submitCommand(value = command) {
    const text = value.trim();
    if (!text) return;
    sendText(text);
    setCommand("");
  }

  return (
    <div className="forge-app">
      <header className="forge-header">
        <div className="forge-brand"><span className="forge-mark">F</span><div><strong>FORGE AR</strong><small>field maintenance copilot</small></div></div>
        <div className="forge-header-meta"><span className="forge-asset">{asset}</span><span className={`forge-connection forge-connection--${state.conn}`}>{state.conn}</span></div>
      </header>

      <main className="forge-main">
        <section className="forge-camera-card" aria-label="Field camera">
          <div className="forge-camera-topline"><span className="forge-live-dot" /> <span>{manualVision ? "FIELD VIEW LIVE" : "CAMERA OFF"}</span><span className="forge-camera-source">rear camera · selected frames</span><span className={`forge-provider forge-provider--${state.provider}`}>{providerLabel}</span></div>
          <div className="forge-camera-viewport">
            <FieldVisionPanel active={manualVision} width={config?.vision.width ?? 320} height={config?.vision.height ?? 240} screen={config?.vision.screen ?? { width: 768, height: 768 }} perception={state.partialAssistant || lastAssistant} annotate={state.annotate} annotations={state.annotations} onConfirmAnchor={confirmAnchor} registerFrameProvider={registerFrameProvider} registerScreenProvider={registerScreenProvider} />
          </div>
          <div className="forge-camera-actions">
            <button className={`forge-control ${manualVision ? "is-on" : ""}`} onClick={() => setManualVision((value) => !value)}>{manualVision ? "Camera on" : "Enable camera"}</button>
            <button className="forge-control" onClick={bargeIn}>Stop voice</button>
            <button className="forge-control forge-control--primary" onClick={() => void toggleMic()} disabled={state.conn !== "connected"}>{micActive ? "Mute mic" : "Talk"}</button>
          </div>
        </section>

        <section className="forge-guidance" aria-live="polite">
          <div className="forge-guidance-label"><span className={`forge-state-dot forge-state-dot--${state.conv}`} /> {state.conv === "thinking" ? "PROCESSING" : state.conv.toUpperCase()} <span className="forge-guidance-label__source">grounded · {state.sources[0]?.label || "FORGE catalog"}</span></div>
          <p>{lastAssistant}</p>
          {currentStep?.mode && !currentStep.complete && <div className="forge-step-card"><span>STEP {((currentStep.current ?? currentStep.index ?? 0) + 1)} / {(currentStep.steps || currentStep.items || []).length}</span><b>{(currentStep.steps || currentStep.items || [])[currentStep.current ?? currentStep.index ?? 0]?.text || "Current approved action"}</b><small>{currentStep.mode === "safety" ? "Say confirmed to advance this safety item." : "Completion is operator-asserted."}</small></div>}
        </section>

        <div className="forge-command-row">
          <form className="forge-command" onSubmit={(event) => { event.preventDefault(); submitCommand(); }}>
            <span className="forge-command-icon">⌕</span>
            <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Ask FORGE anything about this machine…" aria-label="Ask FORGE" />
            <button type="submit">Send</button>
          </form>
          <button className={`forge-evidence-toggle ${evidenceOpen ? "is-open" : ""}`} onClick={() => setEvidenceOpen((value) => !value)}>{evidenceOpen ? "Hide evidence" : "Open evidence"} <span>({visiblePanels.length})</span></button>
        </div>

        <div className="forge-quick-actions" aria-label="Demo commands">
          {[["What am I looking at?", "Identify machine"], ["Show me where the spindle is.", "Locate spindle"], ["What should I inspect?", "Inspect"], ["Walk me through it.", "Procedure"], ["Generate the report.", "Report"]].map(([value, label]) => <button key={value} onClick={() => submitCommand(value)}>{label}</button>)}
        </div>

        {configError && <div className="forge-inline-error">Backend config unavailable: {configError}. The UI remains available in local mode.</div>}
        {state.error && <div className="forge-inline-error">{state.error}<button onClick={clearError}>Dismiss</button></div>}
        <Alerts alerts={state.alerts} onDismiss={dismissAlert} />

        {evidenceOpen && <section className="forge-evidence-grid" aria-label="Evidence panels">
          {visiblePanels.length === 0 ? <div className="forge-empty-evidence">Use a quick action to open grounded machine evidence.</div> : visiblePanels.map((panel) => <Panel key={panel} title={PANEL_TITLES[panel]} accent={ACCENTS[panel]}>{renderPanel(panel)}</Panel>)}
        </section>}
      </main>
    </div>
  );

  function renderPanel(panel: string) {
    const data = state.panels[panel] || {};
    switch (panel) {
      case "machine_data": return <MachineDataPanel data={data} />;
      case "overview": return <OverviewPanel highlight={state.highlight} />;
      case "model": return <Suspense fallback={<div className="forge-loading">Loading CNC model…</div>}><ModelPanel cmd={state.modelCmd} /></Suspense>;
      case "schematic": return <SchematicPanel data={data} />;
      case "procedure": return <ProcedurePanel data={data} />;
      case "measurement": return <MeasurementPanel data={data} />;
      case "event_log": return <EventLogPanel data={data} events={state.events} />;
      default: return null;
    }
  }
}
