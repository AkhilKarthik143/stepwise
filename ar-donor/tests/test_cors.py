"""CORS preflight contract for the cross-origin deploy (Vercel frontend ->
Render backend). When the app is served from a different origin than the API,
the browser sends an OPTIONS preflight before /login and /offer; if these fail,
the real request is blocked client-side with an opaque CORS error. These pin
that the preflight succeeds and advertises the method + headers the frontend
actually uses (POST, Content-Type, X-API-Key)."""

from __future__ import annotations


def _client():
    from fastapi.testclient import TestClient
    import main

    return TestClient(main.app)


_ORIGIN = "https://ar-technician-assistant.vercel.app"


def test_cors_preflight_login_allows_cross_origin_post():
    r = _client().options(
        "/login",
        headers={
            "Origin": _ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert r.status_code == 200
    # Default ALLOWED_ORIGINS is "*"; a locked-down deploy echoes the exact origin.
    assert r.headers.get("access-control-allow-origin") in ("*", _ORIGIN)
    assert "POST" in r.headers.get("access-control-allow-methods", "")


def test_cors_preflight_offer_allows_api_key_header():
    # /offer carries the bearer token in X-API-Key — the preflight must allow it,
    # or the live session can never start from the Vercel origin.
    r = _client().options(
        "/offer",
        headers={
            "Origin": _ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-api-key,content-type",
        },
    )
    assert r.status_code == 200
    allow_headers = r.headers.get("access-control-allow-headers", "").lower()
    assert "x-api-key" in allow_headers


def test_cors_preflight_ice_config_allows_api_key_header():
    r = _client().options(
        "/ice-config",
        headers={
            "Origin": _ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-api-key",
        },
    )
    assert r.status_code == 200
    assert "x-api-key" in r.headers.get("access-control-allow-headers", "").lower()
