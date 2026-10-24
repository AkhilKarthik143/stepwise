import { useEffect, useRef, useState } from "react";
import type { TranscriptTurn } from "../lib/useWebRTC";

/**
 * Live captions + session transcript of the AI's spoken guidance.
 *
 * The caption line shows the sentence the AI is speaking RIGHT NOW (fragments
 * stream in as it talks); when a turn completes it lingers briefly, so a missed
 * phrase is still readable. The Transcript button opens the full history —
 * every torque spec and part number the AI ever said, reviewable offline at a
 * glance, usable with hearing protection on a loud floor.
 */
const LINGER_MS = 5000;

export function CaptionBar({
  live,
  transcript,
}: {
  live: string;
  transcript: TranscriptTurn[];
}) {
  const [open, setOpen] = useState(false);
  const [lingering, setLingering] = useState(false);
  // The caption line is the AI'S voice only — find the last ASSISTANT turn.
  // (Lingering on the final turn of either role briefly displayed the user's
  // own typed message as if the AI had said it: a wrong-attribution hazard.)
  let last: TranscriptTurn | null = null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === "assistant") {
      last = transcript[i];
      break;
    }
  }
  const listRef = useRef<HTMLDivElement | null>(null);

  // When an AI turn commits, keep showing it for a few seconds.
  useEffect(() => {
    if (!last) return;
    setLingering(true);
    const t = setTimeout(() => setLingering(false), LINGER_MS);
    return () => clearTimeout(t);
  }, [last?.id]);

  // Auto-scroll the open panel to the newest turn.
  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [open, transcript.length, live]);

  const captionText = live || (lingering && last ? last.text : "");
  const hasAnything = transcript.length > 0 || live;

  return (
    <div className="captions" aria-live="off">
      {open && (
        <div className="transcript-panel" ref={listRef}>
          {transcript.length === 0 && !live && (
            <div className="transcript-empty">Nothing said yet.</div>
          )}
          {transcript.map((t) => (
            <div
              key={t.id}
              className={`transcript-turn${t.role === "user" ? " transcript-turn--user" : ""}`}
            >
              <span className="transcript-time">
                {new Date(t.at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              {t.role === "user" ? <span className="transcript-you">You</span> : null}
              {t.text}
              {Array.isArray(t.sources) && t.sources.length > 0 ? (
                <div className="transcript-sources">Sources: {t.sources.join(", ")}</div>
              ) : null}
            </div>
          ))}
          {live && <div className="transcript-turn transcript-turn--live">{live}</div>}
        </div>
      )}

      <div className="caption-row">
        {captionText && (
          <div className="caption-line" role="status">
            {captionText}
          </div>
        )}
        {hasAnything && (
          <button
            className="caption-toggle"
            onClick={() => setOpen((o) => !o)}
            title={open ? "Hide transcript" : "Show transcript"}
          >
            {open ? "Hide" : "Transcript"}
          </button>
        )}
      </div>
    </div>
  );
}
