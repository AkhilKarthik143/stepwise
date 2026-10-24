#!/usr/bin/env python3
"""Smoke-test a deployed AR Technician Assistant backend.

Usage:
    python scripts/smoke_deploy.py https://your-backend.onrender.com [vercel-origin]

Checks the endpoints the Vercel frontend depends on: /health (+ auth_required),
/login (wrong creds -> 401), /ice-config (no-auth -> 401), and the browser CORS
preflight for /login and /offer (the cross-origin path). Exits 0 if all pass, 1
otherwise. Stdlib only (urllib) — no dependencies, runs anywhere Python does.

Free-tier hosts (e.g. Render free) sleep when idle; the FIRST call can take ~50s
to wake the container, so timeouts are generous and the first request warms it.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request


def _req(method, url, headers=None, data=None, timeout=90):
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:  # 4xx/5xx still carry status + headers
        return e.code, e.read(), {k.lower(): v for k, v in e.headers.items()}
    except Exception as e:  # noqa: BLE001 — network error / timeout
        return None, str(e).encode(), {}


_results: list[tuple[str, bool]] = []


def _check(name, ok, detail=""):
    _results.append((name, bool(ok)))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f"  ({detail})" if detail else ""))


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: python scripts/smoke_deploy.py <backend-base-url> "
            "[vercel-origin] [email] [password]\n"
            "  (email + password optional: also verifies TURN is served via /ice-config)"
        )
        return 2
    base = sys.argv[1].rstrip("/")
    origin = sys.argv[2] if len(sys.argv) > 2 else "https://example.vercel.app"
    # Optional: a real login lets us also verify TURN is actually served (the
    # blind spot that broke live video — /ice-config needs auth to reveal TURN).
    email = sys.argv[3] if len(sys.argv) > 3 else ""
    password = sys.argv[4] if len(sys.argv) > 4 else ""
    print(f"Smoke-testing {base}")
    print("(a free-tier host can take ~50s to wake on the first call)\n")

    st, body, _ = _req("GET", base + "/health")
    try:
        health = json.loads(body)
    except Exception:  # noqa: BLE001
        health = {}
    _check("/health returns 200", st == 200, f"status={st}")
    _check(
        "/health auth_required is true",
        health.get("auth_required") is True,
        f"auth_required={health.get('auth_required')}",
    )

    data = json.dumps({"email": "smoke@test.invalid", "password": "wrong"}).encode()
    st, _, _ = _req("POST", base + "/login", {"Content-Type": "application/json"}, data)
    _check("/login wrong creds -> 401", st == 401, f"status={st}")

    st, _, _ = _req("GET", base + "/ice-config")
    _check("/ice-config without auth -> 401", st == 401, f"status={st}")

    st, _, hdrs = _req(
        "OPTIONS",
        base + "/login",
        {
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    aco = hdrs.get("access-control-allow-origin", "")
    _check(
        "CORS preflight /login (cross-origin POST)",
        st == 200 and aco in ("*", origin),
        f"status={st} allow-origin={aco}",
    )

    st, _, hdrs = _req(
        "OPTIONS",
        base + "/offer",
        {
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-api-key,content-type",
        },
    )
    ach = hdrs.get("access-control-allow-headers", "").lower()
    _check(
        "CORS preflight /offer allows X-API-Key",
        st == 200 and "x-api-key" in ach,
        f"status={st}",
    )

    # Optional authenticated check: log in and confirm /ice-config actually
    # serves a TURN relay (not just STUN) — without this, the basic checks pass
    # but live video still fails. Runs only when creds are supplied.
    if email and password:
        body = json.dumps({"email": email, "password": password}).encode()
        st, lb, _ = _req("POST", base + "/login", {"Content-Type": "application/json"}, body)
        try:
            token = json.loads(lb).get("token", "")
        except Exception:  # noqa: BLE001
            token = ""
        _check("/login with provided creds -> 200 + token", st == 200 and bool(token), f"status={st}")
        if token:
            st, ib, _ = _req("GET", base + "/ice-config", {"X-API-Key": token})
            try:
                servers = json.loads(ib).get("iceServers", [])
            except Exception:  # noqa: BLE001
                servers = []
            has_turn = any(
                "turn" in str(s.get("urls", "")).lower() and s.get("credential")
                for s in servers
            )
            urls_seen = "; ".join(str(s.get("urls", "")) for s in servers)[:120]
            _check(
                "/ice-config serves a TURN relay (not just STUN)",
                has_turn,
                f"servers=[{urls_seen}]",
            )

    passed = sum(1 for _, ok in _results if ok)
    total = len(_results)
    print(f"\n{passed}/{total} checks passed")
    if passed != total:
        print("FAILED - see the [FAIL] lines above.")
        return 1
    print("OK - backend is reachable and the cross-origin contract holds.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
