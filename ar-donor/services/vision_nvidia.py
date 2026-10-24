"""NVIDIA-hosted VLM recognizer (build.nvidia.com).

A specialized, commercially-licensed vision model used as a second set of eyes on
a still image: identify the equipment/components and read any visible text, model
numbers, and part numbers. It augments Gemini's live vision — great for OCR of
nameplates and dense detection — and runs entirely on NVIDIA's hosted GPUs (no
local GPU, no model weights to manage).

Transport: the OpenAI-compatible Chat Completions API at
    https://integrate.api.nvidia.com/v1/chat/completions
Auth: Bearer <NVIDIA_API_KEY> (an "nvapi-..." key). Images are passed inline as a
data URL. Default model: meta/llama-3.2-90b-vision-instruct (swappable via env to
any VLM in the build.nvidia.com catalog).

Optional: if NVIDIA_API_KEY is unset the recognizer is simply unavailable and the
rest of the app is unaffected.
"""
from __future__ import annotations

import httpx

import config

ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions"

_DEFAULT_PROMPT = (
    "You are a maintenance vision expert examining a photo from a technician. "
    "Identify the equipment and visible components, and read ALL visible text — "
    "especially model numbers, part numbers, serial numbers, ratings, and warning "
    "labels. Reply concisely as short bullet points. If text is unreadable, say so."
)


class VisionUnavailable(Exception):
    """The recognizer can't run (not configured, bad input, or upstream error)."""


def build_payload(image_b64: str, prompt: str = "") -> dict:
    """Pure builder for the OpenAI-compatible request body. Kept separate so the
    request shape is unit-testable without any network call. Accepts a raw base64
    string OR a full data URL; raises VisionUnavailable on empty input."""
    if not (isinstance(image_b64, str) and image_b64.strip()):
        raise VisionUnavailable("No image provided.")
    img = image_b64.strip()
    data_url = img if img.startswith("data:") else f"data:image/jpeg;base64,{img}"
    text = (prompt or "").strip() or _DEFAULT_PROMPT
    return {
        "model": config.NVIDIA_VLM_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": text},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        "max_tokens": config.NVIDIA_VLM_MAX_TOKENS,
        "temperature": 0.2,
        "stream": False,
    }


def parse_reply(data: dict) -> str:
    """Extract the assistant text from an OpenAI-compatible response; raise on a
    shape we don't recognize."""
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise VisionUnavailable("Unexpected NVIDIA VLM response.") from e
    if not isinstance(content, str) or not content.strip():
        raise VisionUnavailable("Empty NVIDIA VLM response.")
    return content.strip()


async def recognize(image_b64: str, prompt: str = "") -> str:
    """Send one image to the NVIDIA VLM and return its detection text. Never leaks
    the API key; raises VisionUnavailable on any failure."""
    if not config.NVIDIA_API_KEY:
        raise VisionUnavailable("Recognizer not configured (set NVIDIA_API_KEY).")
    payload = build_payload(image_b64, prompt)
    headers = {
        "Authorization": f"Bearer {config.NVIDIA_API_KEY}",
        "Accept": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=config.NVIDIA_VLM_TIMEOUT_SECONDS) as client:
            resp = await client.post(ENDPOINT, json=payload, headers=headers)
    except Exception as e:  # noqa: BLE001 — network/timeout
        raise VisionUnavailable("Could not reach the NVIDIA recognizer.") from e
    if resp.status_code != 200:
        raise VisionUnavailable(f"NVIDIA recognizer returned {resp.status_code}.")
    try:
        return parse_reply(resp.json())
    except VisionUnavailable:
        raise
    except Exception as e:  # noqa: BLE001
        raise VisionUnavailable("Bad NVIDIA recognizer response.") from e
