"""The demo flow end to end over the live WebSocket: problem -> machine confirm -> guided
cold pull -> safety interlock -> report. Runs with no keys (local identify, browser voice)."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.main import app


def _turn(ws, text: str) -> tuple[str, list[dict]]:
    """Send one text turn; return the final assistant reply and every message seen."""
    ws.send_text(json.dumps({"type": "control", "action": "text", "text": text}))
    seen: list[dict] = []
    for _ in range(60):
        message = json.loads(ws.receive_text())
        seen.append(message)
        if message.get("type") == "state" and message.get("status") == "listening":
            break
    reply = next(m["text"] for m in seen if m.get("type") == "transcript" and m.get("role") == "assistant" and m.get("final"))
    return reply, seen


def _guide(seen: list[dict]) -> dict:
    return [m for m in seen if m.get("action") == "guide"][-1]


def test_clogged_nozzle_demo_flow(monkeypatch):
    monkeypatch.setenv("STEPWISE_PROVIDER", "mock")
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        for _ in range(4):
            ws.receive_text()

        # 1. Problem statement. No vision key -> never trust a guess; ask to confirm the machine.
        reply, seen = _turn(ws, "The nozzle is clogged")
        assert "Original Prusa MK4" in reply and "yes or no" in reply
        assert _guide(seen)["phase"] == "awaiting_machine"
        assert _guide(seen)["identification"]["provider"] == "local"

        # 2. Confirm -> safety warnings, tools, step 1, in that order.
        reply, seen = _turn(ws, "yes")
        assert reply.index("Safety first") < reply.index("You'll need") < reply.index("Step 1 of 7")
        assert any(m.get("action") == "asset" and m.get("label") == "PRUSA-MK4-01" for m in seen)
        status = next(m for m in seen if m.get("action") == "provider_status")
        assert status["provider"] == "guide" and "prusa3d.com" in status["sources"][0]["url"]

        # 3. Repeat re-speaks the same step.
        reply, _ = _turn(ws, "repeat")
        assert reply.startswith("Step 1 of 7")

        for n in (2, 3, 4):
            reply, _ = _turn(ws, "next")
            assert reply.startswith(f"Step {n} of 7")
        assert "100 °C" in reply  # step 4 is the cooldown safety step

        # 4. Interlock: "next" cannot pass the cooldown step, however often it's said.
        for _ in range(2):
            reply, _ = _turn(ws, "next")
            assert reply.startswith("I can't move on yet")

        # 5. A question mid-procedure goes to the agent and the step holds.
        _turn(ws, "how long does this usually take")
        reply, _ = _turn(ws, "repeat")
        assert reply.startswith("Step 4 of 7")

        # 6. Explicit confirmation passes it.
        reply, _ = _turn(ws, "yes")
        assert reply.startswith("Confirmed. Step 5 of 7")

        for n in (6, 7):
            reply, _ = _turn(ws, "next")
            assert reply.startswith(f"Step {n} of 7")

        # 7. Last step -> verify line + report generated.
        reply, seen = _turn(ws, "done")
        assert "To verify the fix" in reply and "service report" in reply
        assert _guide(seen)["phase"] == "report"
        report = next(m for m in seen if m.get("type") == "panel" and m.get("data", {}).get("report"))
        text = report["data"]["report"]
        assert "Original Prusa MK4" in text and "Operator confirmed step 4" in text and "Blocked advance past step 4" in text

        # 8. "It didn't work" escalates instead of repeating.
        reply, _ = _turn(ws, "it didn't work")
        assert reply.startswith("Repeat the cold pull")
        reply, _ = _turn(ws, "it didn't work")
        assert "doesn't cover" in reply


def test_machine_named_by_user_and_unknown_problem(monkeypatch):
    monkeypatch.setenv("STEPWISE_PROVIDER", "mock")
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        for _ in range(4):
            ws.receive_text()
        _turn(ws, "nozzle is clogged")
        reply, seen = _turn(ws, "no")
        assert "Which machine" in reply and _guide(seen)["phase"] == "idle"
        # Saying "no" never starts a procedure.
        assert not any(m.get("type") == "panel" and m.get("panel") == "procedure" for m in seen)
