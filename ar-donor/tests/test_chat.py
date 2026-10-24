"""Tests for the /chat and /generate-image endpoints and their pure helpers.
The Gemini SDK calls are isolated, so the route tests monkeypatch the service
functions (no API key or network needed)."""

from __future__ import annotations

import base64

import pytest

import config
from services import chat as chat_service
from services import imagegen


# ---- chat.build_contents (pure) ------------------------------------------
def test_build_contents_text_only():
    c = chat_service.build_contents("how do I bleed the pump?")
    assert c == [{"role": "user", "parts": [{"text": "how do I bleed the pump?"}]}]


def test_build_contents_includes_history_and_maps_roles():
    hist = [
        {"role": "user", "text": "hi"},
        {"role": "assistant", "text": "hello"},
        {"role": "bogus", "text": "treated as user"},
    ]
    c = chat_service.build_contents("next?", history=hist)
    assert c[0] == {"role": "user", "parts": [{"text": "hi"}]}
    assert c[1] == {"role": "model", "parts": [{"text": "hello"}]}  # assistant -> model
    assert c[2]["role"] == "user"
    assert c[-1] == {"role": "user", "parts": [{"text": "next?"}]}


def test_build_contents_decodes_image_to_inline_bytes():
    raw = base64.b64encode(b"\xff\xd8jpegbytes").decode()
    c = chat_service.build_contents("what is this?", image_b64=raw)
    parts = c[-1]["parts"]
    assert parts[0] == {"text": "what is this?"}
    inline = parts[1]["inline_data"]
    assert inline["mime_type"] == "image/jpeg"
    assert inline["data"] == b"\xff\xd8jpegbytes"


def test_build_contents_strips_data_url_prefix():
    raw = base64.b64encode(b"abc").decode()
    c = chat_service.build_contents("", image_b64=f"data:image/png;base64,{raw}")
    assert c[-1]["parts"][0]["inline_data"]["data"] == b"abc"


def test_build_contents_empty_raises():
    with pytest.raises(chat_service.ChatUnavailable):
        chat_service.build_contents("   ")


async def test_chat_unavailable_without_key(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "")
    with pytest.raises(chat_service.ChatUnavailable):
        await chat_service.chat("hi")


# ---- imagegen.extract_inline_image (pure) --------------------------------
class _Inline:
    def __init__(self, data, mime=None):
        self.data = data
        self.mime_type = mime


class _Part:
    def __init__(self, inline=None):
        self.inline_data = inline


def test_extract_inline_image_finds_first():
    parts = [_Part(None), _Part(_Inline(b"PNGDATA", "image/png"))]
    assert imagegen.extract_inline_image(parts) == (b"PNGDATA", "image/png")


def test_extract_inline_image_none_when_absent():
    assert imagegen.extract_inline_image([_Part(None), _Part(None)]) is None
    assert imagegen.extract_inline_image([]) is None


async def test_generate_unavailable_without_key(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "")
    with pytest.raises(imagegen.ImageGenUnavailable):
        await imagegen.generate("a valve")


# ---- routes ---------------------------------------------------------------
def _client():
    from fastapi.testclient import TestClient
    import main

    return TestClient(main.app)


def test_chat_requires_auth(monkeypatch):
    monkeypatch.setattr(config, "API_AUTH_TOKEN", "secret")
    assert _client().post("/chat", json={"text": "hi"}).status_code == 401


def test_chat_empty_400():
    assert _client().post("/chat", json={"text": "   "}).status_code == 400


def test_chat_ok(monkeypatch):
    async def _ok(text, image_b64="", history=None):
        return "Loosen the bleed screw a quarter turn."

    monkeypatch.setattr(chat_service, "chat", _ok)
    r = _client().post("/chat", json={"text": "bleed the pump?"})
    assert r.status_code == 200 and r.json()["reply"].startswith("Loosen")


def test_chat_unavailable_503(monkeypatch):
    async def _unavail(text, image_b64="", history=None):
        raise chat_service.ChatUnavailable("Chat not configured (set GEMINI_API_KEY).")

    monkeypatch.setattr(chat_service, "chat", _unavail)
    r = _client().post("/chat", json={"text": "hi"})
    assert r.status_code == 503 and "GEMINI_API_KEY" in r.json()["error"]


def test_generate_image_missing_prompt_400():
    assert _client().post("/generate-image", json={}).status_code == 400


def test_generate_image_ok(monkeypatch):
    async def _ok(prompt):
        return ("QUJD", "image/png")

    monkeypatch.setattr(imagegen, "generate", _ok)
    r = _client().post("/generate-image", json={"prompt": "assembled valve"})
    assert r.status_code == 200
    assert r.json() == {"image": "QUJD", "mime": "image/png"}


def test_generate_image_error_never_leaks(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "AIzaSECRETKEY")

    async def _boom(prompt):
        raise RuntimeError("AIzaSECRETKEY in the message")

    monkeypatch.setattr(imagegen, "generate", _boom)
    r = _client().post("/generate-image", json={"prompt": "x"})
    assert r.status_code == 502 and "SECRETKEY" not in r.text
