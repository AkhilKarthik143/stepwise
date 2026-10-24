/**
 * Resolve a 3D-model asset URL so it loads correctly regardless of where the
 * app is hosted. Model assets are operator-supplied (MODEL_ASSETS_JSON, sent to
 * the browser as-is) and the app may be served at "/" (a standalone host like
 * Vercel) or under "/static/" (the all-in-one FastAPI host). A bare relative
 * path has to follow that deploy base or it 404s on one of the two.
 *
 * Rules:
 *  - Absolute URLs (`https://…`, protocol-relative `//cdn/…`) and `data:` /
 *    `blob:` URIs are returned unchanged — a CDN-hosted model is portable.
 *  - Root-absolute paths (`/static/pump.glb`) are returned unchanged: the
 *    operator made an explicit host choice; don't second-guess or double-prefix.
 *  - Bare relative paths (`models/pump.glb`) are joined onto the app's deploy
 *    base (`import.meta.env.BASE_URL`), so one catalog entry works on every host.
 */
export function resolveAssetUrl(url: string): string {
  const u = (url || "").trim();
  if (!u) return u;
  // scheme: (https:, data:, blob:, …) or protocol-relative // → pass through.
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//")) return u;
  // Explicit root-absolute path → operator's choice, leave as-is.
  if (u.startsWith("/")) return u;
  // Bare relative → resolve against the deploy base (guaranteed trailing slash).
  const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "/");
  return base + u;
}
