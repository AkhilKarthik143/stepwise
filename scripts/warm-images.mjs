// Pre-warms the image optimizer cache for every catalog photo, so the first visitor after a deploy
// doesn't wait for each full-size LEGO/IKEA photo to be downloaded and resized.
// Run after deploying: node scripts/warm-images.mjs https://calhacks-tawny.vercel.app

import { readFileSync } from "node:fs";

const base = (process.argv[2] ?? "https://calhacks-tawny.vercel.app").replace(/\/$/, "");
const WIDTHS = [384, 640, 828]; // what phones and laptops request for the card sizes we use
const catalog = JSON.parse(readFileSync("src/data/catalog.json", "utf8"));
const photos = [...catalog.lego, ...catalog.ikea].map((i) => i.image.split("?")[0]);
const jobs = photos.flatMap((url) => WIDTHS.map((w) => `${base}/_next/image?url=${encodeURIComponent(url)}&w=${w}&q=75`));

let done = 0;
let failed = 0;
let next = 0;
const started = Date.now();
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next < jobs.length) {
      const url = jobs[next++];
      const res = await fetch(url, { headers: { Accept: "image/avif,image/webp,*/*" } }).catch(() => null);
      if (res?.ok) await res.arrayBuffer();
      else failed++;
      if (++done % 50 === 0) console.log(`${done}/${jobs.length}`);
    }
  }),
);
console.log(`Warmed ${done - failed}/${jobs.length} images in ${((Date.now() - started) / 1000).toFixed(0)} s (${failed} failed).`);
