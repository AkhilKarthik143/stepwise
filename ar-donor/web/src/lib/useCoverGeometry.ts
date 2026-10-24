import { useEffect, useState } from "react";

/**
 * Track the viewport size + the camera video's intrinsic size, for mapping
 * Gemini's 0-1000 image-space boxes onto the `object-fit: cover` video via
 * coverMap. Shared by every camera-anchored overlay (annotations, the anchored
 * diagram) so they agree on the exact geometry — the `videoId` is the contract.
 */
export interface CoverGeometry {
  cw: number;
  ch: number;
  iw: number;
  ih: number;
}

export function useCoverGeometry(videoId: string): CoverGeometry {
  const [geo, setGeo] = useState<CoverGeometry>({ cw: 0, ch: 0, iw: 0, ih: 0 });
  useEffect(() => {
    const read = () => {
      const v = document.getElementById(videoId) as HTMLVideoElement | null;
      const next = {
        cw: window.innerWidth,
        ch: window.innerHeight,
        iw: v?.videoWidth ?? 0,
        ih: v?.videoHeight ?? 0,
      };
      setGeo((g) =>
        g.cw === next.cw && g.ch === next.ch && g.iw === next.iw && g.ih === next.ih ? g : next
      );
    };
    read();
    window.addEventListener("resize", read);
    const v = document.getElementById(videoId) as HTMLVideoElement | null;
    v?.addEventListener("loadedmetadata", read);
    v?.addEventListener("resize", read);
    // The video may mount/change resolution after us (camera grant settles late);
    // re-read on an interval (no-op setState when unchanged) until it's stable.
    const iv = window.setInterval(read, 1000);
    return () => {
      window.removeEventListener("resize", read);
      v?.removeEventListener("loadedmetadata", read);
      v?.removeEventListener("resize", read);
      window.clearInterval(iv);
    };
  }, [videoId]);
  return geo;
}
