"use client";

// Packs step pictures into labeled grids ("contact sheets") so one Claude call can compare the
// camera with every step read so far. Each tile carries its step number in the top-left corner.

const COLS = 5;
const ROWS = 4;
const TILE_W = 200;
const TILE_H = 160;

async function load(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

export async function contactSheets(tiles: { number: number; image: string }[]): Promise<{ image: string; numbers: number[] }[]> {
  const sheets: { image: string; numbers: number[] }[] = [];
  for (let start = 0; start < tiles.length; start += COLS * ROWS) {
    const group = tiles.slice(start, start + COLS * ROWS);
    const rows = Math.ceil(group.length / COLS);
    const canvas = document.createElement("canvas");
    canvas.width = COLS * TILE_W;
    canvas.height = rows * TILE_H;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const [i, tile] of group.entries()) {
      const x = (i % COLS) * TILE_W;
      const y = Math.floor(i / COLS) * TILE_H;
      try {
        const img = await load(tile.image);
        const scale = Math.min((TILE_W - 8) / img.width, (TILE_H - 8) / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, x + (TILE_W - w) / 2, y + (TILE_H - h) / 2, w, h);
      } catch {
        // a picture that won't decode leaves its tile blank
      }
      ctx.strokeStyle = "#cccccc";
      ctx.strokeRect(x + 0.5, y + 0.5, TILE_W - 1, TILE_H - 1);
      ctx.fillStyle = "#111111";
      ctx.fillRect(x, y, 44, 26);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText(String(tile.number), x + 6, y + 19);
    }
    sheets.push({ image: canvas.toDataURL("image/jpeg", 0.8), numbers: group.map((t) => t.number) });
  }
  return sheets;
}
