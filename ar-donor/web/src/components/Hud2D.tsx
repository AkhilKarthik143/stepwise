import { useState } from "react";
import type { Capabilities } from "../lib/capabilities";
import type { ConnState } from "../lib/useWebRTC";

interface Props {
  caps: Capabilities;
  state: ConnState;
  log: string[];
  onConnect: () => void;
  onDisconnect: () => void;
  onEnterAR: () => void;
  /** Start a live session sharing the screen instead of the camera (desktop). */
  onConnectScreen?: () => void;
  /** Open the typed chat lane (text + images) instead of a live call. */
  onOpenChat?: () => void;
  /** Open the company's Solution Memory (past solved cases). */
  onOpenSolutions?: () => void;
  /** True when the browser supports screen capture (desktop only). */
  screenSupported?: boolean;
  /** False until the lazy 3D Scene (which owns the XR session) has mounted. */
  arReady?: boolean;
  /** "lookup" while the AI is consulting the technical manual. */
  aiActivity?: "idle" | "lookup";
  /** Manual source title(s) grounding the AI's current/just-given answer. */
  groundedBy?: string[];
  /** True while the AI's voice is audibly playing. */
  speaking?: boolean;
  /** True while the technician's mic is muted (AI hears nothing). */
  micMuted?: boolean;
  onToggleMic?: () => void;
  /** Live local mic level 0..1 — "the AI can hear you" feedback. */
  micLevel?: number;
  /** True when the unmuted mic has produced no signal for a sustained window. */
  micSilent?: boolean;
  /** Operator-language description of the last fatal error (shown with Retry). */
  lastError?: string | null;
  /** True when AI audio is blocked by the autoplay policy (needs a tap). */
  audioBlocked?: boolean;
  onResumeAudio?: () => void;
  /** Send a typed message to the assistant (loud-environment fallback). */
  onSendText?: (text: string) => boolean;
  /** True when a session record (transcript/marks) exists for review. */
  hasRecord?: boolean;
  /** Open the session-record modal (export after an involuntary ending). */
  onViewRecord?: () => void;
  /** Save the camera frame with the AI's marks burned in (.png download). */
  onSnapshot?: () => void;
  /** Sign out (clear the stored token). Provided only when the server requires
   *  auth; shown only between jobs (idle/error), never mid-session. */
  onSignOut?: () => void;
}

const STATUS_TEXT: Record<ConnState, string> = {
  idle: "Idle",
  connecting: "Connecting…",
  connected: "Connected — listening",
  reconnecting: "Reconnecting…",
  error: "Disconnected",
};

/** The premium 2D DOM HUD — the universal T0 baseline that works on any display
 *  (XREAL Air / phones / laptops) and overlays the AR view on headsets. */
export function Hud2D({
  caps,
  state,
  log,
  onConnect,
  onDisconnect,
  onEnterAR,
  onConnectScreen,
  onOpenChat,
  onOpenSolutions,
  screenSupported = false,
  arReady = true,
  aiActivity = "idle",
  groundedBy = [],
  speaking = false,
  micMuted = false,
  onToggleMic,
  micLevel = 0,
  micSilent = false,
  lastError = null,
  audioBlocked = false,
  onResumeAudio,
  onSendText,
  hasRecord = false,
  onViewRecord,
  onSnapshot,
  onSignOut,
}: Props) {
  const connected = state === "connected";
  // A live session exists during 'reconnecting' too — End must stay reachable
  // there (an operator finishing the job mid-blip still needs their summary).
  const sessionActive = connected || state === "reconnecting";
  // Disable Connect while connecting OR reconnecting (a live session exists).
  const busy = state === "connecting" || state === "reconnecting";

  // What the status pill shows, by priority: a manual lookup beats the speaking
  // glow beats the plain transport state — the technician always sees the most
  // informative thing the AI is doing right now.
  let pillClass = `status status--${state}`;
  let pillText = STATUS_TEXT[state];
  if (connected && aiActivity === "lookup") {
    pillClass = "status status--lookup";
    pillText = "Checking the manual…";
  } else if (connected && speaking) {
    pillClass = "status status--speaking";
    pillText = "Speaking";
  }

  // Connected mode keeps the center of the screen CLEAR — that's where the AI
  // draws its component highlights. Controls shrink into the top bar; the log
  // collapses to its latest line (tap to expand).
  const [logOpen, setLogOpen] = useState(false);
  // Typed-input fallback for loud floors / quiet zones / failed mics.
  const [typeOpen, setTypeOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const submitText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSendText) return;
    const t = draft.trim();
    if (t && onSendText(t)) setDraft("");
  };

  return (
    <div className="hud">
      <header className="hud-top">
        <span className="brand">AR&nbsp;Technician&nbsp;Assistant</span>
        <span className="hud-top-right">
          {connected && caps.arSupported && (
            <button
              className="btn btn--ghost btn--pill"
              onClick={onEnterAR}
              disabled={!arReady}
            >
              {arReady ? "Enter AR" : "Preparing…"}
            </button>
          )}
          {connected && onSnapshot && (
            <button
              className="btn btn--ghost btn--pill"
              onClick={onSnapshot}
              title="Save a photo of this view with the AI's marks"
            >
              Snap
            </button>
          )}
          {connected && onSendText && (
            <button
              className="btn btn--ghost btn--pill"
              onClick={() => {
                setTypeOpen((o) => !o);
                setLogOpen(false); // the input row and the expanded log share space
              }}
              title="Type to the assistant"
            >
              {typeOpen ? "Close" : "Type"}
            </button>
          )}
          {connected && onToggleMic && (
            <button
              className={`btn btn--pill ${micMuted ? "btn--mic-off" : "btn--ghost"}`}
              onClick={onToggleMic}
              title="Toggle microphone (m)"
            >
              {micMuted ? "Unmute" : "Mute"}
            </button>
          )}
          {sessionActive && (
            <button className="btn btn--danger btn--pill" onClick={onDisconnect}>
              End
            </button>
          )}
          {connected && micMuted && <span className="mic-off-badge">MIC OFF</span>}
          {connected && !micMuted && micSilent && (
            <span className="mic-silent-badge" title="The microphone is producing no signal">
              NO MIC SIGNAL
            </span>
          )}
          {connected && !micMuted && (
            <span className="mic-meter" title="Mic level — the AI hears this" aria-hidden="true">
              {[0.12, 0.3, 0.5, 0.7, 0.88].map((t) => (
                <span key={t} className={`mic-meter-seg${micLevel >= t ? " on" : ""}`} />
              ))}
            </span>
          )}
          <span className={pillClass} aria-live="polite">
            {pillText}
          </span>
          {connected && groundedBy.length > 0 && (
            <span
              className="grounded-chip"
              title={`Grounded by: ${groundedBy.join(", ")}`}
              aria-label={`Grounded by ${groundedBy.join(", ")}`}
            >
              <span className="grounded-chip__icon" aria-hidden="true">📖</span>
              {groundedBy.join(" · ")}
            </span>
          )}
          {/* Sign out — only between jobs (never mid-session, to avoid an
              accidental tap killing a live call). */}
          {onSignOut && (state === "idle" || state === "error") && (
            <button
              className="btn btn--ghost btn--pill"
              onClick={onSignOut}
              title="Sign out"
            >
              Sign out
            </button>
          )}
        </span>
      </header>

      {/* Mid-job transient blip: a small banner, NOT the idle onboarding block
          — the session is still alive and the work area must stay usable. */}
      {state === "reconnecting" && (
        <div className="reconnect-banner" role="status">
          Reconnecting — the session is still live…
        </div>
      )}

      {/* Pre-connection only: the big call-to-action + onboarding hint. Once
          a session exists (connected OR reconnecting) this block disappears so
          annotations own the view. */}
      {!sessionActive && (
        <div className="hud-center">
          {state === "error" && lastError && (
            <div className="error-card" role="alert">
              <strong>{hasRecord ? "Session interrupted" : "Couldn't connect"}</strong>
              <p>{lastError}</p>
              {hasRecord && onViewRecord && (
                <button className="btn btn--ghost btn--pill error-card-record" onClick={onViewRecord}>
                  View session record
                </button>
              )}
            </div>
          )}
          {state === "error" ? (
            <button className="btn btn--primary" onClick={onConnect} disabled={busy}>
              {busy ? "Connecting…" : "Retry"}
            </button>
          ) : (
            <div className="mode-choice">
              <button className="btn btn--primary" onClick={onConnect} disabled={busy}>
                {busy ? "Connecting…" : "📹 Start video call"}
              </button>
              {screenSupported && onConnectScreen && (
                <button className="btn btn--ghost" onClick={onConnectScreen} disabled={busy}>
                  🖥️ Share my screen
                </button>
              )}
              {onOpenChat && (
                <button className="btn btn--ghost" onClick={onOpenChat} disabled={busy}>
                  💬 Text chat
                </button>
              )}
              {onOpenSolutions && (
                <button className="btn btn--ghost" onClick={onOpenSolutions} disabled={busy}>
                  📚 Past solutions
                </button>
              )}
            </div>
          )}
          {caps.arSupported && (
            <button className="btn btn--ghost" onClick={onEnterAR} disabled={!arReady}>
              {arReady ? "Enter AR" : "Preparing AR…"}
            </button>
          )}
          <p className="hint">
            <strong>Video call</strong>: the assistant sees your camera &amp; answers out
            loud. {screenSupported && <><strong>Share screen</strong>: it sees your screen. </>}
            <strong>Text chat</strong>: type &amp; attach photos.
            <br />
            <span className="tier">
              Mode: <strong>{caps.tier}</strong> · {caps.details}
            </span>
          </p>
        </div>
      )}

      {/* Typed-input fallback: ask the assistant by keyboard when the floor is
          too loud to talk. The AI still sees the camera and answers out loud. */}
      {connected && typeOpen && onSendText && (
        <form className="type-row" onSubmit={submitText}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setTypeOpen(false);
            }}
            placeholder="Type to the assistant…"
            maxLength={2000}
            aria-label="Message to the assistant"
          />
          <button type="submit" className="btn btn--primary btn--pill" disabled={!draft.trim()}>
            Send
          </button>
        </form>
      )}

      {/* Autoplay-blocked AI audio: one tap (a user gesture) re-enables it. */}
      {audioBlocked && onResumeAudio && (
        <div className="audio-unblock-wrap">
          <button className="btn btn--primary audio-unblock" onClick={onResumeAudio}>
            Tap to enable AI audio
          </button>
        </div>
      )}

      <footer className="hud-bottom">
        {/* Connected: latest log line only (tap to expand). Idle: full log. */}
        {/* Collapsible while connected AND on the error screen: a full-height
            log there covers the surviving transcript's toggle (z10 over z7) at
            phone widths — exactly when the technician needs the record. */}
        <div
          className={`log ${(connected || state === "error") && !logOpen ? "log--compact" : ""}${
            (connected || state === "error") && logOpen ? " log--connected-open" : ""
          }`}
          onClick={() => (connected || state === "error") && setLogOpen((o) => !o)}
          role={connected || state === "error" ? "button" : undefined}
          title={
            connected || state === "error"
              ? logOpen
                ? "Collapse log"
                : "Expand log"
              : undefined
          }
        >
          {((connected || state === "error") && !logOpen ? log.slice(0, 1) : log).map((line, i) => (
            <div key={i} className="log-line">
              {line}
            </div>
          ))}
        </div>
      </footer>
    </div>
  );
}
