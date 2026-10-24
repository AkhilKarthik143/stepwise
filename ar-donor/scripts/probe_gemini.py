"""
Gemini Live connectivity pre-flight.

Tries to open the BidiGenerateContent websocket and complete the `setup`
handshake, across:
  * two auth methods  (?key=  vs  ?access_token=)  — resolves AIza-key vs
    AQ.-ephemeral-token,
  * the configured model, then a couple of fallback Live models.

Prints which (auth, model, version) combination reaches `setupComplete`, or the
exact close reason for each failure. No WebRTC, no NotebookLM — pure auth/model
check.  Run:  python scripts/probe_gemini.py
"""
from __future__ import annotations

import asyncio
import json
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, ".")

import websockets  # noqa: E402

import config  # noqa: E402

FALLBACK_MODELS = [
    "gemini-2.0-flash-live-001",
    "gemini-live-2.5-flash",
    "gemini-2.0-flash-exp",
]


def _host(version: str) -> str:
    return (
        "wss://generativelanguage.googleapis.com/ws/"
        f"google.ai.generativelanguage.{version}.GenerativeService.BidiGenerateContent"
    )


async def try_handshake(auth_param: str, model: str, version: str) -> tuple[bool, str]:
    uri = f"{_host(version)}?{auth_param}={config.GEMINI_API_KEY}"
    setup = {
        "setup": {
            "model": f"models/{model}",
            "generationConfig": {"responseModalities": ["AUDIO"]},
        }
    }
    try:
        async with websockets.connect(uri, max_size=None, open_timeout=15) as ws:
            await ws.send(json.dumps(setup))
            try:
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=15)
                    msg = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
                    data = json.loads(msg)
                    if "setupComplete" in data:
                        return True, "setupComplete OK"
                    return True, f"connected; first msg keys={list(data.keys())}"
            except asyncio.TimeoutError:
                return False, "connected but no setupComplete within 15s"
    except Exception as exc:  # noqa: BLE001
        # NEVER include str(exc): some websockets errors stringify the full
        # request URI, which carries ?key=<API_KEY>. Mirror the production
        # bridge's sanitization and surface only the exception TYPE.
        return False, f"{type(exc).__name__} (connect failed)"


async def main() -> int:
    if not config.GEMINI_API_KEY:
        print("GEMINI_API_KEY not loaded — check .env")
        return 1
    # Confirm the key is loaded WITHOUT echoing any of it (the repo never prints
    # secrets — a console log / CI capture must not carry even a prefix).
    print(f"key: loaded ({len(config.GEMINI_API_KEY)} chars)  version: {config.GEMINI_API_VERSION}")
    print(f"requested model: {config.GEMINI_LIVE_MODEL}\n")

    # 1) Requested model, both auth methods.
    for auth in ("key", "access_token"):
        ok, info = await try_handshake(auth, config.GEMINI_LIVE_MODEL, config.GEMINI_API_VERSION)
        print(f"[{auth:13}] {config.GEMINI_LIVE_MODEL} @ {config.GEMINI_API_VERSION} -> "
              f"{'OK' if ok else 'FAIL'}: {info}")
        if ok:
            print(f"\n>>> WORKING: GEMINI auth={auth}, model={config.GEMINI_LIVE_MODEL}, "
                  f"version={config.GEMINI_API_VERSION}")
            return 0

    # 2) Fallback models (try both auth methods each).
    print("\n-- requested model failed; trying fallback models --")
    for model in FALLBACK_MODELS:
        if model == config.GEMINI_LIVE_MODEL:
            continue
        for auth in ("key", "access_token"):
            ok, info = await try_handshake(auth, model, config.GEMINI_API_VERSION)
            print(f"[{auth:13}] {model} @ {config.GEMINI_API_VERSION} -> "
                  f"{'OK' if ok else 'FAIL'}: {info}")
            if ok:
                print(f"\n>>> WORKING: GEMINI auth={auth}, model={model}, "
                      f"version={config.GEMINI_API_VERSION}")
                return 0

    print("\n>>> No combination handshaked. See failure reasons above.")
    return 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
