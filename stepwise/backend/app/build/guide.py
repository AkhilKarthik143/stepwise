"""BuildSight's server-owned build flow.

Fixed-meaning phrases ("next", "repeat", "back", "what step am I on", "switch to the stool",
"that's fine") are matched here and answered without a model call, so they come back fast.
Questions, step checks and part matching go to Claude through ``app.build.vision``.

The mistake lock: when a check finds a problem, "next" is refused until a later check passes
or the builder says "that's fine" (logged as an override). A check that can't see clearly asks
for a closer look instead of judging.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

from app.build import vision as default_vision
from app.build.catalog import BuildCatalog
from app.build.metrics import Metrics
from app.build.models import Build, BuildStep, CheckIssue

logger = logging.getLogger("stepwise.build_guide")

UNCHECKED, BUILDING, PASSED, FAILED = "unchecked", "building", "passed", "failed"


def _has(text: str, *patterns: str) -> bool:
    return any(re.search(rf"(^|\b){p}(\b|$)", text) for p in patterns)


def is_switch(t: str) -> bool:
    return _has(t, r"switch( over)? to", r"load( up)?", r"change to", r"let'?s (build|do)", r"go to the")


def is_override(t: str) -> bool:
    return _has(t, r"that'?s fine", r"it'?s fine", r"that'?s ok(ay)?", r"override", r"ignore (that|it)", r"it'?s correct")


def is_part_question(t: str) -> bool:
    return _has(t, r"right (one|part|piece|bolt|screw|brick)", r"correct (one|part|piece)", r"is this (it|the one)", r"which (one|part|piece)")


def is_check(t: str) -> bool:
    return _has(t, r"done", r"check( it| this)?", r"finished", r"how does (it|that|this) look", r"is (this|that|it) right", r"did i do (it|that) right")


def is_where(t: str) -> bool:
    return _has(t, r"what'?s next", r"what now", r"where am i", r"what do i do")


def is_step_number(t: str) -> bool:
    return _has(t, r"what step", r"which step")


def is_next(t: str) -> bool:
    return _has(t, r"next( step)?", r"go on", r"continue", r"moving on", r"skip")


def is_repeat(t: str) -> bool:
    return _has(t, r"repeat", r"again", r"say (that|it) again", r"come again", r"pardon")


def is_back(t: str) -> bool:
    return _has(t, r"back", r"previous( step)?", r"undo", r"go back")


@dataclass
class Progress:
    index: int = 0
    state: str = UNCHECKED
    issues: list[CheckIssue] = field(default_factory=list)
    confidence: float | None = None
    started_at: float = field(default_factory=time.monotonic)


@dataclass
class GuideTurn:
    text: str
    kind: str  # "command" | "check" | "question" | "part"


class BuildGuide:
    def __init__(self, settings, catalog: BuildCatalog, metrics: Metrics, vision: Any = default_vision) -> None:
        self.settings = settings
        self.catalog = catalog
        self.metrics = metrics
        self.vision = vision
        self.build: Build | None = catalog.first()
        self.progress: dict[str, Progress] = {}
        self._told_no_key = False
        self._sync_metrics()

    # ── state ────────────────────────────────────────────────────────────────
    @property
    def active(self) -> bool:
        return self.build is not None

    @property
    def p(self) -> Progress:
        assert self.build
        return self.progress.setdefault(self.build.build_id, Progress())

    @property
    def step(self) -> BuildStep:
        assert self.build
        return self.build.steps[min(self.p.index, len(self.build.steps) - 1)]

    def image_url(self, build: Build, step: BuildStep) -> str:
        return f"/api/builds/{build.build_id}/{step.expected_image}"

    def status(self) -> dict[str, Any]:
        builds = [{"id": b.build_id, "title": b.title} for b in self.catalog.builds.values()]
        if not self.build:
            return {"build": None, "builds": builds}
        b, s, p = self.build, self.step, self.p
        prev = b.steps[p.index - 1] if 0 < p.index < len(b.steps) else None
        return {
            "builds": builds,
            "build": {"id": b.build_id, "title": b.title, "total": len(b.steps), "source": b.source.model_dump() if b.source else None},
            "index": p.index,
            "complete": p.index >= len(b.steps),
            "step": {**s.model_dump(exclude={"crop"}), "image_url": self.image_url(b, s)},
            "previous_image_url": self.image_url(b, prev) if prev else None,
            "check": {"state": p.state, "confidence": p.confidence, "issues": [i.model_dump() for i in p.issues]},
        }

    def _sync_metrics(self) -> None:
        m = self.metrics
        if self.build:
            m.build_id, m.build_title = self.build.build_id, self.build.title
            m.step, m.total_steps = self.step.step, len(self.build.steps)

    # ── spoken lines ─────────────────────────────────────────────────────────
    def step_line(self, lead: str = "") -> str:
        if self.p.index >= len(self.build.steps):
            return f"{lead}That was the last step. The {self.build.title} is done."
        s = self.step
        parts = [p.spoken() for p in s.parts]
        grab = ""
        if parts:
            grab = "Grab " + (parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]) + ". "
        return f"{lead}Step {s.step}. {grab}{s.action}".strip()

    # ── entry points ─────────────────────────────────────────────────────────
    async def handle(self, text: str, frame_b64: str | None) -> GuideTurn | None:
        t = (text or "").lower().strip()
        if not t:
            return None
        if is_switch(t):
            target = self.catalog.resolve(t)
            if target:
                return self._switch(target)
            if not self.active:
                return None
        if not self.active:
            return None
        if is_override(t):
            return self._override()
        if is_part_question(t):
            return await self._match_part(t, frame_b64)
        if is_where(t):
            return GuideTurn(self.step_line(f"You're on step {self.step.step}. ") if self.p.index < len(self.build.steps) else self.step_line(), "command")
        if is_step_number(t):
            return GuideTurn(f"You're on step {self.step.step} of {self.build.steps[-1].step}.", "command")
        if is_check(t):
            turn = await self.check(frame_b64, trigger="voice")
            return turn or GuideTurn("Not finished yet. Keep going and say done when it's built.", "check")
        if is_next(t):
            return self._advance()
        if is_repeat(t):
            return GuideTurn(self.step_line(), "command")
        if is_back(t):
            return self._back()
        return await self._question(text, frame_b64)

    async def check(self, frame_b64: str | None, *, trigger: str = "stillness") -> GuideTurn | None:
        """Compare the camera with the manual's picture. None = nothing worth saying."""
        if not self.active or self.p.index >= len(self.build.steps):
            return None
        if not frame_b64:
            return GuideTurn("I can't see the camera yet.", "check") if trigger == "voice" else None
        if not self.settings.anthropic_api_key:
            if trigger == "voice" or not self._told_no_key:
                self._told_no_key = True
                return GuideTurn("Step checking needs the Claude key. Say next when the step is done.", "check")
            return None
        expected = self.catalog.step_image(self.build, self.step)
        if expected is None:
            return GuideTurn(f"There's no manual picture for step {self.step.step}, so I can't check it.", "check") if trigger == "voice" else None
        prev_step = self.build.steps[self.p.index - 1] if self.p.index > 0 else None
        previous = self.catalog.step_image(self.build, prev_step) if prev_step else None
        try:
            result = await self.vision.check_step(self.settings, expected=expected, previous=previous, frame_b64=frame_b64, step=self.step)
        except Exception as exc:  # noqa: BLE001 — a failed call never blocks the build
            logger.warning("step check failed: %r", exc)
            return GuideTurn("I couldn't check that one. Try again, or say next.", "check") if trigger == "voice" else None

        self.metrics.checks += 1
        p = self.p
        p.confidence = result.confidence
        if result.confidence < self.settings.check_min_confidence:
            self.metrics.closer_looks += 1
            return GuideTurn("I can't tell from here. Show me closer, or from straight above.", "check")
        if result.issues:
            if p.state != FAILED:
                self.metrics.mistakes_caught += 1
            p.state, p.issues = FAILED, result.issues
            first = result.issues[0]
            return GuideTurn(f"Hold on. The {first.part} is {first.problem}. {first.fix}", "check")
        if not result.step_complete:
            p.state, p.issues = BUILDING, []
            return GuideTurn("Not finished yet. Keep going.", "check") if trigger == "voice" else None
        p.state, p.issues = PASSED, []
        return self._advance(lead="Good. ")

    # ── actions ──────────────────────────────────────────────────────────────
    def _advance(self, lead: str = "") -> GuideTurn:
        p = self.p
        if p.index >= len(self.build.steps):
            return GuideTurn(self.step_line(), "command")
        if p.state == FAILED and p.issues:
            fix = p.issues[0].fix
            return GuideTurn(f"Fix this first: {fix} Or say that's fine if it's right.", "command")
        self.metrics.step_seconds.append(round(time.monotonic() - p.started_at, 1))
        self.metrics.steps_done += 1
        self.progress[self.build.build_id] = Progress(index=p.index + 1)
        self._sync_metrics()
        return GuideTurn(self.step_line(lead), "command")

    def _back(self) -> GuideTurn:
        p = self.p
        self.progress[self.build.build_id] = Progress(index=max(0, p.index - 1))
        self._sync_metrics()
        return GuideTurn(self.step_line("Back one. "), "command")

    def _override(self) -> GuideTurn:
        p = self.p
        if p.state != FAILED:
            return GuideTurn("Nothing to override. " + self.step_line(), "command")
        self.metrics.overrides += 1
        logger.info("override on %s step %s: %s", self.build.build_id, self.step.step, [i.model_dump() for i in p.issues])
        p.state, p.issues = PASSED, []
        return self._advance(lead="Okay, logged. ")

    def _switch(self, target: Build) -> GuideTurn:
        self.build = target
        self._sync_metrics()
        return GuideTurn(self.step_line(f"Switching to the {target.title}. "), "command")

    async def _match_part(self, question: str, frame_b64: str | None) -> GuideTurn:
        if not frame_b64:
            return GuideTurn("I can't see the camera yet.", "part")
        if not self.settings.anthropic_api_key:
            return GuideTurn("Part matching needs the Claude key.", "part")
        try:
            match = await self.vision.match_part(self.settings, frame_b64=frame_b64, step=self.step, question=question)
        except Exception as exc:  # noqa: BLE001
            logger.warning("part match failed: %r", exc)
            return GuideTurn("I couldn't check that part. Try again.", "part")
        if match.confidence < self.settings.check_min_confidence:
            return GuideTurn("Hold it closer to the camera, against the mat.", "part")
        return GuideTurn(match.say, "part")

    async def _question(self, question: str, frame_b64: str | None) -> GuideTurn:
        if not self.settings.anthropic_api_key:
            return GuideTurn("I can answer questions once the Claude key is set. Say next, repeat, or back.", "question")
        try:
            reply = await self.vision.answer(self.settings, build=self.build, step=self.step, question=question, frame_b64=frame_b64)
        except Exception as exc:  # noqa: BLE001
            logger.warning("question failed: %r", exc)
            return GuideTurn("I couldn't answer that right now. Try again.", "question")
        return GuideTurn(reply or "I don't have an answer for that in the manual.", "question")
