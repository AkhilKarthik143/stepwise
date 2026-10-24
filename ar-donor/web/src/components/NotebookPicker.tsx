import { useCallback, useEffect, useState } from "react";
import { authToken } from "../lib/useWebRTC";
import { apiUrl } from "../lib/api";

/**
 * Runtime manual picker (idle screen): switch which NotebookLM notebook the
 * assistant consults — multi-equipment sites no longer edit .env and restart
 * the server between jobs. The backend refuses switches while a session is
 * live, so this only renders pre-connection.
 */
interface NotebookEntry {
  id: string;
  title: string;
  active: boolean;
}

function authHeaders(): Record<string, string> {
  const token = authToken(); // shared helper — persists URL tokens for PWA launches
  return token ? { "X-API-Key": token } : {};
}

export function NotebookPicker({ visible }: { visible: boolean }) {
  const [notebooks, setNotebooks] = useState<NotebookEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(apiUrl("/notebooks"), { headers: authHeaders() });
      if (!r.ok) return; // unauthorized / backend can't list — picker just hides
      const j = await r.json();
      if (Array.isArray(j.notebooks)) setNotebooks(j.notebooks);
    } catch {
      /* offline / dev without NotebookLM — picker stays hidden */
    }
  }, []);

  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh]);

  if (!visible || notebooks.length < 2) return null; // nothing to pick from

  const active = notebooks.find((n) => n.active);

  const onPick = async (id: string) => {
    if (!id || id === active?.id || busy) return;
    setBusy(true);
    setNote("");
    try {
      const r = await fetch(apiUrl("/notebooks/switch"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ id }),
      });
      if (r.ok) {
        setNote("Manual switched — first lookup may take a moment.");
        await refresh();
      } else if (r.status === 409) {
        setNote("End the active session before switching manuals.");
      } else {
        setNote("Couldn't switch manuals.");
      }
    } catch {
      setNote("Couldn't switch manuals.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="notebook-picker">
      <label className="notebook-picker-label" htmlFor="notebook-select">
        Manual
      </label>
      <select
        id="notebook-select"
        value={active?.id ?? ""}
        disabled={busy}
        onChange={(e) => void onPick(e.target.value)}
      >
        {/* Honest empty state when the configured id isn't among the listed
            notebooks — a controlled select would otherwise silently show the
            first option as if it were active. */}
        {!active && (
          <option value="" disabled>
            Select a manual…
          </option>
        )}
        {notebooks.map((n) => (
          <option key={n.id} value={n.id}>
            {n.title}
          </option>
        ))}
      </select>
      {note && <span className="notebook-picker-note">{note}</span>}
    </div>
  );
}
