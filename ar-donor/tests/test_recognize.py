"""Tests for the NVIDIA-hosted VLM recognizer (services/vision_nvidia.py) and the
/recognize endpoint. The pure request/response helpers are tested directly; the
route is tested with the network call monkeypatched (no real API key needed)."""

from __future__ import annotations

import pytest

import config
from services import vision_nvidia


# ---- pure helpers ---------------------------------------------------------
def test_build_payload_wraps_raw_base64_as_data_url(monkeypatch):
    monkeypatch.setattr(config, "NVIDIA_VLM_MODEL", "meta/llama-3.2-90b-vision-instruct")
    p = vision_nvidia.build_payload("QUJD")  # raw base64
    assert p["model"] == "meta/llama-3.2-90b-vision-instruct"
    content = p["messages"][0]["content"]
    img = [c for c in content if c["type"] == "image_url"][0]["image_url"]["url"]
    assert img == "data:image/jpeg;base64,QUJD"
    assert any(c["type"] == "text" for c in content)  # default prompt present


def test_build_payload_passes_through_data_url_and_custom_prompt():
    p = vision_nvidia.build_payload("data:image/png;base64,ZZ", "read the nameplate")
    content = p["messages"][0]["content"]
    assert [c for c in content if c["type"] == "image_url"][0]["image_url"]["url"] == "data:image/png;base64,ZZ"
    assert [c for c in content if c["type"] == "text"][0]["text"] == "read the nameplate"


def test_build_payload_rejects_empty_image():
    for bad in ("", "   ", None):
        with pytest.raises(vision_nvidia.VisionUnavailable):
            vision_nvidia.build_payload(bad)  # type: ignore[arg-type]


def test_parse_reply_extracts_content():
    data = {"choices": [{"message": {"content": "  - Pump model X\n- Torque 25 Nm  "}}]}
    assert vision_nvidia.parse_reply(data) == "- Pump model X\n- Torque 25 Nm"


def test_parse_reply_raises_on_bad_shapes():
    for bad in ({}, {"choices": []}, {"choices": [{"message": {}}]}, {"choices": [{"message": {"content": "  "}}]}):
        with pytest.raises(vision_nvidia.VisionUnavailable):
            vision_nvidia.parse_reply(bad)


async def test_recognize_unavailable_without_key(monkeypatch):
    monkeypatch.setattr(config, "NVIDIA_API_KEY", "")
    with pytest.raises(vision_nvidia.VisionUnavailable):
        await vision_nvidia.recognize("QUJD")


# ---- /recognize route -----------------------------------------------------
def _client():
    from fastapi.testclient import TestClient
    import main

    return TestClient(main.app)


def test_recognize_requires_auth(monkeypatch):
    monkeypatch.setattr(config, "API_AUTH_TOKEN", "secret")
    r = _client().post("/recognize", json={"image": "QUJD"})
    assert r.status_code == 401


def test_recognize_missing_image_400():
    r = _client().post("/recognize", json={})
    assert r.status_code == 400


def test_recognize_unavailable_503_when_service_raises(monkeypatch):
    async def _raise(image, prompt=""):
        raise vision_nvidia.VisionUnavailable("Recognizer not configured (set NVIDIA_API_KEY).")

    monkeypatch.setattr(vision_nvidia, "recognize", _raise)
    r = _client().post("/recognize", json={"image": "QUJD"})
    assert r.status_code == 503
    assert "NVIDIA_API_KEY" in r.json()["error"]


def test_recognize_ok_returns_detections(monkeypatch):
    async def _ok(image, prompt=""):
        assert image == "QUJD"
        return "- Centrifugal pump\n- Model: CP-200"

    monkeypatch.setattr(vision_nvidia, "recognize", _ok)
    r = _client().post("/recognize", json={"image": "QUJD"})
    assert r.status_code == 200
    assert r.json()["detections"].startswith("- Centrifugal pump")


def test_recognize_error_body_never_leaks_key(monkeypatch):
    monkeypatch.setattr(config, "NVIDIA_API_KEY", "nvapi-supersecret")

    async def _boom(image, prompt=""):
        raise RuntimeError("nvapi-supersecret leaked in exception")

    monkeypatch.setattr(vision_nvidia, "recognize", _boom)
    r = _client().post("/recognize", json={"image": "QUJD"})
    assert r.status_code == 502
    assert "supersecret" not in r.text
