"use client";

// Opens manual PDFs and renders pages to images, entirely in the browser.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { getPdfBytes, type Manual } from "@/lib/manuals";

let pdfjs: typeof import("pdfjs-dist") | null = null;

async function lib() {
  if (!pdfjs) {
    pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  }
  return pdfjs;
}

const open = new Map<string, Promise<PDFDocumentProxy>>();

export function openManualPdf(m: Manual): Promise<PDFDocumentProxy> {
  let doc = open.get(m.id);
  if (!doc) {
    doc = (async () => {
      const { getDocument } = await lib();
      if (m.source === "upload") {
        const bytes = await getPdfBytes(m.id);
        if (!bytes) throw new Error("This upload's file is missing. Upload it again.");
        return getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
      }
      if (!m.pdfPath) throw new Error("Manual has no PDF link.");
      // Fetch only the byte ranges the pages we render need (LEGO books are ~20 MB),
      // instead of streaming the whole file before page 1 can show.
      return getDocument({ url: m.pdfPath, disableAutoFetch: true, disableStream: true, rangeChunkSize: 1024 * 1024 }).promise;
    })();
    doc.catch(() => open.delete(m.id));
    open.set(m.id, doc);
  }
  return doc;
}

// Renders one page (1-based) to a JPEG data URL no wider than maxWidth.
export async function renderPage(doc: PDFDocumentProxy, pageNo: number, maxWidth = 1400): Promise<string> {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: maxWidth / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.85);
}
