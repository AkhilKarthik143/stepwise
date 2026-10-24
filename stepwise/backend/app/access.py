"""Passcode lock for a public deployment (``APP_PASSCODE``).

Every page, API call and the WebSocket need the access cookie, which ``/unlock`` sets after the
right passcode. The API keys never reach the browser either way; the lock stops strangers with
the link from spending them. ``/healthz`` stays open for the host's health checks and uptime
pings. With ``APP_PASSCODE`` unset there is no lock (local dev).
"""

from __future__ import annotations

import hashlib
import hmac
import json
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, quote

COOKIE = "bs_access"
OPEN_PATHS = {"/healthz", "/unlock", "/api/unlock"}
MAX_AGE = 30 * 24 * 3600


def token_for(passcode: str) -> str:
    return hashlib.sha256(f"buildsight:{passcode}".encode()).hexdigest()


UNLOCK_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>BuildSight</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#071018;color:#e8f1f5;font-family:system-ui,-apple-system,sans-serif}
form{display:grid;gap:12px;width:min(320px,calc(100vw - 32px))}h1{margin:0;font-size:22px}p{margin:0;color:#8fa6b4;font-size:14px}
input,button{min-height:48px;border-radius:8px;font-size:16px;padding:0 12px}input{border:1px solid rgba(160,207,225,.25);background:#0d1821;color:#e8f1f5}
button{border:0;background:#65d9ff;color:#071018;font-weight:700}.err{color:#ff6d6d}
</style></head><body><form method="post" action="/api/unlock"><h1>BuildSight</h1><p>Enter the team passcode.</p>
__ERROR__<input type="password" name="passcode" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="__NEXT__"><button type="submit">Unlock</button></form></body></html>"""


def unlock_page(next_path: str = "/", error: bool = False) -> str:
    safe_next = next_path if next_path.startswith("/") and not next_path.startswith("//") else "/"
    return UNLOCK_PAGE.replace("__NEXT__", quote(safe_next, safe="/#?=&")).replace(
        "__ERROR__", '<p class="err">Wrong passcode.</p>' if error else "")


class PasscodeGate:
    """Pure ASGI middleware, so it covers the WebSocket as well as HTTP."""

    def __init__(self, app, passcode: str) -> None:
        self.app = app
        self.passcode = passcode
        self.token = token_for(passcode) if passcode else ""

    def _has_access(self, scope) -> bool:
        for name, value in scope.get("headers", []):
            if name == b"cookie":
                jar = SimpleCookie()
                jar.load(value.decode("latin-1"))
                morsel = jar.get(COOKIE)
                if morsel and hmac.compare_digest(morsel.value, self.token):
                    return True
        return False

    async def __call__(self, scope, receive, send):
        if not self.passcode or scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        path = scope.get("path", "/")
        if scope["type"] == "http" and path == "/unlock":
            query = parse_qs(scope.get("query_string", b"").decode())
            return await _send_html(send, unlock_page(query.get("next", ["/"])[0]))
        if scope["type"] == "http" and path == "/api/unlock" and scope.get("method") == "POST":
            return await self._unlock(scope, receive, send)
        if path in OPEN_PATHS or self._has_access(scope):
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 4401})
        if path.startswith("/api/"):
            return await _send(send, 401, b"application/json", json.dumps({"error": "locked", "unlock": "/unlock"}).encode())
        return await _send(send, 303, b"text/plain", b"", [(b"location", f"/unlock?next={quote(path)}".encode())])

    async def _unlock(self, scope, receive, send) -> None:
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
            if len(body) > 10_000:
                break
        form = {k: v[0] for k, v in parse_qs(body.decode(errors="ignore")).items()}
        next_path = form.get("next", "/")
        if not hmac.compare_digest(form.get("passcode", "").encode(), self.passcode.encode()):
            return await _send_html(send, unlock_page(next_path, error=True), status=401)
        secure = any(n == b"x-forwarded-proto" and v == b"https" for n, v in scope.get("headers", [])) or scope.get("scheme") == "https"
        cookie = f"{COOKIE}={self.token}; Path=/; Max-Age={MAX_AGE}; HttpOnly; SameSite=Lax" + ("; Secure" if secure else "")
        target = next_path if next_path.startswith("/") and not next_path.startswith("//") else "/"
        await _send(send, 303, b"text/plain", b"", [(b"location", target.encode()), (b"set-cookie", cookie.encode())])


async def _send_html(send, html: str, status: int = 200) -> None:
    await _send(send, status, b"text/html; charset=utf-8", html.encode())


async def _send(send, status: int, content_type: bytes, body: bytes, headers: list | None = None) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", content_type), (b"content-length", str(len(body)).encode()), *(headers or [])]})
    await send({"type": "http.response.body", "body": body})
