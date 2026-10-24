/**
 * Manual-provenance source titles — pure, unit-tested helpers.
 *
 * Titles are RAG/model-derived and also read back from origin-writable
 * localStorage, so every path that surfaces them re-validates here: a clean,
 * bounded string[] (trimmed, de-duped case-insensitively, capped at 3) or [].
 */
const MAX_TITLES = 3;

/** Coerce any value into a clean, bounded string[] of source titles. */
export function sanitizeTitles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TITLES) break;
  }
  return out;
}

/** Union of two title lists (existing first), de-duped + bounded. Used to
 *  accumulate provenance across MULTIPLE manual lookups in one answer turn, so a
 *  later lookup's sources never silently overwrite an earlier one's. */
export function mergeTitles(existing: string[], incoming: unknown): string[] {
  return sanitizeTitles([...existing, ...sanitizeTitles(incoming)]);
}
