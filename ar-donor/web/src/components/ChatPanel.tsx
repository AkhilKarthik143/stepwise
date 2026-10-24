import { useEffect, useRef, useState } from "react";
import {
  type ChatTurn,
  sendChat,
  recognizeImage,
  generateImage,
  fileToDataUrl,
  toHistory,
} from "../lib/chatApi";

/**
 * Typed chat lane (separate from the live voice call): send text and/or a photo,
 * get answers from Gemini, generate an image from a prompt, and run the NVIDIA
 * recognizer on an attached photo on demand. A right-side drawer; full-screen on
 * phones. Auth + all endpoints go through the shared api helpers.
 */
export function ChatPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  if (!visible) return null;

  const push = (t: ChatTurn) => setTurns((prev) => [...prev, t]);

  const onAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!f) return;
    try {
      setAttached(await fileToDataUrl(f));
    } catch {
      setError("Couldn't read that image.");
    }
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && !attached) || busy) return;
    const image = attached;
    setInput("");
    setAttached(undefined);
    setError("");
    push({ role: "user", text, image });
    setBusy(true);
    try {
      const reply = await sendChat(text, image, toHistory(turns));
      push({ role: "assistant", text: reply });
    } catch (e) {
      push({ role: "assistant", text: e instanceof Error ? e.message : "Chat failed.", error: true });
    } finally {
      setBusy(false);
    }
  };

  const genImage = async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setInput("");
    setError("");
    push({ role: "user", text: `🖼️ Generate: ${prompt}` });
    setBusy(true);
    try {
      const url = await generateImage(prompt);
      push({ role: "assistant", text: "", genImage: url });
    } catch (e) {
      push({ role: "assistant", text: e instanceof Error ? e.message : "Image generation failed.", error: true });
    } finally {
      setBusy(false);
    }
  };

  const detect = async (image: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const detections = await recognizeImage(image);
      push({ role: "assistant", text: `🔍 NVIDIA detection:\n${detections}` });
    } catch (e) {
      push({ role: "assistant", text: e instanceof Error ? e.message : "Detection failed.", error: true });
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="chat" role="dialog" aria-label="Assistant chat">
      <header className="chat__top">
        <span className="chat__title">Chat</span>
        <button className="chat__close" onClick={onClose} aria-label="Close chat" title="Close">
          ✕
        </button>
      </header>

      <div className="chat__log" ref={scrollRef}>
        {turns.length === 0 && (
          <p className="chat__hint">
            Ask a question, attach a photo, or type a prompt and tap 🖼️ to generate an image.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`chat__msg chat__msg--${t.role}${t.error ? " chat__msg--err" : ""}`}>
            {t.image && <img className="chat__img" src={t.image} alt="attachment" />}
            {t.text && <div className="chat__text">{t.text}</div>}
            {t.genImage && <img className="chat__img chat__img--gen" src={t.genImage} alt="generated" />}
            {t.role === "user" && t.image && (
              <button className="chat__detect" onClick={() => detect(t.image!)} disabled={busy}>
                🔍 Detect (NVIDIA)
              </button>
            )}
          </div>
        ))}
        {busy && <div className="chat__msg chat__msg--assistant chat__typing">…</div>}
      </div>

      {error && <div className="chat__error" role="alert">{error}</div>}
      {attached && (
        <div className="chat__attach">
          <img src={attached} alt="attached" />
          <button onClick={() => setAttached(undefined)} aria-label="Remove image">✕</button>
        </div>
      )}

      <div className="chat__compose">
        <button className="chat__icon" onClick={() => fileRef.current?.click()} title="Attach a photo" disabled={busy}>
          📎
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onAttach} />
        <textarea
          className="chat__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Message…  (Enter to send)"
          rows={1}
        />
        <button className="chat__icon" onClick={genImage} title="Generate an image from the text" disabled={busy || !input.trim()}>
          🖼️
        </button>
        <button className="chat__send" onClick={send} disabled={busy || (!input.trim() && !attached)}>
          Send
        </button>
      </div>
    </div>
  );
}
