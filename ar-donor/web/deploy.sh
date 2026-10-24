#!/usr/bin/env bash
# Build the React/r3f frontend and deploy it into ../static so FastAPI serves it
# unchanged ("/" -> static/index.html, "/static/*" -> built assets).
#
# The v1 vanilla frontend is preserved once under web/legacy/ for reference.
set -euo pipefail
cd "$(dirname "$0")"   # web/

echo "==> Building (vite)…"
npm run build

echo "==> Preserving v1 frontend under web/legacy/ (first run only)…"
mkdir -p legacy
for f in index.html app.js styles.css; do
  if [ -f "../static/$f" ] && [ ! -f "legacy/$f" ]; then
    mv "../static/$f" "legacy/$f"
    echo "    moved static/$f -> web/legacy/$f"
  fi
done

echo "==> Deploying dist/ -> ../static/ …"
rm -rf ../static/assets
cp -r dist/. ../static/

# Prune the WebXR emulator's synthetic room-mesh chunks (@iwer/sem). They are
# emitted by the build but are DEV-ONLY: production runs with emulate:false, so a
# real headset never fetches them (verified: no modulepreload, gated behind the
# emulator init). Dropping them keeps the served static dir ~5.7 MB leaner. Safe —
# these names are emulator-specific and never app assets; rm -f no-ops if absent.
echo "==> Pruning dev-only emulator assets from ../static/ …"
rm -f ../static/assets/living_room-*.js \
      ../static/assets/music_room-*.js \
      ../static/assets/meeting_room-*.js \
      ../static/assets/office_large-*.js \
      ../static/assets/office_small-*.js \
      ../static/assets/emulate-*.js 2>/dev/null || true

echo "==> Done. FastAPI now serves the React app at /."
