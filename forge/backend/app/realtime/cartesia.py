"""Optional Cartesia capability adapter.

The integration point follows the official ``cartesia`` Python client (v4.x):
``Cartesia``/``AsyncCartesia`` and ``client.tts.generate``. Live audio is not
enabled without credentials; the browser text/mock path remains complete.
"""

from __future__ import annotations

import importlib.util


class CartesiaUnavailable(RuntimeError):
    pass


def status(api_key: str = "") -> dict[str, object]:
    installed = importlib.util.find_spec("cartesia") is not None
    return {"configured": bool(api_key), "sdk_installed": installed, "provider": "cartesia" if api_key and installed else "mock"}


class CartesiaTTS:
    def __init__(self, api_key: str, voice_id: str, model_id: str = "sonic-latest") -> None:
        self.api_key = api_key
        self.voice_id = voice_id
        self.model_id = model_id

    async def generate(self, transcript: str):
        if not self.api_key or importlib.util.find_spec("cartesia") is None:
            raise CartesiaUnavailable("Cartesia credentials or the optional SDK are missing")
        from cartesia import AsyncCartesia

        client = AsyncCartesia(api_key=self.api_key)
        # The official SDK call is intentionally returned to the transport layer;
        # this adapter does not invent a browser audio framing format.
        return await client.tts.generate(
            model_id=self.model_id,
            transcript=transcript,
            voice=self.voice_id,
            output_format={"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000},
        )
