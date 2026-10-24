"use client";

// Full-screen camera background. Prefers the rear camera on phones.
// Exposes a capture() that returns a resized JPEG data URL for the model.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type CameraHandle = { capture: () => string | null };

const MAX_SIDE = 1024; // enough detail for bricks, small enough to send fast

const CameraFeed = forwardRef<CameraHandle>(function CameraFeed(_, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Camera needs HTTPS (or localhost). Open the deployed https:// link on your phone.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        if (video.current) video.current.srcObject = stream;
      } catch (e) {
        setError(e instanceof Error ? `Camera blocked: ${e.message}` : "Camera blocked.");
      }
    }
    start();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useImperativeHandle(ref, () => ({
    capture() {
      const v = video.current;
      if (!v || !v.videoWidth) return null;
      const scale = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(v, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.8);
    },
  }));

  return (
    <div className="absolute inset-0 bg-black">
      <video ref={video} autoPlay playsInline muted className="h-full w-full object-cover" />
      {error && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/80">
          {error}
        </div>
      )}
    </div>
  );
});

export default CameraFeed;
