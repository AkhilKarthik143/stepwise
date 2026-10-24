"""Image GENERATION via Gemini's image model (the /generate-image endpoint).

Turns a text prompt into a generated raster image — e.g. "show what the fully
assembled valve looks like". Uses the same GEMINI_API_KEY. The bytes-extraction
is a small pure helper (unit-tested with fakes); the SDK call is isolated so it
can be mocked. Never leaks the API key.
"""
from __future__ import annotations

import base64

import config

_MAX_PROMPT = 2000


class ImageGenUnavailable(Exception):
    """Generation can't run (not configured, empty prompt, or no image returned)."""


def extract_inline_image(parts) -> tuple[bytes, str] | None:
    """Return (bytes, mime_type) of the first inline image in a list of response
    parts, or None. Each part is expected to expose `.inline_data.data` (+ mime).
    Pure — works with the SDK's objects or simple fakes."""
    for p in parts or []:
        inline = getattr(p, "inline_data", None)
        data = getattr(inline, "data", None) if inline is not None else None
        if data:
            mime = getattr(inline, "mime_type", None) or "image/png"
            return data, mime
    return None


async def generate(prompt: str) -> tuple[str, str]:
    """Generate an image from `prompt`; return (base64_png, mime_type)."""
    if not config.GEMINI_API_KEY:
        raise ImageGenUnavailable("Image generation not configured (set GEMINI_API_KEY).")
    p = (prompt or "").strip()[:_MAX_PROMPT]
    if not p:
        raise ImageGenUnavailable("Empty prompt.")
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=config.GEMINI_API_KEY)
        resp = await client.aio.models.generate_content(
            model=config.GEMINI_IMAGE_MODEL,
            contents=[{"role": "user", "parts": [{"text": p}]}],
            config=types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"]),
        )
        parts = resp.candidates[0].content.parts  # type: ignore[index]
        found = extract_inline_image(parts)
    except ImageGenUnavailable:
        raise
    except Exception as e:  # noqa: BLE001 — never leak internals / the key
        raise ImageGenUnavailable("The image model is temporarily unavailable.") from e
    if not found:
        raise ImageGenUnavailable("The model did not return an image.")
    data, mime = found
    return base64.b64encode(data).decode("ascii"), mime
