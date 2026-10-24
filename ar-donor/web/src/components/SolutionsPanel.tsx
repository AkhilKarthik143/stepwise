import { useEffect, useState } from "react";
import {
  type Solution,
  searchSolutions,
  getSolution,
  saveSolution,
} from "../lib/solutionsApi";
import { fileToDataUrl } from "../lib/chatApi";

/**
 * Solution Memory — the company's own database of solved cases ("have we fixed
 * this before?"). Search past cases, open one (with its photo), or record a new
 * fix. Everything is scoped server-side to the logged-in user's company.
 */
export function SolutionsPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Solution[]>([]);
  const [detail, setDetail] = useState<Solution | null>(null);
  const [mode, setMode] = useState<"list" | "new">("list");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  // New-case form.
  const [title, setTitle] = useState("");
  const [equipment, setEquipment] = useState("");
  const [problem, setProblem] = useState("");
  const [fix, setFix] = useState("");
  const [photo, setPhoto] = useState<string | undefined>();

  const refresh = async (query: string) => {
    setBusy(true);
    setNote("");
    try {
      setResults(await searchSolutions(query));
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (visible) void refresh("");
  }, [visible]);

  if (!visible) return null;

  const open = async (id: string) => {
    setBusy(true);
    try {
      setDetail(await getSolution(id));
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not open the case.");
    } finally {
      setBusy(false);
    }
  };

  const submitNew = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setNote("");
    try {
      await saveSolution({ title, equipment, problem, fix, photo });
      setTitle(""); setEquipment(""); setProblem(""); setFix(""); setPhoto(undefined);
      setMode("list");
      await refresh("");
      setNote("Saved to your company's solution memory.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat solutions" role="dialog" aria-label="Past solutions">
      <header className="chat__top">
        <span className="chat__title">📚 Solutions</span>
        <span>
          <button
            className="chat__detect"
            onClick={() => { setDetail(null); setMode(mode === "new" ? "list" : "new"); }}
            disabled={busy}
          >
            {mode === "new" ? "← Back" : "+ Record a fix"}
          </button>
          <button className="chat__close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </span>
      </header>

      {mode === "list" && !detail && (
        <>
          <div className="solutions__search">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void refresh(q); }}
              placeholder="Search past fixes… (e.g. pump no suction)"
              aria-label="Search solutions"
            />
            <button onClick={() => void refresh(q)} disabled={busy}>Search</button>
          </div>
          <div className="chat__log">
            {note && <div className="chat__hint">{note}</div>}
            {!busy && results.length === 0 && !note && (
              <p className="chat__hint">No saved cases yet — record your first fix with “+ Record a fix”.</p>
            )}
            {results.map((s) => (
              <button key={s.id} className="solutions__item" onClick={() => void open(s.id)}>
                <strong>{s.title}</strong>
                {s.equipment && <span className="solutions__eq">{s.equipment}</span>}
                <span className="solutions__meta">
                  {new Date(s.ts * 1000).toLocaleDateString()} {s.hasPhoto ? "· 📷" : ""}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {detail && (
        <div className="chat__log solutions__detail">
          <button className="chat__detect" onClick={() => setDetail(null)}>← Results</button>
          <h3>{detail.title}</h3>
          {detail.equipment && <p><strong>Equipment:</strong> {detail.equipment}</p>}
          {detail.problem && <p><strong>Problem:</strong> {detail.problem}</p>}
          {detail.fix && <p><strong>Fix:</strong> {detail.fix}</p>}
          {detail.photo && <img className="chat__img" src={detail.photo} alt="case photo" />}
          <p className="solutions__meta">
            {detail.author && <>by {detail.author} · </>}
            {new Date(detail.ts * 1000).toLocaleString()}
          </p>
        </div>
      )}

      {mode === "new" && !detail && (
        <div className="chat__log solutions__form">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title * (e.g. CP-200 pump loses prime)" />
          <input value={equipment} onChange={(e) => setEquipment(e.target.value)} placeholder="Equipment (model / location)" />
          <textarea value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="The problem…" rows={3} />
          <textarea value={fix} onChange={(e) => setFix(e.target.value)} placeholder="The fix that worked…" rows={4} />
          <label className="solutions__photo">
            📎 {photo ? "Photo attached ✓" : "Attach a photo"}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) setPhoto(await fileToDataUrl(f));
              }}
            />
          </label>
          {note && <div className="chat__error" role="alert">{note}</div>}
          <button className="chat__send" onClick={() => void submitNew()} disabled={busy || !title.trim()}>
            {busy ? "Saving…" : "Save to company memory"}
          </button>
        </div>
      )}
    </div>
  );
}
