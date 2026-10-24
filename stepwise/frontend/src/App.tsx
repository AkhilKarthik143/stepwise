import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BuildCamera, type FrameGrabber } from "./components/BuildCamera";
import { StepPanel } from "./components/StepPanel";
import { useRealtimeSocket } from "./hooks/useRealtimeSocket";
import { fetchConfig, type RuntimeConfig } from "./lib/api";

// BuildSight on the phone: overhead camera, the current step from the manual, voice in and out.
// Every button sends the words a builder would say, so taps and voice share one server path.
export default function App() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [lastCheckFrame, setLastCheckFrame] = useState<string | null>(null);
  const grabber = useRef<FrameGrabber | null>(null);
  const { state, connect, toggleMic, registerFrameProvider, setManualVision, micActive, bargeIn, sendText, requestCheck, clearError } = useRealtimeSocket(config);

  useEffect(() => {
    fetchConfig().then(setConfig).catch((e) => setConfigError(String(e)));
  }, []);

  useEffect(() => {
    if (!config) return;
    connect();
    setManualVision(true); // keep a recent frame on the server for questions and part matching
  }, [config, connect, setManualVision]);

  const registerGrabber = useCallback((grab: FrameGrabber | null) => {
    grabber.current = grab;
    registerFrameProvider(grab);
  }, [registerFrameProvider]);

  const build = state.build;
  const hasBuild = !!build?.build;
  const busy = state.conv === "thinking";

  const runCheck = useCallback((frame: string | null, trigger: "stillness" | "button") => {
    if (!frame || !hasBuild) return;
    setLastCheckFrame(frame);
    requestCheck(frame, trigger);
  }, [hasBuild, requestCheck]);

  const onStill = useCallback((frame: string) => {
    if (!busy) runCheck(frame, "stillness");
  }, [busy, runCheck]);

  function say(text: string) {
    const value = text.trim();
    if (!value) return;
    bargeIn();
    sendText(value);
  }

  const lastReply = useMemo(() => {
    for (let i = state.lines.length - 1; i >= 0; i -= 1) if (state.lines[i].role === "assistant") return state.lines[i].text;
    return hasBuild ? "Say “what's next?” to start." : "";
  }, [state.lines, hasBuild]);

  const p = config?.providers;
  const voice = state.voice?.voice_out ?? p?.voice_out ?? "browser";
  const pills: [string, string, boolean][] = [
    ["Checks", p?.claude_configured ? "Claude" : "key missing", !!p?.claude_configured],
    ["Voice", voice === "cartesia" ? "Cartesia" : voice === "qwen" ? "Qwen" : "browser", voice === "cartesia"],
    ["Builds", String(build?.builds.length ?? 0), (build?.builds.length ?? 0) > 0],
  ];
  const failed = build?.check?.state === "failed";

  return (
    <div className="bs-app">
      <header className="bs-header">
        <div className="bs-brand"><strong>BuildSight</strong><small>hands-free build copilot</small></div>
        <div className="bs-header-right">
          {(build?.builds.length ?? 0) > 1 && (
            <select aria-label="Switch build" value={build?.build?.id ?? ""} onChange={(e) => {
              const target = build!.builds.find((b) => b.id === e.target.value);
              if (target) say(`switch to ${target.title}`);
            }}>
              {build!.builds.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
          )}
          <span className={`bs-conn bs-conn--${state.conn}`} title={state.conn} />
        </div>
      </header>

      <main className="bs-main">
        <div className="bs-camera-wrap">
          <BuildCamera onStill={onStill} registerGrabber={registerGrabber} stillnessEnabled={hasBuild && !build?.complete} />
          {hasBuild && build?.step && !build.complete && (
            <div className={`bs-overlay ${failed ? "is-failed" : ""}`}>
              <span>STEP {build.step.step}/{build.build!.total}</span>
              <span>{busy ? "checking…" : failed ? "hold on" : state.conv === "speaking" ? "speaking" : micActive ? "listening" : "ready"}</span>
            </div>
          )}
        </div>

        <section className="bs-talk" aria-live="polite">
          {state.partialUser && <p className="bs-heard">“{state.partialUser}”</p>}
          {lastReply && <p className="bs-reply">{lastReply}</p>}
        </section>

        {hasBuild ? <StepPanel status={build!} lastCheckFrame={lastCheckFrame} /> : (
          <section className="bs-step">
            <span className="bs-kicker">NO BUILD LOADED</span>
            <b>Turn a manual into a build first.</b>
            <small>On the laptop: <code>python scripts/ingest_manual.py --pdf manual.pdf --build-id my-build --title "My build"</code>, review build.json, then reload.</small>
            <button className="bs-btn" onClick={() => fetch("/api/builds/reload", { method: "POST" }).then(() => say("what's next"))}>Reload builds</button>
          </section>
        )}

        <div className="bs-pills">{pills.map(([k, v, live]) => <span key={k} className={`bs-pill ${live ? "is-live" : ""}`}><b>{k}</b> {v}</span>)}</div>

        {(configError || state.error) && (
          <button className="bs-error" onClick={clearError}>{configError ? `Backend unreachable: ${configError}` : state.error} (tap to dismiss)</button>
        )}
      </main>

      <footer className="bs-controls">
        <div className="bs-row">
          <button className="bs-btn" onClick={() => say("back")} disabled={!hasBuild}>Back</button>
          <button className="bs-btn" onClick={() => say("repeat")} disabled={!hasBuild}>Repeat</button>
          <button className="bs-btn" onClick={() => runCheck(grabber.current?.() ?? null, "button")} disabled={!hasBuild || busy}>Check</button>
          {failed
            ? <button className="bs-btn is-amber" onClick={() => say("that's fine")}>That's fine</button>
            : <button className="bs-btn is-primary" onClick={() => say("next")} disabled={!hasBuild}>Next</button>}
        </div>
        <button className={`bs-mic ${micActive ? "is-on" : ""}`} onClick={() => void toggleMic()} disabled={state.conn !== "connected"}>
          {micActive ? "Listening… tap to mute" : "Tap to talk"}
        </button>
        <form className="bs-row" onSubmit={(e) => { e.preventDefault(); say(command); setCommand(""); }}>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Or type: what's next? is this the right one?" aria-label="Ask BuildSight" />
          <button className="bs-btn is-primary" type="submit">Send</button>
        </form>
      </footer>
    </div>
  );
}
