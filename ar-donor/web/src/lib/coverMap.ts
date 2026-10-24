/**
 * object-fit:cover coordinate mapping — pure math, unit-tested.
 *
 * Gemini's boxes are normalized 0-1000 over the camera FRAME; the on-screen
 * video is scale-to-fill + centre-cropped (`object-fit: cover`). Mapping a
 * normalized image coordinate to viewport percent must go through the SAME
 * cover transform, or every highlight shifts by the crop amount whenever the
 * viewport aspect differs from the camera's.
 */
export function coverMap(
  nx: number,
  ny: number,
  cw: number,
  ch: number,
  iw: number,
  ih: number
): { x: number; y: number } {
  if (!iw || !ih || !cw || !ch) return { x: nx * 100, y: ny * 100 }; // identity until video known
  const scale = Math.max(cw / iw, ch / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const ox = (cw - dw) / 2; // negative => cropped horizontally
  const oy = (ch - dh) / 2; // negative => cropped vertically
  return { x: ((ox + nx * dw) / cw) * 100, y: ((oy + ny * dh) / ch) * 100 };
}
