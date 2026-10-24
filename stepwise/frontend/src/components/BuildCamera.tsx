import { useEffect, useRef, useState } from "react";

// Stillness trigger tuning. The frame is shrunk to 64x48 grayscale and compared with the last
// one: mean absolute difference above MOTION means hands are moving; below STILL for STILL_MS
// after some motion means hands left and the build is at rest, so it's worth one check.
const SAMPLE_MS = 250;
const MOTION = 10;
const STILL = 3.5;
const STILL_MS = 1500;
const COOLDOWN_MS = 3000;

export type FrameGrabber = () => string | null; // base64 JPEG, no data: prefix

interface Props {
  onStill: (jpegB64: string) => void;
  registerGrabber: (grab: FrameGrabber | null) => void;
  stillnessEnabled: boolean;
}

// Rear camera, looking down at the build. Also the source of every frame the server sees.
export function BuildCamera({ onStill, registerGrabber, stillnessEnabled }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [motion, setMotion] = useState<"moving" | "still">("still");
  const onStillRef = useRef(onStill);
  onStillRef.current = onStill;

  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
      .then((s) => {
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch((e: Error) => setError(location.protocol === "https:" || location.hostname === "localhost" ? e.message : "The camera needs an https:// address on phones."));
    if (!navigator.mediaDevices) setError("This browser can't open the camera.");
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(() => {
    const grab: FrameGrabber = () => (video.current ? grabFull(video.current) : null);
    registerGrabber(grab);
    return () => registerGrabber(null);
  }, [registerGrabber]);

  useEffect(() => {
    if (!stillnessEnabled) return;
    const small = document.createElement("canvas");
    small.width = 64;
    small.height = 48;
    const ctx = small.getContext("2d", { willReadFrequently: true })!;
    let prev: Uint8ClampedArray | null = null;
    let sawMotion = false;
    let stillSince = 0;
    let lastFired = 0;
    const id = window.setInterval(() => {
      const v = video.current;
      if (!v || v.readyState < 2) return;
      ctx.drawImage(v, 0, 0, 64, 48);
      const px = ctx.getImageData(0, 0, 64, 48).data;
      if (prev) {
        let diff = 0;
        for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] + px[i + 1] + px[i + 2] - prev[i] - prev[i + 1] - prev[i + 2]) / 3;
        diff /= px.length / 4;
        const now = Date.now();
        if (diff > MOTION) {
          sawMotion = true;
          stillSince = 0;
          setMotion("moving");
        } else if (diff < STILL) {
          setMotion("still");
          if (!stillSince) stillSince = now;
          if (sawMotion && now - stillSince >= STILL_MS && now - lastFired >= COOLDOWN_MS) {
            sawMotion = false;
            lastFired = now;
            const frame = grabFull(v);
            if (frame) onStillRef.current(frame);
          }
        }
      }
      prev = px.slice();
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [stillnessEnabled]);

  return (
    <div className="bs-camera">
      <video ref={video} autoPlay playsInline muted />
      {error && <div className="bs-camera-error">{error}</div>}
      <span className={`bs-motion bs-motion--${motion}`}>{motion === "moving" ? "hands moving" : "watching"}</span>
    </div>
  );
}

function grabFull(v: HTMLVideoElement): string | null {
  if (v.readyState < 2 || !v.videoWidth) return null;
  const c = document.createElement("canvas");
  const scale = Math.min(1, 1024 / v.videoWidth);
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8).split(",")[1] ?? null;
}
