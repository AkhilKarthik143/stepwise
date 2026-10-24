"""Text/vision CHAT (separate from the live voice session).

A stateless request/response chat over Gemini's standard multimodal model: the
user sends text and (optionally) an image, and gets a text answer back. Used by
the /chat endpoint so the app has a typed chat lane alongside the live voice call
— handy in loud environments, for attaching a photo, or for follow-up questions.

The content-building is a pure function (unit-tested); the Gemini SDK call is
isolated so it can be mocked. Never leaks the API key.
"""
from __future__ import annotations

import base64

import config

_SYSTEM = (
    "You are the AR Technician Assistant — a concise, practical field-service "
    "expert. Answer the technician's question directly. Prefer numbered steps for "
    "procedures, name specific parts/tools, and call out any safety concern. If an "
    "image is attached, use it. Keep answers short unless asked to elaborate."
)

_MAX_TEXT = 4000
_MAX_TURNS = 16


class ChatUnavailable(Exception):
    """Chat can't run (not configured, empty message, or upstream error)."""


def build_contents(text: str, image_b64: str = "", history=None) -> list[dict]:
    """Pure builder for the Gemini `contents` list (plain dicts the SDK accepts).
    History is prior turns [{'role':'user'|'assistant','text':...}]. The image (raw
    base64 or a data URL) is decoded to bytes for an inline_data part. Raises on an
    empty final message or undecodable image."""
    contents: list[dict] = []
    for turn in (history or [])[-_MAX_TURNS:]:
        if not isinstance(turn, dict):
            continue
        role = "model" if str(turn.get("role")) in ("assistant", "model") else "user"
        t = str(turn.get("text") or "").strip()[:_MAX_TEXT]
        if t:
            contents.append({"role": role, "parts": [{"text": t}]})

    parts: list[dict] = []
    txt = (text or "").strip()[:_MAX_TEXT]
    if txt:
        parts.append({"text": txt})
    if image_b64 and image_b64.strip():
        raw = image_b64.strip()
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[1] if "," in raw else ""
        try:
            data = base64.b64decode(raw, validate=False)
        except Exception as e:  # noqa: BLE001
            raise ChatUnavailable("Could not decode the attached image.") from e
        if not data:
            raise ChatUnavailable("Empty image.")
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": data}})
    if not parts:
        raise ChatUnavailable("Empty message.")
    contents.append({"role": "user", "parts": parts})
    return contents


async def chat(text: str, image_b64: str = "", history=None) -> str:
    """Send one chat turn to Gemini and return the text reply."""
    if not config.GEMINI_API_KEY:
        raise ChatUnavailable("Chat not configured (set GEMINI_API_KEY).")
    contents = build_contents(text, image_b64, history)
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=config.GEMINI_API_KEY)
        resp = await client.aio.models.generate_content(
            model=config.GEMINI_CHAT_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=_SYSTEM,
                temperature=0.4,
                max_output_tokens=config.GEMINI_CHAT_MAX_TOKENS,
            ),
        )
    except ChatUnavailable:
        raise
    except Exception as e:  # noqa: BLE001 — never leak internals / the key
        raise ChatUnavailable("The chat model is temporarily unavailable.") from e
    reply = (getattr(resp, "text", None) or "").strip()
    if not reply:
        raise ChatUnavailable("The chat model returned an empty answer.")
    return reply
