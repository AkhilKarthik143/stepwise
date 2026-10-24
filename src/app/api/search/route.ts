// Manual search. LEGO: by set number, scraped from lego.com's building-instructions page.
// IKEA: by product name, via IKEA's public search, then each product page's assembly PDFs.
// PDFs are returned as same-origin paths (see rewrites in next.config.ts).

import type { ManualResult } from "@/lib/manuals";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim();

async function searchLego(setNumber: string): Promise<ManualResult[]> {
  const res = await fetch(`https://www.lego.com/en-us/service/buildinginstructions/${setNumber}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) return [];
  const html = await res.text();

  // Each book card: <h3>Name (1/3)</h3><p>19.96MB (PDF)</p></div><a href=".../123.pdf"
  const card = /<h3[^>]*>([^<]+)<\/h3><p[^>]*>([^<]*)<\/p><\/div><a href="https:\/\/www\.lego\.com\/cdn\/product-assets\/product\.bi\.core\.pdf\/(\d+)\.pdf"/g;
  const results: ManualResult[] = [];
  for (const [, rawName, size, fileId] of html.matchAll(card)) {
    const name = decode(rawName);
    const book = name.match(/\((\d+)\/(\d+)\)\s*$/);
    const title = name.replace(/\s*\(\d+\/\d+\)\s*$/, "");
    results.push({
      source: "lego",
      title,
      subtitle: `LEGO ${setNumber}${book ? ` · Book ${book[1]} of ${book[2]}` : ""}`,
      coverUrl: `https://www.lego.com/cdn/product-assets/product.bi.core.img/${fileId}.png?format=webply&fit=crop&quality=75&width=400&height=400`,
      pdfPath: `/manual-pdf/lego/${fileId}.pdf`,
      sizeLabel: decode(size).replace(/\s*\(PDF\)/i, ""),
    });
  }
  return results;
}

type IkeaItem = { product?: { name?: string; typeName?: string; itemNo?: string; pipUrl?: string; mainImageUrl?: string } };

async function searchIkea(q: string): Promise<ManualResult[]> {
  const url = `https://sik.search.blue.cdtapps.com/us/en/search-result-page?q=${encodeURIComponent(q)}&size=8&types=PRODUCT`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const data = await res.json();
  const items: IkeaItem[] = data?.searchResultPage?.products?.main?.items ?? [];

  const perProduct = await Promise.all(
    items.slice(0, 6).map(async ({ product: p }) => {
      if (!p?.pipUrl?.startsWith("https://www.ikea.com/")) return [];
      const page = await fetch(p.pipUrl, { headers: { "User-Agent": UA } }).catch(() => null);
      if (!page?.ok) return [];
      const html = await page.text();
      const all = [...new Set(html.match(/https:\/\/www\.ikea\.com\/[^"\s]*assembly_instructions\/[^"\s]+\.pdf/g) ?? [])];
      // Product pages also link manuals for related products; keep the ones named after this product.
      const slug = (p.name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const own = all.filter((u) => u.split("/assembly_instructions/")[1]?.startsWith(slug));
      const pdfs = own.length ? own : all.slice(0, 1);
      return pdfs.map((pdf, i): ManualResult => ({
        source: "ikea",
        title: `${p.name ?? "IKEA"} ${p.typeName ?? ""}`.trim(),
        subtitle: `IKEA ${p.itemNo ?? ""}${pdfs.length > 1 ? ` · Part ${i + 1} of ${pdfs.length}` : ""}`.trim(),
        coverUrl: p.mainImageUrl,
        pdfPath: `/manual-pdf/ikea/${pdf.slice("https://www.ikea.com/".length)}`,
      }));
    }),
  );
  return perProduct.flat();
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2 || q.length > 80) return Response.json({ results: [] });

  // A bare 4–7 digit number is a LEGO set; anything else searches IKEA.
  const isSetNumber = /^\d{4,7}(-\d)?$/.test(q);
  try {
    const found = isSetNumber ? await searchLego(q.replace(/-\d$/, "")) : await searchIkea(q);
    // Color variants often share one manual; show it once.
    const seen = new Set<string>();
    const results = found.filter((r) => !seen.has(r.pdfPath) && seen.add(r.pdfPath));
    return Response.json({ source: isSetNumber ? "lego" : "ikea", results });
  } catch {
    return Response.json({ error: "Search failed. Try again." }, { status: 502 });
  }
}
