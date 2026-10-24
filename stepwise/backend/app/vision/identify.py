"""Identify the machine and part in a camera frame.

Provider order: Claude vision (``ANTHROPIC_API_KEY``) -> local.
Every provider answers with the same ``Identification``. The result is only a *hint*: the
asset id is resolved against the catalog (an unknown machine stays ``None``), and anything
below ``identify_min_confidence`` makes the guide ask the technician to confirm the machine
before it gives a single step. The local fallback never sees the image, so its confidence is
0 and it always asks.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from dataclasses import asdict, dataclass

from app.data.catalog import catalog

logger = logging.getLogger("stepwise.vision")


@dataclass
class Identification:
    asset_id: str | None
    machine_model: str
    part: str
    confidence: float
    provider: str  # "claude" | "local"
    mock: bool

    def as_dict(self) -> dict:
        return asdict(self)


def _prompt(problem: str) -> str:
    known = "; ".join(
        f"{m.get('nameplate', {}).get('model', key)} ({m.get('nameplate', {}).get('machine_class', 'machine')})"
        for key, m in catalog.machines.items()
    )
    return (
        "You identify industrial and maker equipment for a repair assistant.\n"
        f"Known machines: {known}.\n"
        f"The technician said: {problem!r}.\n"
        "Look at the photo. Reply with ONLY a JSON object: "
        '{"machine_model": "<model name, or unknown>", "part": "<part in view, or unknown>", '
        '"confidence": <0.0-1.0 that the machine_model is right>}. '
        "Use a known machine name when it matches. Never guess a model you can't see."
    )


def _parse(text: str) -> dict:
    match = re.search(r"\{.*\}", text or "", re.S)
    if not match:
        return {}
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _from_reply(data: dict, provider: str) -> Identification:
    model = str(data.get("machine_model") or "unknown")
    try:
        confidence = max(0.0, min(1.0, float(data.get("confidence", 0))))
    except (TypeError, ValueError):
        confidence = 0.0
    asset = catalog.resolve_machine(model) if model.lower() != "unknown" else None
    if asset is None:
        confidence = 0.0  # not in the catalog -> no grounded procedures, treat as unidentified
    return Identification(asset, model, str(data.get("part") or "unknown"), confidence, provider, mock=False)


def local_identify(problem: str) -> Identification:
    """No vision provider: infer a *candidate* from the words alone, always at confidence 0."""
    asset = catalog.resolve_machine(problem)
    if asset is None:
        proc = catalog.procedure_for_problem(problem)
        asset = catalog.procedure_machine(proc) if proc else None
    model = (catalog.machine(asset) or {}).get("nameplate", {}).get("model", "unknown") if asset else "unknown"
    return Identification(asset, model, "unknown", 0.0, "local", mock=True)


async def _claude(image_b64: str, problem: str, settings) -> Identification:
    from anthropic import Anthropic

    client = Anthropic(api_key=settings.anthropic_api_key)

    def call() -> str:
        msg = client.messages.create(
            model=settings.anthropic_model,
            max_tokens=200,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}},
                {"type": "text", "text": _prompt(problem)},
            ]}],
        )
        return "".join(getattr(b, "text", "") for b in msg.content)

    return _from_reply(_parse(await asyncio.to_thread(call)), "claude")


async def identify(image_b64: str | None, problem: str, settings) -> Identification:
    if image_b64 and settings.claude_configured:
        try:
            base64.b64decode(image_b64, validate=True)
            return await _claude(image_b64, problem, settings)
        except Exception as exc:  # noqa: BLE001 — fall back to the local candidate
            logger.warning("claude identify failed: %r", exc)
    return local_identify(problem)
