import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal, dependency-free typing for the one Node global we read at build time
// (APP_BASE). Avoids pulling @types/node into a deliberately lean toolchain; the
// real `process` is provided by Node when Vite evaluates this config.
declare const process: { env: Record<string, string | undefined> };

// Base path for built asset URLs:
//   - DEFAULT "/static/" — the all-in-one deploy where FastAPI serves the app
//     under its StaticFiles mount ("/" -> static/index.html, "/static/*" ->
//     assets). `npm run build` emits to web/dist; web/deploy.sh copies dist/*
//     into ../static (see web/README.md).
//   - APP_BASE="/" — a standalone static host (Vercel) that serves the SPA at
//     the domain root. Vercel sets APP_BASE=/ at build time (see vercel.json),
//     so the same source produces root-relative asset URLs there.
export default defineConfig({
  plugins: [react()],
  base: process.env.APP_BASE || "/static/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    // NO manualChunks. The 3D stack (three / r3f / xr / uikit / drei) is reached
    // ONLY through the dynamic import() of <Scene>, so Rollup automatically emits
    // it as async chunks loaded after first paint. A manual vendor split is a trap
    // here: it co-locates Vite's __vitePreload helper into the vendor chunk, which
    // the entry must import synchronously — that drags three back onto the eager
    // path and defeats the whole lazy boundary. Let the dynamic import do the work.
    //
    // The emulator + its synthetic room meshes are large but dev-only dynamic
    // chunks (never fetched in production: emulate:false), so raise the warn line.
    chunkSizeWarningLimit: 1800,
  },
  server: {
    port: 5173,
    // Dev (npm run dev) proxies signaling/health/ICE to the FastAPI backend.
    proxy: {
      "/offer": "http://localhost:8443",
      "/health": "http://localhost:8443",
      "/login": "http://localhost:8443",
      "/ice-config": "http://localhost:8443",
      "/notebooks": "http://localhost:8443", // covers /notebooks/switch too
      "/chat": "http://localhost:8443",
      "/recognize": "http://localhost:8443",
      "/generate-image": "http://localhost:8443",
      "/solutions": "http://localhost:8443",
    },
  },
});
