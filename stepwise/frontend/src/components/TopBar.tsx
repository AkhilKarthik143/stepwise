import { type ConnState, type ConvState, formatClock } from "../lib/api";

const CONV_COLOR: Record<ConvState, string> = {
  idle: "#7d8da3",
  listening: "#22c55e",
  thinking: "#f59e0b",
  speaking: "#7c3aed",
};

export function TopBar({
  conn,
  conv,
  micActive,
  sessionRemaining,
  assetId,
  onToggleMic,
  onBargeIn,
  visionOn,
  onToggleVision,
}: {
  conn: ConnState;
  conv: ConvState;
  micActive: boolean;
  sessionRemaining: number;
  assetId: string;
  onToggleMic: () => void;
  onBargeIn: () => void;
  visionOn: boolean;
  onToggleVision: () => void;
}) {
  return (
    <header className="flex items-center justify-between border-b border-stepwise-edge bg-stepwise-panel px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="text-lg font-bold tracking-tight text-stepwise-text">
          🔧 STEPWISE
        </span>
        <span className="hidden text-xs text-stepwise-muted sm:inline">
          Field Operations Real-time Guidance Engine
        </span>
        <span
          className="hidden rounded bg-stepwise-edge px-1.5 py-0.5 text-[10px] text-stepwise-muted md:inline"
          title="Asset in front of the technician — full grounded data loaded"
        >
          active asset · {assetId}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`h-2 w-2 rounded-full ${conv === "listening" || conv === "speaking" ? "animate-pulseRing" : ""}`}
            style={{ background: CONV_COLOR[conv] }}
          />
          <span className="uppercase tracking-wide text-stepwise-muted">{conv}</span>
        </div>

        <div className="font-mono text-xs text-stepwise-muted" title="Session time remaining before resumption">
          ⏱ {formatClock(sessionRemaining)}
        </div>

        <div className="flex items-center gap-1 text-xs">
          <span className={`h-2 w-2 rounded-full ${conn === "connected" ? "bg-stepwise-live" : conn === "connecting" ? "bg-stepwise-warn" : "bg-stepwise-alert"}`} />
          <span className="text-stepwise-muted">{conn}</span>
        </div>

        <button
          onClick={onToggleVision}
          className={`rounded px-2 py-1 text-xs ${visionOn ? "bg-stepwise-vision text-black" : "border border-stepwise-edge text-stepwise-muted hover:text-stepwise-text"}`}
          title="Open the field-vision feed and pick a camera or load a video file"
        >
          👁 Vision
        </button>

        <button
          onClick={onBargeIn}
          className="rounded border border-stepwise-edge px-2 py-1 text-xs text-stepwise-muted hover:text-stepwise-text"
          title="Stop STEPWISE talking (barge-in)"
        >
          ⏹ Stop
        </button>

        <button
          onClick={onToggleMic}
          disabled={conn !== "connected"}
          className={`flex items-center gap-1.5 rounded px-3 py-1 text-sm font-semibold transition ${
            micActive ? "bg-stepwise-live text-black" : "bg-stepwise-accent text-white"
          } disabled:opacity-40`}
        >
          {micActive && <span className="h-2 w-2 animate-pulseRing rounded-full bg-black" />}
          {micActive ? "Listening — mic live" : "🎙 Talk"}
        </button>
      </div>
    </header>
  );
}
