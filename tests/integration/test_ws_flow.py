"""End-to-end text/control flow through the live FastAPI WebSocket bridge in mock mode."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.main import app


def _messages(ws, count: int) -> list[dict]:
    return [json.loads(ws.receive_text()) for _ in range(count)]


def test_mock_text_turn_emits_grounded_transcript_and_provider_status(monkeypatch):
    monkeypatch.setenv("STEPWISE_PROVIDER", "mock")
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            hello, state, voice, guide = _messages(ws, 4)
            assert hello["type"] == "hello"
            assert state["type"] == "state"
            # no live Cartesia/DashScope key is intentionally present -> browser speech fallback
            assert voice["action"] == "voice" and voice["voice_in"] == "browser" and voice["voice_out"] == "browser"
            assert guide["action"] == "guide" and guide["phase"] == "idle"

            ws.send_text(json.dumps({"type": "control", "action": "text", "text": "What am I looking at?"}))
            seen: list[dict] = []
            for _ in range(16):
                message = json.loads(ws.receive_text())
                seen.append(message)
                if message.get("type") == "state" and message.get("status") == "listening":
                    break

            assert any(m.get("type") == "transcript" and m.get("role") == "user" for m in seen)
            assistant = next(m for m in seen if m.get("type") == "transcript" and m.get("final") and m.get("role") == "assistant")
            assert "PL45LM" in assistant["text"]
            deltas = [m["delta"] for m in seen if m.get("type") == "transcript" and m.get("role") == "assistant" and not m.get("final")]
            assert "What am I looking at?" not in deltas
            assert all(deltas)
            provider = next(m for m in seen if m.get("action") == "provider_status")
            assert provider["provider"] == "mock"
            assert provider["mock"] is True
            assert any(m.get("type") == "tool" and m.get("name") == "show_machine_data" for m in seen)


def test_pending_anchor_requires_known_component_and_explicit_confirmation(monkeypatch):
    monkeypatch.setenv("STEPWISE_PROVIDER", "mock")
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            _messages(ws, 4)
            ws.send_text(json.dumps({"type": "control", "action": "confirm_anchor", "component_id": "unknown", "coordinates": [100, 100, 300, 300]}))
            rejected = json.loads(ws.receive_text())
            assert rejected["type"] == "error"

            ws.send_text(json.dumps({"type": "control", "action": "confirm_anchor", "component_id": "spindle", "coordinates": [100, 200, 400, 600], "source": "user_confirmed"}))
            confirmed = json.loads(ws.receive_text())
            status = json.loads(ws.receive_text())
            assert confirmed["type"] == "ar.annotation.add"
            assert confirmed["tracking_status"] == "confirmed"
            assert confirmed["anchor"]["source"] == "user_confirmed"
            assert status["action"] == "provider_status"
