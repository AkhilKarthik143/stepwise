import { useEffect, useState } from "react";
import type { SessionSummary } from "../lib/useWebRTC";
import { clearJobs, listJobs } from "../lib/jobHistory";

/**
 * "Past jobs" browser on the idle screen: every finished/errored session record
 * (persisted in localStorage) — tap one to reopen the full summary modal with
 * copy/download. The torque spec from this morning survives a pocketed phone.
 */
function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m` : `${s}s`;
}

export function PastJobs({
  visible,
  onView,
}: {
  visible: boolean;
  onView: (job: SessionSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<SessionSummary[]>([]);

  // Re-read whenever the panel becomes visible (a session may just have ended).
  useEffect(() => {
    if (visible) setJobs(listJobs());
  }, [visible, open]);

  if (!visible || jobs.length === 0) return null;

  return (
    <div className="past-jobs">
      {open && (
        <div className="past-jobs-list">
          {jobs.map((j) => (
            <button key={j.startedAt} className="past-job" onClick={() => onView(j)}>
              <span className="past-job-when">{fmtWhen(j.startedAt)}</span>
              <span className="past-job-meta">
                {fmtDur(j.endedAt - j.startedAt)} · {j.transcript.length} turns ·{" "}
                {j.marks.length} marks
              </span>
            </button>
          ))}
          <button
            className="past-jobs-clear"
            onClick={() => {
              clearJobs();
              setJobs([]);
              setOpen(false);
            }}
          >
            Clear history
          </button>
        </div>
      )}
      <button className="btn btn--ghost past-jobs-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide past jobs" : `Past jobs (${jobs.length})`}
      </button>
    </div>
  );
}
