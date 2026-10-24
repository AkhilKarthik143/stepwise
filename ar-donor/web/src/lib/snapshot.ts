import type { Annotation } from "./useWebRTC";

/**
 * Capture the current camera frame WITH the AI's marks burned in, as a .png
 * download — for the job report, or to show a colleague exactly which bolt.
 *
 * Drawing happens at the video's INTRINSIC resolution (the raw frame, not the
 * cover-cropped viewport), where Gemini's 0-1000-normalized boxes map directly:
 * px = n/1000 * frameSize. No cover math, no screen-resolution loss.
 */
const COLORS: Record<Annotation["level"], string> = {
  info: "#19c37d",
  warn: "#f4c542",
  danger: "#e5484d",
};

/** A held snapshot awaiting a user gesture to save (iOS, voice-triggered). */
export interface PendingSnapshot {
  file: File;
  url: string;
}
export interface SnapshotResult {
  ok: boolean;
  /** Set on iOS when the photo was captured but NOT delivered (no user gesture
   *  to share, and a programmatic download would navigate Safari away and kill
   *  the live session). The UI holds it and offers a tap-to-save. */
  pending?: PendingSnapshot;
}

function isIOS(): boolean {
  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports as desktop Safari ("MacIntel") but has a touch screen.
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);
}

type ShareNav = Navigator & {
  canShare?: (data?: { files?: File[] }) => boolean;
  share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
};

async function shareFile(file: File): Promise<boolean> {
  const nav = navigator as ShareNav;
  if (typeof nav.canShare === "function" && nav.canShare({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: "AR Technician snapshot" });
      return true;
    } catch {
      return false; // cancelled / no gesture
    }
  }
  return false;
}

function download(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Save a held snapshot now (from a user gesture — e.g. the "Save photo" pill).
 *  iOS: native share sheet (Save to Photos). Else: download. */
export async function saveSnapshot(file: File): Promise<boolean> {
  if (isIOS()) return shareFile(file);
  download(file);
  return true;
}

export async function captureAnnotatedSnapshot(
  videoId: string,
  annotations: Annotation[],
  fromGesture = true
): Promise<SnapshotResult> {
  const video = document.getElementById(videoId) as HTMLVideoElement | null;
  if (!video || !video.videoWidth || !video.videoHeight) return { ok: false };

  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false };

  try {
    ctx.drawImage(video, 0, 0, w, h);
  } catch {
    return { ok: false }; // tainted/blocked frame
  }

  try {
    drawMarks(ctx, annotations, w, h);
  } catch {
    return { ok: false }; // any canvas-API gap surfaces as the graceful failure path
  }

  // Async PNG encode (toBlob): no main-thread base64 inflation — matters when a
  // camera ignores `ideal: 1280` and hands us a 4K frame mid-live-call.
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, "image/png");
    } catch {
      resolve(null);
    }
  });
  if (!blob) return { ok: false };

  const d = new Date();
  const name = `snap-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(
    2,
    "0"
  )}${String(d.getSeconds()).padStart(2, "0")}.png`;

  const file = new File([blob], name, { type: "image/png" });

  // Delivery.
  //   Desktop / non-iOS: the proven <a download> (unchanged).
  //   iOS/iPadOS Safari: a programmatic <a download> is IGNORED — it navigates
  //   to the blob and TEARS DOWN the live session — so we NEVER download there.
  //   With a user gesture (the Snap button) share to "Save to Photos"; without
  //   one (a voice-triggered take_snapshot) HOLD the photo so the UI can offer a
  //   one-tap save, rather than losing it or killing the call.
  if (!isIOS()) {
    download(file);
    return { ok: true };
  }
  if (fromGesture && (await shareFile(file))) {
    return { ok: true };
  }
  return { ok: true, pending: { file, url: URL.createObjectURL(blob) } };
}

function drawMarks(
  ctx: CanvasRenderingContext2D,
  annotations: Annotation[],
  w: number,
  h: number
): void {

  // Scale stroke/font sizes with resolution so marks look right at any size.
  const u = Math.max(2, Math.round(w / 480));

  for (const a of annotations) {
    const [ymin, xmin, ymax, xmax] = a.box;
    const x1 = (Math.min(xmin, xmax) / 1000) * w;
    const y1 = (Math.min(ymin, ymax) / 1000) * h;
    const bw = (Math.abs(xmax - xmin) / 1000) * w;
    const bh = (Math.abs(ymax - ymin) / 1000) * h;
    const cx = x1 + bw / 2;
    const cy = y1 + bh / 2;
    const color = COLORS[a.level] ?? COLORS.info;

    ctx.lineJoin = "round";
    if (a.shape === "point") {
      // Pin: halo + filled dot at the centre.
      ctx.beginPath();
      ctx.arc(cx, cy, 5 * u, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 1.5 * u;
      ctx.fill();
      ctx.stroke();
    } else if (a.shape === "arrow") {
      // Downward chevron just above the centre.
      ctx.beginPath();
      ctx.moveTo(cx - 6 * u, cy - 12 * u);
      ctx.lineTo(cx + 6 * u, cy - 12 * u);
      ctx.lineTo(cx, cy - 2 * u);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 1.2 * u;
      ctx.fill();
      ctx.stroke();
    } else {
      // Box outline: dark halo stroke underneath the coloured stroke.
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.lineWidth = 3.5 * u;
      ctx.strokeRect(x1, y1, bw, bh);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * u;
      ctx.strokeRect(x1, y1, bw, bh);
    }

    // Label chip above the mark (clamped inside the frame).
    const stepTag = a.step != null ? `${a.step}. ` : "";
    const glyph = a.level === "danger" ? "▲ " : a.level === "warn" ? "! " : "";
    const text = `${stepTag}${glyph}${a.label}${a.detail ? " — " + a.detail : ""}`;
    ctx.font = `bold ${7 * u}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    const padX = 4 * u;
    const tw = Math.min(ctx.measureText(text).width, w * 0.8);
    const chipH = 11 * u;
    let chipX = Math.max(2 * u, Math.min(cx - tw / 2 - padX, w - tw - padX * 2 - 2 * u));
    let chipY = y1 - chipH - 3 * u;
    if (chipY < 2 * u) chipY = Math.min(y1 + bh + 3 * u, h - chipH - 2 * u);

    ctx.fillStyle = "rgba(8,11,15,0.85)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 * u;
    ctx.beginPath();
    // roundRect: Chrome/Edge 99+, Safari 16+, Firefox 112+. Older browsers get
    // square corners instead of an uncaught TypeError killing the whole Snap.
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(chipX, chipY, tw + padX * 2, chipH, 4 * u);
    } else {
      ctx.rect(chipX, chipY, tw + padX * 2, chipH);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f5f7fa";
    ctx.textBaseline = "middle";
    ctx.fillText(text, chipX + padX, chipY + chipH / 2, w * 0.8);
  }

  // Timestamp watermark (bottom-left) so the photo is evidence-grade. Baseline
  // set EXPLICITLY — never inherited from whatever the annotation loop last set.
  const stamp = new Date().toLocaleString();
  ctx.font = `${6 * u}px ui-monospace, Consolas, monospace`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(8,11,15,0.7)";
  const sw = ctx.measureText(stamp).width;
  ctx.fillRect(2 * u, h - 12 * u, sw + 6 * u, 10 * u);
  ctx.fillStyle = "#f5f7fa";
  ctx.fillText(stamp, 5 * u, h - 7 * u);
}
