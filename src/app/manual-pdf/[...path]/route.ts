// Serves LEGO / IKEA manual PDFs from our own domain (browsers can't fetch them from lego.com or
// ikea.com directly), with byte ranges, from the server's disk cache. See src/lib/pdfCache.ts.
// The first time a manual is asked for, requests pass straight through to lego.com / ikea.com
// (ranges included) while the server saves its own copy in the background, so nobody waits for
// the whole file.

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { cachedIfReady, parseRange, upstreamUrl } from "@/lib/pdfCache";

const HEADERS = { "Content-Type": "application/pdf", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400" };

function body(file: string, start: number, end: number) {
  return Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const url = upstreamUrl((await params).path);
  if (!url) return Response.json({ error: "Not a LEGO or IKEA manual link." }, { status: 404 });

  const header = request.headers.get("range");
  const pdf = await cachedIfReady(url);
  if (!pdf) {
    try {
      const upstream = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 BuildSight", ...(header ? { Range: header } : {}) } });
      if (!upstream.ok || !upstream.body) return Response.json({ error: `Manual download failed (${upstream.status}).` }, { status: 502 });
      const headers: Record<string, string> = { "Content-Type": "application/pdf", "Cache-Control": "no-store" };
      for (const h of ["content-length", "content-range", "accept-ranges"]) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch {
      return Response.json({ error: "Couldn't reach the manual's site." }, { status: 502 });
    }
  }

  const range = parseRange(header, pdf.size);
  if (header && !range) {
    return new Response(null, { status: 416, headers: { ...HEADERS, "Content-Range": `bytes */${pdf.size}` } });
  }
  if (range) {
    return new Response(body(pdf.file, range.start, range.end), {
      status: 206,
      headers: { ...HEADERS, "Content-Range": `bytes ${range.start}-${range.end}/${pdf.size}`, "Content-Length": String(range.end - range.start + 1) },
    });
  }
  return new Response(body(pdf.file, 0, pdf.size - 1), { headers: { ...HEADERS, "Content-Length": String(pdf.size) } });
}

export async function HEAD(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const res = await GET(request, ctx);
  return new Response(null, { status: res.status, headers: res.headers });
}
