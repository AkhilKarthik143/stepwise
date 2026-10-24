"""BuildSight guide: commands, the mistake lock, overrides, closer looks, switching, routes.

Uses a throwaway build written to a temp folder (plain colored squares as step pictures —
test fixtures only) and a fake vision module, so no Claude calls are made.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from app.build.catalog import BuildCatalog
from app.build.guide import FAILED, BuildGuide
from app.build.metrics import Metrics
from app.build.models import CheckIssue, CheckResult, PartMatch, StepLocation


def write_build(root: Path, build_id: str, title: str, aliases: list[str], n_steps: int = 3) -> None:
    folder = root / build_id
    (folder / "steps").mkdir(parents=True)
    steps = []
    for n in range(1, n_steps + 1):
        Image.new("RGB", (40, 40), (40 * n, 80, 120)).save(folder / "steps" / f"{n:02d}.png")
        steps.append({"step": n, "page": 1, "parts": [{"name": "brick 2x4", "color": "red", "qty": 1}],
                      "action": f"Put it on the left, step {n}.", "expected_image": f"steps/{n:02d}.png", "watch_for": ["orientation"]})
    (folder / "build.json").write_text(json.dumps({"build_id": build_id, "title": title, "aliases": aliases,
                                                   "source": {"title": f"{title} manual", "url": "https://example.com/manual.pdf"}, "steps": steps}))


@pytest.fixture
def catalog(tmp_path: Path) -> BuildCatalog:
    write_build(tmp_path, "lego-kart", "LEGO kart", ["lego", "kart"])
    write_build(tmp_path, "ikea-stool", "IKEA stool", ["stool"], n_steps=2)
    return BuildCatalog(tmp_path)


class FakeVision:
    def __init__(self) -> None:
        self.next_check = CheckResult(step_complete=True, confidence=0.9, issues=[])
        self.next_location = StepLocation(completed_step=2, confidence=0.85)
        self.calls: list[str] = []

    async def check_step(self, settings, *, expected, previous, frame_b64, step):
        self.calls.append(f"check:{step.step}:{expected.name}:{previous.name if previous else None}")
        return self.next_check

    async def match_part(self, settings, *, frame_b64, step, question):
        return PartMatch(is_right_part=False, confidence=0.9, held_part="short bolt", say="That's the short one. You need the long one.")

    async def locate_step(self, settings, *, sheets, frame_b64, build):
        self.calls.append(f"locate:{len(sheets)}:{sheets[0][1]}")
        return self.next_location

    async def answer(self, settings, *, build, step, question, frame_b64, step_image=None, history=None):
        self.calls.append(f"answer:{question}:{step_image.name if step_image else None}:{len(history or [])}")
        return "It's gray." if "color" in question else f"Step {step.step + 2} attaches to that slope."


def settings(key: str = "sk-test") -> SimpleNamespace:
    return SimpleNamespace(anthropic_api_key=key, check_min_confidence=0.7)


def guide_for(catalog, key="sk-test"):
    vision = FakeVision()
    g = BuildGuide(settings(key), catalog, Metrics(), vision=vision)
    g.build = catalog.get("lego-kart")
    return g, vision


def say(guide, text, frame="FRAME"):
    return asyncio.run(guide.handle(text, frame))


def test_commands_answer_without_a_model(catalog):
    g, vision = guide_for(catalog)
    assert say(g, "what's next?", frame=None).text == "You're on step 1. Grab the red brick 2x4. Put it on the left, step 1."
    assert say(g, "next").text.startswith("Step 2.")
    assert say(g, "repeat").text.startswith("Step 2.")
    assert say(g, "what step am I on").text == "You're on step 2 of 3."
    assert say(g, "go back").text.startswith("Back one. Step 1.")
    assert vision.calls == []  # none of these touched the model
    assert g.metrics.steps_done == 1


def test_passing_check_advances_and_compares_with_previous_picture(catalog):
    g, vision = guide_for(catalog)
    say(g, "next")
    turn = asyncio.run(g.check("FRAME"))
    assert turn.text.startswith("Good. Step 3.")
    assert vision.calls == ["check:2:02.png:01.png"]


def test_mistake_locks_next_until_fixed_or_overridden(catalog):
    g, vision = guide_for(catalog)
    vision.next_check = CheckResult(step_complete=False, confidence=0.88,
                                    issues=[CheckIssue(part="slope 2x2", problem="rotated 180°", fix="Turn it so the slope faces the front.")])
    turn = asyncio.run(g.check("FRAME"))
    assert turn.text == "Hold on. The slope 2x2 is rotated 180°. Turn it so the slope faces the front."
    assert g.p.state == FAILED and g.metrics.mistakes_caught == 1
    for _ in range(2):
        assert say(g, "next").text.startswith("Fix this first: Turn it so the slope faces the front.")
    asyncio.run(g.check("FRAME"))  # same mistake seen again is not counted twice
    assert g.metrics.mistakes_caught == 1
    assert say(g, "that's fine").text.startswith("Okay, logged. Step 2.")
    assert g.metrics.overrides == 1


def test_fixed_mistake_passes_on_the_next_check(catalog):
    g, vision = guide_for(catalog)
    vision.next_check = CheckResult(step_complete=False, confidence=0.9, issues=[CheckIssue(part="brick", problem="on the wrong side", fix="Move it left.")])
    asyncio.run(g.check("FRAME"))
    vision.next_check = CheckResult(step_complete=True, confidence=0.9, issues=[])
    assert asyncio.run(g.check("FRAME")).text.startswith("Good. Step 2.")


def test_low_confidence_asks_for_a_closer_look_and_does_not_judge(catalog):
    g, vision = guide_for(catalog)
    vision.next_check = CheckResult(step_complete=False, confidence=0.4, issues=[CheckIssue(part="x", problem="y", fix="z")])
    assert asyncio.run(g.check("FRAME")).text.startswith("I can't tell from here")
    assert g.p.state != FAILED and g.metrics.closer_looks == 1


def test_unfinished_step_stays_quiet_on_stillness_but_answers_done(catalog):
    g, vision = guide_for(catalog)
    vision.next_check = CheckResult(step_complete=False, confidence=0.9, issues=[])
    assert asyncio.run(g.check("FRAME")) is None
    assert say(g, "done").text.startswith("Not finished yet")


def test_switch_builds_by_voice_and_resume(catalog):
    g, _ = guide_for(catalog)
    say(g, "next")
    assert say(g, "switch to the stool").text.startswith("Switching to the IKEA stool. Step 1.")
    assert say(g, "let's build the lego kart").text.startswith("Switching to the LEGO kart. Step 2.")  # kept its place


def test_part_matching_and_questions_go_to_the_model(catalog):
    g, _ = guide_for(catalog)
    assert say(g, "is this the right one?").text == "That's the short one. You need the long one."
    assert say(g, "why does that matter?").text == "Step 3 attaches to that slope."


def test_without_a_key_commands_work_and_checks_say_why_not(catalog):
    g, vision = guide_for(catalog, key="")
    assert say(g, "next").text.startswith("Step 2.")
    assert "needs the Claude key" in asyncio.run(g.check("FRAME", trigger="voice")).text
    assert "Claude key" in say(g, "why does that matter?").text
    assert vision.calls == []


def test_last_step_finishes_the_build(catalog):
    g, _ = guide_for(catalog)
    say(g, "switch to the stool")
    say(g, "next")
    assert say(g, "next").text == "That was the last step. The IKEA stool is done."
    assert g.status()["complete"] is True


def test_routes_serve_step_pictures_only_from_the_build_folder(catalog, monkeypatch):
    from fastapi.testclient import TestClient

    import app.main as main

    monkeypatch.setattr(main, "get_catalog", lambda: catalog)
    client = TestClient(main.app)
    assert [b["id"] for b in client.get("/api/builds").json()["builds"]] == ["ikea-stool", "lego-kart"]
    assert client.get("/api/builds/lego-kart/steps/01.png").headers["content-type"] == "image/png"
    assert client.get("/api/builds/lego-kart/build.json").status_code == 404
    assert catalog.image_path("lego-kart", "steps/../../ikea-stool/steps/01.png") is None  # no escaping the folder
    assert "steps_done" in client.get("/api/metrics").json()


def test_websocket_check_flow_reports_mistake(catalog, monkeypatch):
    """The browser's stillness trigger sends {action: check}; the reply, build status and metrics come back."""
    from fastapi.testclient import TestClient

    import app.main as main
    import app.ws.gateway as gateway
    from app.build import vision
    from app.config import get_settings

    async def failing_check(settings, **kw):
        return CheckResult(step_complete=False, confidence=0.9, issues=[CheckIssue(part="slope 2x2", problem="rotated 180°", fix="Turn it so the slope faces the front.")])

    monkeypatch.setattr(gateway, "get_catalog", lambda: catalog)
    monkeypatch.setattr(vision, "check_step", failing_check)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    get_settings.cache_clear()
    try:
        with TestClient(main.app) as client, client.websocket_connect("/ws") as ws:
            for _ in range(5):
                ws.receive_text()
            ws.send_text(json.dumps({"type": "control", "action": "check", "jpeg_b64": "QUJD", "trigger": "stillness"}))
            seen: list[dict] = []
            while not (len(seen) > 1 and seen[-1].get("type") == "state" and seen[-1].get("status") == "listening"):
                seen.append(json.loads(ws.receive_text()))
            reply = next(m for m in seen if m.get("type") == "transcript")
            assert reply["text"].startswith("Hold on. The slope 2x2 is rotated 180°.")
            status = next(m for m in seen if m.get("action") == "build")
            assert status["check"]["state"] == "failed" and status["step"]["image_url"].endswith("steps/01.png")
            assert next(m for m in seen if m.get("action") == "metrics_update")["mistakes_caught"] == 1
    finally:
        get_settings.cache_clear()


def test_follow_up_question_gets_a_direct_answer_not_the_whole_step(catalog):
    g, vision = guide_for(catalog)
    say(g, "what's next?", frame=None)
    assert say(g, "what was the color again?").text == "It's gray."
    # the question saw the manual picture for this step and the earlier exchange
    assert vision.calls[-1] == "answer:what was the color again?:01.png:1"
    # plain "again" / "repeat" still re-reads the step instantly, no model call
    assert say(g, "again").text.startswith("Step 1.")
    assert say(g, "repeat that").text.startswith("Step 1.")
    assert say(g, "next").text.startswith("Step 2.")


def test_go_to_step_by_number_or_words_without_counting_steps_done(catalog):
    g, vision = guide_for(catalog)
    assert say(g, "go to step 3").text.startswith("Okay. Step 3.")
    assert say(g, "I'm on step two").text.startswith("Okay. Step 2.")
    assert say(g, "step 1").text.startswith("Okay. Step 1.")
    assert say(g, "go to step 9").text == "There's no step 9. This manual has steps 1 to 3."
    assert g.metrics.steps_done == 0 and vision.calls == []


def test_where_am_i_finds_the_step_from_the_camera(catalog):
    g, vision = guide_for(catalog)
    assert say(g, "where am I?").text.startswith("Looks like you've finished step 2. Step 3.")
    assert vision.calls == ["locate:1:[1, 2, 3]"]  # one contact sheet with all three steps
    vision.next_location = StepLocation(completed_step=1, confidence=0.4)
    turn = say(g, "where am I?")
    assert turn.text.startswith("I'm not sure where you are. It might be around step 2.")
    assert g.step.step == 3  # an unsure answer doesn't move the builder


def test_first_whats_next_finds_the_place_once(catalog):
    g, vision = guide_for(catalog)
    assert say(g, "what's next?").text.startswith("Looks like you've finished step 2. Step 3.")
    assert say(g, "what's next?").text.startswith("You're on step 3.")  # only the first time
    assert sum(c.startswith("locate") for c in vision.calls) == 1


def test_no_key_where_am_i_explains(catalog):
    g, _ = guide_for(catalog, key="")
    assert "Claude key" in say(g, "where am I?").text
    assert say(g, "what's next?").text.startswith("You're on step 1.")
