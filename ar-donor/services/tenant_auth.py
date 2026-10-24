"""Per-user, per-company signed tokens (multi-tenant auth).

The original auth handed every user the SAME shared bearer token, which cannot
carry identity. For multi-tenant (each company with its own database) the token
must say WHO the user is and WHICH company they belong to — so every data access
can be scoped server-side.

Format (stdlib only, no new deps): base64url(json payload) + "." +
base64url(HMAC-SHA256(payload, key=API_AUTH_TOKEN)). The payload carries
{email, company, exp}. Signing key is the existing API_AUTH_TOKEN secret, so no
new secret has to be provisioned. Constant-time verification; expiry enforced.

Back-compat: callers may still present the raw shared API_AUTH_TOKEN (old stored
logins); verify_token() maps it to the "default" company so nothing breaks.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import config

TOKEN_TTL_SECONDS = 30 * 24 * 3600  # 30 days


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(payload: bytes) -> str:
    key = config.API_AUTH_TOKEN.encode("utf-8")
    return _b64(hmac.new(key, payload, hashlib.sha256).digest())


def issue_token(email: str, company: str) -> str:
    """Signed token embedding the user's identity + company."""
    payload = json.dumps(
        {
            "email": (email or "").strip().lower(),
            "company": (company or "default").strip().lower() or "default",
            "exp": int(time.time()) + TOKEN_TTL_SECONDS,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    return _b64(payload) + "." + _sign(payload)


def verify_token(token: str) -> dict | None:
    """Return {'email','company'} for a valid token, else None. Accepts the
    legacy shared API_AUTH_TOKEN (maps to the 'default' company)."""
    if not isinstance(token, str) or not token:
        return None
    if config.API_AUTH_TOKEN and hmac.compare_digest(token, config.API_AUTH_TOKEN):
        return {"email": "", "company": "default"}  # legacy shared token
    if "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    try:
        payload = _unb64(body)
    except Exception:  # noqa: BLE001
        return None
    if not hmac.compare_digest(sig, _sign(payload)):
        return None
    try:
        data = json.loads(payload)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict) or int(data.get("exp", 0)) < time.time():
        return None
    email = str(data.get("email") or "")
    company = str(data.get("company") or "default") or "default"
    return {"email": email, "company": company}
