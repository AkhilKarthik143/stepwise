#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu box (AWS Lightsail / EC2 / any Ubuntu).
# Designed to be pasted into Lightsail's browser SSH. Installs Docker, clones the
# repo, and (once you've filled deploy/.env) starts the app + Caddy with HTTPS.
#
# Run it TWICE:
#   1st run -> installs Docker + clones repo + creates deploy/.env from template,
#              then stops so you can edit it.
#   edit    -> nano ~/ar-technician-assistant/deploy/.env   (fill every value)
#   2nd run -> builds + starts everything (HTTPS comes up within ~1 min).
set -euo pipefail

REPO_URL="https://github.com/omer-izhaki/-ar-technician-assistant.git"
APP_DIR="$HOME/ar-technician-assistant"

echo "==> Installing git + Docker…"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl
# Docker's official installer gives docker-ce + the `docker compose` plugin on
# Ubuntu (the distro `docker-compose-v2` package isn't on every release).
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo systemctl enable --now docker || true

echo "==> Cloning / updating the repo…"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only || true
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR/deploy"

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "============================================================"
  echo " Created deploy/.env. EDIT IT NOW:"
  echo "   nano $APP_DIR/deploy/.env"
  echo " Fill APP_DOMAIN + the secrets (copy from Render), then re-run:"
  echo "   bash $APP_DIR/deploy/lightsail-setup.sh"
  echo "============================================================"
  exit 0
fi

echo "==> Building + starting app + Caddy (HTTPS)…"
sudo docker compose up -d --build
echo
echo "==> Up. Caddy is fetching HTTPS for your APP_DOMAIN (give it ~1 min)."
echo "    Watch logs:   sudo docker compose -f $APP_DIR/deploy/docker-compose.yml logs -f"
echo "    Health check: curl -s https://\$APP_DOMAIN/health"
