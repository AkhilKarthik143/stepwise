/**
 * Base URL for backend API calls.
 *
 * Empty (default) = same-origin — local dev and the all-in-one deploy where one
 * host serves both the app and the API. Set `VITE_API_BASE` at build time (e.g.
 * `https://ar-backend.onrender.com`) when the frontend is hosted separately from
 * the backend — the Vercel frontend → Render backend split — so every API call
 * targets the backend, not the static host.
 */
const BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");

/** Resolve a backend path against the configured API base. */
export function apiUrl(path: string): string {
  return BASE + (path.startsWith("/") ? path : "/" + path);
}
