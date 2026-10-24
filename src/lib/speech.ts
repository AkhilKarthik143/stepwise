"use client";

// Voice out. Cartesia Sonic through /api/tts when the server has a key; the browser's own
// text-to-speech otherwise (prefers a British male voice, for the butler feel).
// While a reply plays, the mic ignores what it hears (see isSpeaking), so the app never answers itself.

let voice: SpeechSynthesisVoice | null | undefined;
let audio: HTMLAudioElement | null = null;
let cartesiaDown = false; // set after a 503: no key on the server, stop asking
let speakingUntil = 0;
let generation = 0;

export type VoiceOut = "cartesia" | "browser";
let lastVoice: VoiceOut = "browser";
export const voiceOut = () => lastVoice;

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const prefer = ["Daniel", "Google UK English Male", "Arthur", "Oliver"];
  return (
    prefer.map((n) => voices.find((v) => v.name.startsWith(n))).find(Boolean) ??
    voices.find((v) => v.lang === "en-GB") ??
    voices.find((v) => v.lang.startsWith("en")) ??
    null
  );
}

function browserSpeak(text: string) {
  if (!("speechSynthesis" in window)) return;
  if (voice === undefined || voice === null) voice = pickVoice();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 1.05;
  speakingUntil = Date.now() + 60_000;
  u.onend = u.onerror = () => (speakingUntil = Date.now() + 400);
  window.speechSynthesis.speak(u);
  lastVoice = "browser";
}

// 0.1 s of silence as a WAV, to unlock the audio element.
function silentWav(): Blob {
  const samples = 800; // 8 kHz, 16-bit mono
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Blob([view], { type: "audio/wav" });
}

// iPhone Safari only plays audio started from a tap. Call this from any tap (the mic button,
// Check build…) and later replies can play on their own.
export function primeAudio() {
  if (typeof window === "undefined" || audio) return;
  audio = new Audio();
  audio.setAttribute("playsinline", "");
  audio.src = URL.createObjectURL(silentWav());
  audio.play().catch(() => {});
}

export async function speak(text: string) {
  if (typeof window === "undefined" || !text) return;
  const mine = ++generation;
  stopSpeaking(false);
  if (!cartesiaDown) {
    try {
      const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (res.status === 503) cartesiaDown = true;
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        if (mine !== generation) return URL.revokeObjectURL(url); // a newer reply took over
        audio ??= new Audio();
        audio.src = url;
        speakingUntil = Date.now() + 60_000;
        audio.onended = audio.onerror = () => {
          speakingUntil = Date.now() + 400;
          URL.revokeObjectURL(url);
        };
        await audio.play();
        lastVoice = "cartesia";
        return;
      }
    } catch {
      // network hiccup or autoplay blocked: fall through to the browser voice
    }
  }
  if (mine === generation) browserSpeak(text);
}

export function stopSpeaking(bump = true) {
  if (typeof window === "undefined") return;
  if (bump) generation++;
  audio?.pause();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  speakingUntil = Date.now() + 300;
}

/** True while a reply is playing (and briefly after), so the mic doesn't hear the app itself. */
export function isSpeaking() {
  return Date.now() < speakingUntil;
}
