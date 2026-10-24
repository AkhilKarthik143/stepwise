// Serves LEGO / IKEA manual PDFs from our own domain (browsers can't fetch them from lego.com or
// ikea.com directly), with byte ranges, from the server's disk cache. See src/lib/pdfCache.ts.

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { cachedPdf, parseRange, upstreamUrl } from "@/lib/pdfCache";

const HEADERS = { "Content-Type": "application/pdf", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400" };

function body(file: string, start: number, end: number) {
  return Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const url = upstreamUrl((await params).path);
  if (!url) return Response.json({ error: "Not a LEGO or IKEA manual link." }, { status: 404 });

  let pdf: { file: string; size: number };
  try {
    pdf = await cachedPdf(url);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Couldn't get that manual." }, { status: 502 });
  }

  const header = request.headers.get("range");
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
