"""Claude calls for BuildSight: read a manual page, check a step, match a part, answer a question.

The step check never asks the model to work out from scratch what was built. It compares the
camera frame with the manual's own picture for this step (and the previous one), so the model
only has to spot differences. Every call returns a validated pydantic model (structured
outputs) and opts into server-side refusal fallbacks.
"""

from __future__ import annotations

import base64
import json
import logging
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel

from app.build.models import Build, BuildStep, CheckResult, PageExtraction, PartMatch, StepLocation

logger = logging.getLogger("stepwise.vision")

T = TypeVar("T", bound=BaseModel)

FALLBACK_BETA = "server-side-fallback-2026-07-01"


class VisionUnavailable(RuntimeError):
    pass


def _image_block(data: bytes, media_type: str) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": base64.standard_b64encode(data).decode()}}


def _png(path: Path) -> dict:
    return _image_block(path.read_bytes(), "image/png")


def _jpeg_b64(b64: str) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}}


def _step_brief(step: BuildStep) -> str:
    return json.dumps({"step": step.step, "parts": [p.model_dump() for p in step.parts], "action": step.action, "watch_for": step.watch_for})


_clients: dict[str, object] = {}


def _async_client(settings):
    if not settings.anthropic_api_key:
        raise VisionUnavailable("ANTHROPIC_API_KEY is not set")
    from anthropic import AsyncAnthropic

    client = _clients.get(settings.anthropic_api_key)
    if client is None:
        client = _clients[settings.anthropic_api_key] = AsyncAnthropic(api_key=settings.anthropic_api_key)
    return client


async def _parse(settings, *, model: str, effort: str, system: str, content: list[dict], schema: type[T], max_tokens: int = 4000) -> T:
    client = _async_client(settings)
    response = await client.beta.messages.parse(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": content}],
        output_format=schema,
        output_config={"effort": effort},
        betas=[FALLBACK_BETA],
        fallbacks="default",
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise VisionUnavailable(f"no usable answer (stop_reason={response.stop_reason})")
    return response.parsed_output


# ── live step check ──────────────────────────────────────────────────────────
CHECK_SYSTEM = """You check one step of a physical build (LEGO, furniture, a machine) against its instruction manual.
You get up to three images, each labeled: the manual's picture after the PREVIOUS step, the manual's picture after THIS step, and the CAMERA looking down at the real build now.
Decide whether THIS step is complete in the camera image, and whether anything differs from the manual's picture for this step: wrong part, wrong color, wrong position or side, rotated or flipped.
Rules:
- Report only problems you can actually see. The camera angle and lighting differ from the manual; that alone is not a problem.
- Use the step's parts list and watch_for list to know what matters.
- If hands block the view, the build is cut off, or you can't tell, set confidence below 0.7 instead of guessing.
- Each fix is one instruction under 15 words that names the part by color and size."""


async def check_step(settings, *, expected: Path, previous: Path | None, frame_b64: str, step: BuildStep) -> CheckResult:
    content: list[dict] = []
    if previous is not None:
        content += [{"type": "text", "text": "Manual, after the PREVIOUS step:"}, _png(previous)]
    content += [
        {"type": "text", "text": "Manual, after THIS step:"},
        _png(expected),
        {"type": "text", "text": "CAMERA, the real build now:"},
        _jpeg_b64(frame_b64),
        {"type": "text", "text": f"This step: {_step_brief(step)}"},
    ]
    return await _parse(settings, model=settings.check_model, effort=settings.check_effort, system=CHECK_SYSTEM, content=content, schema=CheckResult)


# ── "where am I?" ────────────────────────────────────────────────────────────
LOCATE_SYSTEM = """A builder is partway through a build. You get contact sheets of the manual: every step's "after" picture in a tile labeled with its step number. Then a CAMERA photo of the real build now.
Find the last step whose "after" picture matches the real build: everything up to that step is built, the next step's parts are not attached yet.
Compare shape, size, colors and which parts are present. Ignore camera angle, lighting and loose parts lying beside the build.
completed_step is 0 if nothing is built yet. Confidence below 0.7 when two steps look alike or the view is unclear."""


async def locate_step(settings, *, sheets: list[tuple[bytes, list[int]]], frame_b64: str, build: Build) -> StepLocation:
    content: list[dict] = []
    for png, numbers in sheets:
        content += [{"type": "text", "text": f"Manual steps {numbers[0]} to {numbers[-1]}:"}, _image_block(png, "image/png")]
    content += [
        {"type": "text", "text": f"CAMERA, the real {build.title} now:"},
        _jpeg_b64(frame_b64),
        {"type": "text", "text": "Which step has the builder just finished?"},
    ]
    return await _parse(settings, model=settings.check_model, effort=settings.check_effort, system=LOCATE_SYSTEM, content=content, schema=StepLocation, max_tokens=4000)


# ── "is this the right one?" ─────────────────────────────────────────────────
MATCH_SYSTEM = """A builder holds up a part to the camera and asks if it's the one this step needs.
Compare what they hold with the step's parts list (sizes, lengths, colors, shapes). The background is a plain mat.
say: one sentence under 20 words. If wrong, say which part they need, by size and color, and where it is if you can see it.
If you can't see the held part clearly, set confidence below 0.7 and ask them to hold it closer."""


async def match_part(settings, *, frame_b64: str, step: BuildStep, question: str) -> PartMatch:
    content = [
        _jpeg_b64(frame_b64),
        {"type": "text", "text": f"They asked: {question!r}. This step: {_step_brief(step)}"},
    ]
    return await _parse(settings, model=settings.check_model, effort=settings.check_effort, system=MATCH_SYSTEM, content=content, schema=PartMatch, max_tokens=2000)


# ── questions about the build ────────────────────────────────────────────────
def _answer_system(build: Build) -> str:
    steps = "\n".join(f"Step {s.step} (page {s.page}): {s.action} Parts: {', '.join(p.spoken() for p in s.parts) or 'none'}." for s in build.steps)
    return (
        f"You are BuildSight, a hands-free build assistant. The builder is following the manual for {build.title}.\n"
        "Answer exactly what was asked, as briefly as a person standing next to them would: often a few words "
        "(\"It's gray.\", \"The left side.\", \"Two of them.\"), never more than two sentences. Don't read the whole step back.\n"
        "Follow-ups like \"what was the color again?\" refer to the recent conversation and the current step.\n"
        "Use the manual's picture for the current step to read colors, sides and orientation. Name parts by color and size.\n"
        "Answer only from the manual steps below. If they don't cover it, say so. Never invent sizes, part numbers or torques.\n"
        "Cite the step number when it helps.\n\nMANUAL STEPS:\n" + steps
    )


async def answer(settings, *, build: Build, step: BuildStep, question: str, frame_b64: str | None,
                 step_image: Path | None = None, history: list[tuple[str, str]] | None = None) -> str:
    client = _async_client(settings)
    content: list[dict] = []
    if step_image is not None:
        content += [{"type": "text", "text": f"Manual picture for step {step.step}:"}, _png(step_image)]
    if frame_b64:
        content += [{"type": "text", "text": "Camera, the real build now:"}, _jpeg_b64(frame_b64)]
    recent = "\n".join(f"Builder: {q}\nBuildSight: {a}" for q, a in (history or []))
    if recent:
        content.append({"type": "text", "text": f"Recent conversation:\n{recent}"})
    content.append({"type": "text", "text": f"I'm on step {step.step}. {question}"})
    response = await client.beta.messages.create(
        model=settings.check_model,
        max_tokens=2000,
        # The manual text is identical on every question about this build, so cache it.
        system=[{"type": "text", "text": _answer_system(build), "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": content}],
        output_config={"effort": settings.check_effort},
        betas=[FALLBACK_BETA],
        fallbacks="default",
    )
    if response.stop_reason == "refusal":
        raise VisionUnavailable("refused")
    return "".join(b.text for b in response.content if b.type == "text").strip()


# ── manual ingestion (run once per manual, offline) ──────────────────────────
INGEST_SYSTEM = """You turn one page of a picture-based instruction manual (LEGO, IKEA, work instructions) into step records.
For every numbered step on the page:
- step: the step number printed in the manual.
- parts: every part added in this step, from the parts callout (name with size, e.g. "brick 2x4", "slope 2x2", "long bolt"; color; qty).
- action: one short imperative sentence saying where it goes and which way it faces.
- watch_for: the mistakes a builder is likely to make here (orientation, left vs right, which hole). Empty if none stand out.
- crop: the box around this step's main assembly picture (not the parts callout, not other steps). Coordinates are 0-1000 on EACH axis: x runs 0 (left edge) to 1000 (right edge) and y runs 0 (top edge) to 1000 (bottom edge), whatever the page's shape, so a landscape page still ends at 1000 both ways. x0, y0 is the top-left corner; x1, y1 the bottom-right. Make the box tight around the drawing.
Pages with no numbered steps (covers, parts lists, ads) return an empty list. Never invent a step that isn't drawn."""


def extract_page(settings, *, page_png: bytes, page_number: int, title: str, page_size: tuple[int, int],
                 model: str | None = None, effort: str = "high") -> PageExtraction:
    """Synchronous (the script calls it directly; in-app imports run it in a worker thread)."""
    if not settings.anthropic_api_key:
        raise VisionUnavailable("ANTHROPIC_API_KEY is not set")
    from anthropic import Anthropic

    client = Anthropic(api_key=settings.anthropic_api_key)
    with client.beta.messages.stream(
        model=model or settings.ingest_model,
        max_tokens=32000,
        system=INGEST_SYSTEM,
        messages=[{"role": "user", "content": [
            _image_block(page_png, "image/png"),
            {"type": "text", "text": f"Manual: {title}. This is page {page_number}. The page image is {page_size[0]}x{page_size[1]} pixels; give crops on the 0-1000 scale described above."},
        ]}],
        output_format=PageExtraction,
        output_config={"effort": effort},
        betas=[FALLBACK_BETA],
        fallbacks="default",
    ) as stream:
        response = stream.get_final_message()
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise VisionUnavailable(f"page {page_number}: no usable answer (stop_reason={response.stop_reason})")
    return response.parsed_output
