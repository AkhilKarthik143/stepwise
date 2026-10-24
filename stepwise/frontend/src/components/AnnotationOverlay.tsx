import { useEffect, useMemo, useState, type PointerEvent } from "react";
import type { ARAnnotationMsg } from "../lib/api";
import { coverInverse, coverMap } from "../lib/coverMap";

type Box = [number, number, number, number];

export function AnnotationOverlay({
  annotations,
  onConfirmAnchor,
}: {
  annotations: ARAnnotationMsg[];
  onConfirmAnchor: (componentId: string, box: Box) => void;
}) {
  const [geometry, setGeometry] = useState({ cw: 0, ch: 0, iw: 0, ih: 0 });

  useEffect(() => {
    const read = () => {
      const video = document.getElementById("stepwise-camera") as HTMLVideoElement | null;
      const box = video?.getBoundingClientRect();
      setGeometry({ cw: box?.width ?? 0, ch: box?.height ?? 0, iw: video?.videoWidth ?? 0, ih: video?.videoHeight ?? 0 });
    };
    read();
    window.addEventListener("resize", read);
    const video = document.getElementById("stepwise-camera");
    video?.addEventListener("loadedmetadata", read);
    video?.addEventListener("resize", read);
    const timer = window.setInterval(read, 800);
    return () => {
      window.removeEventListener("resize", read);
      video?.removeEventListener("loadedmetadata", read);
      video?.removeEventListener("resize", read);
      window.clearInterval(timer);
    };
  }, []);

  const pending = useMemo(() => annotations.find((a) => a.tracking_status === "pending" && a.component_id), [annotations]);
  const display = annotations.filter((a) => a.anchor.type === "image_bbox" && Array.isArray(a.anchor.coordinates));

  function confirm(event: PointerEvent<HTMLDivElement>) {
    if (!pending?.component_id) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = coverInverse(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, geometry.iw, geometry.ih);
    const halfW = 95;
    const halfH = 120;
    const x = Math.round(point.x * 1000);
    const y = Math.round(point.y * 1000);
    const box: Box = [Math.max(0, y - halfH), Math.max(0, x - halfW), Math.min(1000, y + halfH), Math.min(1000, x + halfW)];
    onConfirmAnchor(pending.component_id, box);
  }

  return (
    <div className="stepwise-annotation-layer" onPointerDown={pending ? confirm : undefined} role={pending ? "button" : undefined} aria-label={pending ? `Tap to confirm ${pending.label} location` : undefined}>
      {pending && <div className="stepwise-pending-anchor">Tap the camera to confirm <b>{pending.label}</b><span>location not yet verified</span></div>}
      {display.map((annotation) => {
        const [ymin, xmin, ymax, xmax] = annotation.anchor.coordinates as number[];
        const tl = coverMap(xmin / 1000, ymin / 1000, geometry.cw, geometry.ch, geometry.iw, geometry.ih);
        const br = coverMap(xmax / 1000, ymax / 1000, geometry.cw, geometry.ch, geometry.iw, geometry.ih);
        const left = Math.min(tl.x, br.x);
        const top = Math.min(tl.y, br.y);
        const width = Math.abs(br.x - tl.x);
        const height = Math.abs(br.y - tl.y);
        return (
          <div key={annotation.annotation_id} className={`stepwise-annotation stepwise-annotation--${annotation.severity} ${annotation.tracking_status === "stale" ? "stepwise-annotation--stale" : ""}`} style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}>
            <span>{annotation.label}</span>
            <small>{annotation.tracking_status === "confirmed" ? "CONFIRMED · USER TAP" : annotation.tracking_status.toUpperCase()}</small>
          </div>
        );
      })}
    </div>
  );
}
