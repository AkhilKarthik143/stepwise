// The browsable catalog: about 100 LEGO sets and 37 IKEA products, each verified to have a
// manual PDF on lego.com / ikea.com. Built by David's scripts/build-catalog.mjs in
// github.com/davidzhu314/Calhacks, converted to full PDF URLs for /api/manuals/import.

import data from "../data/catalog.json";
import type { ManualResult } from "./api";

export type Source = "lego" | "ikea";
export interface CatalogManual { label: string; size?: string; pdf_url: string; cover?: string }
export interface CatalogItem {
  id: string;
  name: string;
  category: string;
  image: string;
  manuals: CatalogManual[];
  set?: string; // LEGO
  pieces?: number;
  age?: string;
  itemNo?: string; // IKEA
}

// Display order for category chips (unknown categories go last).
const ORDER = [
  "Creator", "City", "Technic", "Star Wars", "Harry Potter", "Minecraft", "Friends", "Icons", "Botanicals", "Ideas", "Architecture", "Speed Champions", "Classic",
  "Tables & desks", "Storage", "Seating", "Beds", "Kids",
];
const rank = (c: string) => (ORDER.includes(c) ? ORDER.indexOf(c) : ORDER.length);

export function categoriesOf(items: CatalogItem[]): string[] {
  return [...new Set(items.map((i) => i.category))].sort((a, b) => rank(a) - rank(b));
}

// Interleaves categories so "All" opens on a mix instead of ten Creator sets in a row.
function mixed(items: CatalogItem[]): CatalogItem[] {
  const groups = categoriesOf(items).map((c) => items.filter((i) => i.category === c));
  const out: CatalogItem[] = [];
  for (let row = 0; out.length < items.length; row++) for (const g of groups) if (g[row]) out.push(g[row]);
  return out;
}

export const CATALOG: Record<Source, CatalogItem[]> = {
  lego: mixed(data.lego as CatalogItem[]),
  ikea: mixed(data.ikea as CatalogItem[]),
};

export function matches(item: CatalogItem, q: string): boolean {
  const text = `${item.name} ${item.category} ${item.set ?? ""} ${item.itemNo ?? ""}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.includes(w));
}

export function metaLine(item: CatalogItem): string {
  if (item.set) return [`#${item.set}`, item.pieces && `${item.pieces.toLocaleString()} pcs`, item.age].filter(Boolean).join(" · ");
  return item.manuals.length > 1 ? `${item.manuals.length} manuals` : "Assembly manual";
}

export function toResult(item: CatalogItem, manual: CatalogManual): ManualResult {
  const brand = item.set ? `LEGO ${item.set}` : `IKEA ${item.itemNo}`;
  return {
    source: item.set ? "lego" : "ikea",
    // Multi-book sets get one build per book, so the title says which.
    title: item.manuals.length > 1 ? `${item.name} (${manual.label})` : item.name,
    subtitle: brand,
    cover_url: manual.cover ?? item.image,
    pdf_url: manual.pdf_url,
    size_label: manual.size,
  };
}
