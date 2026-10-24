// Browser speech fallback for when the server has no Cartesia (or Qwen) voice configured.
// Voice in: Web Speech API recognition, each final phrase sent as a text turn.
// Voice out: speechSynthesis. Recognition pauses while speaking so it never hears itself.

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
  start: () => void;
  stop: () => void;
};

function recognitionCtor(): (new () => Recognition) | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function browserSpeechSupported(): { listen: boolean; speak: boolean } {
  return { listen: recognitionCtor() !== null, speak: "speechSynthesis" in window };
}

export class BrowserListener {
  private rec: Recognition | null = null;
  private wanted = false;
  private paused = false;

  constructor(private readonly onFinal: (text: string) => void, private readonly onPartial: (text: string) => void) {}

  start(): void {
    const Ctor = recognitionCtor();
    if (!Ctor) throw new Error("Speech recognition isn't supported in this browser. Use Chrome, or type below.");
    this.wanted = true;
    this.rec = new Ctor();
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.lang = "en-US";
    this.rec.onresult = (e: any) => {
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript.trim();
        if (e.results[i].isFinal) {
          if (text) this.onFinal(text);
        } else partial += text;
      }
      this.onPartial(partial);
    };
    // Chrome ends recognition after silence; restart while the mic is meant to be on.
    this.rec.onend = () => { if (this.wanted && !this.paused) this.safeStart(); };
    this.rec.onerror = () => {};
    this.safeStart();
  }

  stop(): void {
    this.wanted = false;
    this.rec?.stop();
    this.rec = null;
  }

  pause(): void {
    this.paused = true;
    this.rec?.stop();
  }

  resume(): void {
    this.paused = false;
    if (this.wanted) this.safeStart();
  }

  private safeStart(): void {
    try { this.rec?.start(); } catch { /* already started */ }
  }
}

export function speak(text: string, listener: BrowserListener | null): void {
  if (!("speechSynthesis" in window) || !text.trim()) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  u.onstart = () => listener?.pause();
  u.onend = () => listener?.resume();
  u.onerror = () => listener?.resume();
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
