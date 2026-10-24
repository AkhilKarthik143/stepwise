import { createAudioPlayer, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream, type AudioPlayer, type AudioStreamBuffer } from "expo-audio";
import * as Speech from "expo-speech";
import { useCallback, useEffect, useRef, useState } from "react";
import { type VoiceMode, httpBase } from "./protocol";

const TARGET_RATE = 16000; // the backend's Cartesia Ink stream expects 16 kHz PCM16 mono

// Linear resample when the hardware can't deliver 16 kHz (common on iOS: 48 kHz).
function toTargetRate(buf: AudioStreamBuffer): ArrayBuffer {
  const src = new Int16Array(buf.data);
  const channels = buf.channels || 1;
  const mono = channels === 1 ? src : Int16Array.from({ length: Math.floor(src.length / channels) }, (_, i) => src[i * channels]);
  if (buf.sampleRate === TARGET_RATE) return mono.buffer.slice(mono.byteOffset, mono.byteOffset + mono.byteLength) as ArrayBuffer;
  const ratio = buf.sampleRate / TARGET_RATE;
  const out = new Int16Array(Math.floor(mono.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    out[i] = Math.round(mono[j] * (1 - frac) + (mono[j + 1] ?? mono[j]) * frac);
  }
  return out.buffer as ArrayBuffer;
}

interface Options {
  serverUrl: string;
  voiceIn: VoiceMode;
  voiceOut: VoiceMode;
  sendPcm: (pcm: ArrayBuffer) => void;
}

// Voice in: stream the mic as PCM over the socket; the server's Cartesia Ink turn detection
// decides when the technician is done. Voice out: Cartesia Sonic from /api/tts, or the
// phone's own speech engine when the server has no Cartesia key.
export function useVoice({ serverUrl, voiceIn, voiceOut, sendPcm }: Options) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(false);
  const player = useRef<AudioPlayer | null>(null);
  const sendRef = useRef(sendPcm);
  sendRef.current = sendPcm;

  const { stream } = useAudioStream({
    sampleRate: TARGET_RATE,
    channels: 1,
    encoding: "int16",
    onBuffer: (buf) => {
      // No echo cancellation on the raw stream, so don't let STEPWISE hear itself.
      if (!speakingRef.current) sendRef.current(toTargetRate(buf));
    },
  });

  const canListen = voiceIn === "cartesia" || voiceIn === "qwen";

  const startListening = useCallback(async () => {
    if (!canListen) throw new Error("Voice input needs a Cartesia key on the server. Use the buttons or type for now.");
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) throw new Error("Microphone permission was denied.");
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await stream.start();
    setListening(true);
  }, [canListen, stream]);

  const stopListening = useCallback(() => {
    stream.stop();
    setListening(false);
  }, [stream]);

  const setSpeakingBoth = (v: boolean) => {
    speakingRef.current = v;
    setSpeaking(v);
  };

  const stopSpeaking = useCallback(() => {
    player.current?.pause();
    player.current?.remove();
    player.current = null;
    void Speech.stop();
    setSpeakingBoth(false);
  }, []);

  const speakOnDevice = useCallback((text: string) => {
    setSpeakingBoth(true);
    Speech.speak(text, { rate: 1.0, onDone: () => setSpeakingBoth(false), onStopped: () => setSpeakingBoth(false), onError: () => setSpeakingBoth(false) });
  }, []);

  const speak = useCallback((text: string) => {
    if (!text.trim()) return;
    stopSpeaking();
    if (voiceOut !== "cartesia") {
      speakOnDevice(text);
      return;
    }
    const p = createAudioPlayer({ uri: `${httpBase(serverUrl)}/api/tts?text=${encodeURIComponent(text)}` });
    player.current = p;
    setSpeakingBoth(true);
    let started = false;
    const sub = p.addListener("playbackStatusUpdate", (status) => {
      if (status.playing) started = true;
      if (status.didJustFinish) {
        sub.remove();
        setSpeakingBoth(false);
      }
    });
    p.play();
    // If Cartesia fails (bad key, network), don't leave the technician in silence.
    setTimeout(() => {
      if (!started && player.current === p) {
        sub.remove();
        stopSpeaking();
        speakOnDevice(text);
      }
    }, 6000);
  }, [serverUrl, voiceOut, stopSpeaking, speakOnDevice]);

  useEffect(() => () => {
    stream.stop();
    stopSpeaking();
  }, [stream, stopSpeaking]);

  return { listening, speaking, canListen, startListening, stopListening, speak, stopSpeaking };
}
