/** Map normalized camera-image coordinates through the video's object-fit:cover transform. */
export function coverMap(nx: number, ny: number, cw: number, ch: number, iw: number, ih: number) {
  if (!iw || !ih || !cw || !ch) return { x: nx * 100, y: ny * 100 };
  const scale = Math.max(cw / iw, ch / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const ox = (cw - dw) / 2;
  const oy = (ch - dh) / 2;
  return { x: ((ox + nx * dw) / cw) * 100, y: ((oy + ny * dh) / ch) * 100 };
}

export function coverInverse(px: number, py: number, cw: number, ch: number, iw: number, ih: number) {
  if (!iw || !ih || !cw || !ch) return { x: px / cw, y: py / ch };
  const scale = Math.max(cw / iw, ch / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const ox = (cw - dw) / 2;
  const oy = (ch - dh) / 2;
  return { x: Math.max(0, Math.min(1, (px - ox) / dw)), y: Math.max(0, Math.min(1, (py - oy) / dh)) };
}
