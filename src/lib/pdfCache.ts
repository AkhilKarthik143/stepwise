// Manual PDFs, cached on the server's disk. The first request for a manual downloads the whole
// file from lego.com / ikea.com (fast from the data center); after that every phone gets byte
// ranges straight from disk, so pdf.js can show page 1 without the phone pulling ~20 MB.
// Server-only. The cache lives until the container restarts.

import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = path.join(tmpdir(), "buildsight-pdfs");
const MAX_BYTES = 120 * 1024 * 1024;

// Only LEGO's instruction CDN and IKEA's site, so this can't be used to fetch arbitrary URLs.
export function upstreamUrl(parts: string[]): string | null {
  const [source, ...rest] = parts;
  const tail = rest.join("/");
  if (!tail.endsWith(".pdf") || !/^[\w./-]+$/.test(tail) || tail.includes("..")) return null;
  if (source === "lego" && rest.length === 1) return `https://www.lego.com/cdn/product-assets/product.bi.core.pdf/${tail}`;
  if (source === "ikea") return `https://www.ikea.com/${tail}`;
  return null;
}

const downloads = new Map<string, Promise<{ file: string; size: number }>>();

/** Path and size of the cached copy, downloading it first if needed. Concurrent callers share one download. */
export function cachedPdf(url: string): Promise<{ file: string; size: number }> {
  let job = downloads.get(url);
  if (!job) {
    job = (async () => {
      const file = path.join(DIR, `${createHash("sha1").update(url).digest("hex")}.pdf`);
      const existing = await stat(file).catch(() => null);
      if (existing) return { file, size: existing.size };
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 BuildSight" } });
      if (!res.ok) throw new Error(`Manual download failed (${res.status}).`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_BYTES) throw new Error("That manual is too big.");
      if (bytes.subarray(0, 4).toString() !== "%PDF") throw new Error("That link didn't return a PDF.");
      await mkdir(DIR, { recursive: true });
      const partial = `${file}.${process.pid}.part`;
      await writeFile(partial, bytes);
      await rename(partial, file);
      return { file, size: bytes.length };
    })();
    job.catch(() => downloads.delete(url)); // a failed download can be retried
    downloads.set(url, job);
  }
  return job;
}

/** Parses a single "bytes=start-end" range. Returns null for no range or one we can't satisfy. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number, end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2])); // last N bytes
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}
