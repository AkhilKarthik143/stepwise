// The browsable catalog, built by scripts/build-catalog.mjs (every item verified to have instructions).

import data from "@/data/catalog.json";
import type { ManualResult } from "@/lib/manuals";

export type CatalogManual = { label: string; size?: string; pdfPath: string; coverUrl?: string };

export type CatalogItem = {
  id: string;
  source: "lego" | "ikea";
  name: string;
  category: string;
  image: string;
  manuals: CatalogManual[];
  set?: string; // LEGO
  age?: string;
  pieces?: number;
  year?: number;
  itemNo?: string; // IKEA
};

// Display order for category chips (unknown categories go last).
const ORDER = [
  "Creator", "City", "Technic", "Star Wars", "Harry Potter", "Minecraft", "Friends", "Icons", "Botanicals", "Ideas", "Architecture", "Speed Champions", "Classic",
  "Tables & desks", "Storage", "Seating", "Beds", "Kids",
];
const rank = (c: string) => (ORDER.includes(c) ? ORDER.indexOf(c) : ORDER.length);

// Interleaves categories so "All" opens on a mix (a Creator set, a City set, a Technic set…).
function mixed(items: CatalogItem[]): CatalogItem[] {
  const groups = categoriesOf(items).map((c) => items.filter((i) => i.category === c));
  const out: CatalogItem[] = [];
  for (let row = 0; out.length < items.length; row++) for (const g of groups) if (g[row]) out.push(g[row]);
  return out;
}

export function categoriesOf(items: CatalogItem[]): string[] {
  return [...new Set(items.map((i) => i.category))].sort((a, b) => rank(a) - rank(b));
}

export const LEGO = mixed(data.lego as CatalogItem[]);
export const IKEA = mixed(data.ikea as CatalogItem[]);

export function matches(item: CatalogItem, q: string): boolean {
  const text = `${item.name} ${item.category} ${item.set ?? ""} ${item.itemNo ?? ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w));
}

export function metaLine(item: CatalogItem): string {
  if (item.source === "lego") return [item.set && `#${item.set}`, item.pieces && `${item.pieces.toLocaleString()} pcs`, item.age].filter(Boolean).join(" · ");
  return item.manuals.length > 1 ? `${item.manuals.length} manuals` : "Assembly manual";
}

// Turns one of an item's manuals into a library entry.
export function toResult(item: CatalogItem, manual: CatalogManual): ManualResult {
  const brand = item.source === "lego" ? `LEGO ${item.set}` : `IKEA ${item.itemNo}`;
  return {
    source: item.source,
    title: item.name,
    subtitle: item.manuals.length > 1 ? `${brand} · ${manual.label}` : brand,
    coverUrl: item.image,
    pdfPath: manual.pdfPath,
    sizeLabel: manual.size,
  };
}
