// Manual PDFs, cached on the server's disk. The first request for a manual downloads the whole
// file from lego.com / ikea.com (fast from the data center); after that every phone gets byte
// ranges straight from disk, so pdf.js can show page 1 without the phone pulling ~20 MB.
// Server-only. The cache lives until the container restarts. Downloads stream to disk (the
// container has little memory), and the oldest files go once the cache passes MAX_CACHE_BYTES
// (the container's disk is small too).

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DIR = path.join(tmpdir(), "buildsight-pdfs");
const MAX_BYTES = 120 * 1024 * 1024; // one manual
const MAX_CACHE_BYTES = 400 * 1024 * 1024; // all of them

// Deletes the least recently used PDFs until the cache fits.
async function evict(keep: string) {
  const names = (await readdir(DIR).catch(() => [] as string[])).filter((n) => n.endsWith(".pdf"));
  const files = await Promise.all(names.map(async (n) => ({ file: path.join(DIR, n), ...(await stat(path.join(DIR, n))) })));
  let total = files.reduce((sum, f) => sum + f.size, 0);
  for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= MAX_CACHE_BYTES) break;
    if (f.file === keep) continue;
    await rm(f.file, { force: true });
    downloads.forEach((job, url) => job.then((j) => j.file === f.file && downloads.delete(url)).catch(() => {}));
    total -= f.size;
  }
}

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
      if (!res.ok || !res.body) throw new Error(`Manual download failed (${res.status}).`);
      if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("That manual is too big.");
      await mkdir(DIR, { recursive: true });
      const partial = `${file}.${process.pid}.${Date.now()}.part`;
      let size = 0;
      try {
        const counted = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) counted.destroy(new Error("That manual is too big."));
        });
        await pipeline(counted, createWriteStream(partial));
        const head = Buffer.alloc(4);
        const fd = await open(partial);
        await fd.read(head, 0, 4, 0);
        await fd.close();
        if (head.toString() !== "%PDF") throw new Error("That link didn't return a PDF.");
        await rename(partial, file);
      } catch (e) {
        await rm(partial, { force: true });
        throw e;
      }
      await evict(file);
      return { file, size };
    })();
    job.catch(() => downloads.delete(url)); // a failed download can be retried
    downloads.set(url, job);
  }
  // Mark it recently used, so eviction keeps manuals people are building from.
  job.then(({ file }) => utimes(file, new Date(), new Date())).catch(() => {});
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
