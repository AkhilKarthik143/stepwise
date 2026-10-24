"use client";

// Browser text-to-speech as a stand-in until Cartesia is wired in.
// Prefers a British male voice where available, for the butler feel.

let voice: SpeechSynthesisVoice | null | undefined;

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

export function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text) return;
  if (voice === undefined || voice === null) voice = pickVoice();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}
