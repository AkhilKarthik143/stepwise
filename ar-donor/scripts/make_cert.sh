#!/usr/bin/env bash
# Generate a self-signed TLS cert for local HTTPS (required by WebXR + getUserMedia
# when accessed over LAN, e.g. from a Meta Quest 3 browser).
#
# Usage:  bash scripts/make_cert.sh [LAN_IP]
#   LAN_IP (optional) adds your machine's IP to the cert SAN so the headset can
#   reach https://<LAN_IP>:8443 without a name error.
#
# For a cert your devices actually trust (no warning page), prefer mkcert:
#   https://github.com/FiloSottile/mkcert  ->  mkcert localhost 127.0.0.1 <LAN_IP>
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p certs

LAN_IP="${1:-}"
SAN="DNS:localhost,IP:127.0.0.1"
if [ -n "$LAN_IP" ]; then
  SAN="${SAN},IP:${LAN_IP}"
fi

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=${SAN}"

echo "Created certs/cert.pem and certs/key.pem (SAN: ${SAN})"
echo "Set SSL_CERTFILE=certs/cert.pem and SSL_KEYFILE=certs/key.pem in your .env"
