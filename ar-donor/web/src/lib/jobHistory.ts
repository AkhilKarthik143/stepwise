import type { SessionSummary } from "./useWebRTC";
import { normalizeModelSpec } from "./solutionModel";
import { sanitizeTitles } from "./sources";

/**
 * Persistent job history — a small localStorage ring of session records.
 *
 * A SessionSummary used to live only in React state: dismissing the modal or
 * reloading the page destroyed it forever. Field reality is the opposite — the
 * technician finishes a job, pockets the phone, and needs the torque spec an
 * hour later. Every completed/errored session record lands here (deduped by
 * startedAt, newest first, capped) and is browsable from the idle screen.
 *
 * Best-effort by design: quota errors / private-mode / disabled storage must
 * never break the app — every call is wrapped.
 */
const KEY = "jobHistory.v1";
const MAX_JOBS = 12;

export function saveJob(summary: SessionSummary): void {
  try {
    const jobs = listJobs().filter((j) => j.startedAt !== summary.startedAt);
    jobs.unshift(summary);
    // Quota pressure must evict the OLDEST records, never the just-finished one
    // (the record the technician most needs): shrink-and-retry so the newest
    // entry survives whenever any record can fit at all.
    for (const n of [MAX_JOBS, 6, 3, 1]) {
      try {
        window.localStorage.setItem(KEY, JSON.stringify(jobs.slice(0, n)));
        return;
      } catch {
        /* try a smaller ring */
      }
    }
  } catch {
    /* storage unavailable — history is an enhancement, never a blocker */
  }
}

function _validTurn(t: any): boolean {
  return (
    !!t &&
    typeof t === "object" &&
    typeof t.text === "string" &&
    (t.role === "user" || t.role === "assistant") &&
    typeof t.at === "number"
  );
}

function _validMark(m: any): boolean {
  return !!m && typeof m === "object" && typeof m.label === "string";
}

export function listJobs(): SessionSummary[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Element-level validation: localStorage is origin-writable shared state; a
    // corrupt/tampered entry must degrade to "filtered out", never to a render
    // crash inside SessionSummaryModal (the app has no error boundary).
    return parsed
      .filter(
        (j) =>
          j &&
          typeof j.startedAt === "number" &&
          typeof j.endedAt === "number" &&
          Array.isArray(j.transcript) &&
          Array.isArray(j.marks)
      )
      .map((j) => ({
        ...j,
        // Coerce each turn's `sources` on READ: localStorage is origin-writable,
        // so a tampered non-array value (e.g. a string) would otherwise reach the
        // modal/CaptionBar and crash `.join` (the app has no error boundary).
        transcript: j.transcript.filter(_validTurn).map((t: any) => {
          const s = sanitizeTitles(t.sources);
          return s.length ? { ...t, sources: s } : { ...t, sources: undefined };
        }),
        marks: j.marks.filter(_validMark),
        // Re-validate the persisted diagram on READ: a tampered/old entry must
        // degrade to null (never reach the modal renderer as garbage). Absent
        // `model` (records from before this feature) coalesces to null. Its
        // absence is NOT part of the element-level filter above, so an old job
        // without a diagram is still returned.
        model: (j as any).model ? normalizeModelSpec((j as any).model) : null,
      }));
  } catch {
    return [];
  }
}

export function clearJobs(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
