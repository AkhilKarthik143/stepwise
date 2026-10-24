"""Passcode lock: pages redirect, API and WebSocket refuse, /healthz stays open, the cookie unlocks."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.access import PasscodeGate


def make_app(passcode: str) -> TestClient:
    app = FastAPI()

    @app.get("/healthz")
    def health():
        return {"ok": True}

    @app.get("/api/config")
    def config():
        return {"ok": True}

    @app.get("/")
    def home():
        return {"page": True}

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        await socket.send_text("hi")
        await socket.close()

    app.add_middleware(PasscodeGate, passcode=passcode)
    return TestClient(app)


def test_locked_until_the_right_passcode():
    client = make_app("lego42")
    assert client.get("/healthz").status_code == 200
    assert client.get("/api/config").status_code == 401
    page = client.get("/", follow_redirects=False)
    assert page.status_code == 303 and page.headers["location"].startswith("/unlock")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws") as ws:
            ws.receive_text()

    wrong = client.post("/api/unlock", data={"passcode": "nope", "next": "/"}, follow_redirects=False)
    assert wrong.status_code == 401 and "Wrong passcode" in wrong.text
    right = client.post("/api/unlock", data={"passcode": "lego42", "next": "/#dashboard"}, follow_redirects=False)
    assert right.status_code == 303 and "HttpOnly" in right.headers["set-cookie"]

    assert client.get("/api/config").status_code == 200
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_text() == "hi"


def test_unlock_never_redirects_off_site():
    client = make_app("lego42")
    r = client.post("/api/unlock", data={"passcode": "lego42", "next": "//evil.example"}, follow_redirects=False)
    assert r.headers["location"] == "/"


def test_no_passcode_means_no_lock():
    client = make_app("")
    assert client.get("/api/config").status_code == 200
