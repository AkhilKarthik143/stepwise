import { useEffect, useRef, useState } from "react";
import { importManual, listImports, searchManuals, uploadManual, type BuildStatus, type ImportJob, type ManualResult } from "../lib/api";

interface Props {
  status: BuildStatus | null;
  onOpen: (buildId: string) => void;
  onClose: () => void;
}

// The manual library: search LEGO by set number or IKEA by product name, upload any PDF, and
// open a manual. The server reads new manuals page by page; they open as soon as the first
// steps are ready.
export function Library({ status, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ManualResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => listImports().then((j) => alive && setJobs(j)).catch(() => {});
    tick();
    const id = window.setInterval(tick, 1500);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2) return;
    const found = await run(() => searchManuals(query.trim()));
    if (found) setResults(found);
  }

  async function use(job: ImportJob | undefined) {
    if (!job) return;
    setJobs((list) => [job, ...list.filter((j) => j.build_id !== job.build_id)]);
    onOpen(job.build_id);
    onClose();
  }

  const jobFor = (id: string) => jobs.find((j) => j.build_id === id);
  const library = [
    ...(status?.builds ?? []).map((b) => ({ id: b.id, title: b.title })),
    ...jobs.filter((j) => !(status?.builds ?? []).some((b) => b.id === j.build_id)).map((j) => ({ id: j.build_id, title: j.title })),
  ];

  return (
    <div className="bs-sheet" role="dialog" aria-label="Manuals">
      <div className="bs-sheet-panel">
        <header className="bs-sheet-head">
          <strong>Manuals</strong>
          <button className="bs-link" onClick={onClose}>Close</button>
        </header>

        <form className="bs-row" onSubmit={search}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="LEGO set number or IKEA product" aria-label="Search manuals" />
          <button className="bs-btn is-primary" type="submit" disabled={busy}>{busy ? "…" : "Search"}</button>
        </form>
        <small className="bs-hint">e.g. 31163 for a LEGO set, or MARIUS for an IKEA stool. Or upload any picture-based PDF.</small>
        <button className="bs-btn" onClick={() => file.current?.click()} disabled={busy}>Upload a PDF</button>
        <input ref={file} type="file" accept="application/pdf" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(() => uploadManual(f)).then(use);
        }} />
        {error && <p className="bs-sheet-error">{error}</p>}

        {results && (
          <section>
            <h3 className="bs-sheet-title">{results.length ? "Results" : "No manuals found"}</h3>
            <ul className="bs-results">
              {results.map((r) => (
                <li key={r.pdf_url}>
                  {r.cover_url ? <img src={r.cover_url} alt="" loading="lazy" /> : <span className="bs-cover-empty" />}
                  <div><b>{r.title}</b><small>{r.subtitle}{r.size_label ? ` · ${r.size_label}` : ""}</small></div>
                  <button className="bs-btn is-primary" disabled={busy} onClick={() => void run(() => importManual(r)).then(use)}>Use</button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {library.length > 0 && (
          <section>
            <h3 className="bs-sheet-title">Your manuals</h3>
            <ul className="bs-results">
              {library.map((b) => {
                const job = jobFor(b.id);
                const reading = job && (job.status === "downloading" || job.status === "reading");
                return (
                  <li key={b.id}>
                    <div>
                      <b>{b.title}</b>
                      <small>
                        {job?.status === "failed" ? `Couldn't read it: ${job.error}`
                          : job?.status === "downloading" ? "Downloading…"
                          : reading ? `Reading page ${job!.pages_done} of ${job!.pages_total} · ${job!.steps_ready} steps ready`
                          : b.id === status?.build?.id ? "Open now" : "Ready"}
                      </small>
                    </div>
                    <button className="bs-btn" onClick={() => { onOpen(b.id); onClose(); }} disabled={b.id === status?.build?.id}>Open</button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
