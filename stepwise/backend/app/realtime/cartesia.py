"""Cartesia voice adapters: Sonic TTS (voice out) and Ink STT with turn detection (voice in).

Both follow the official ``cartesia`` Python client (v4.x). TTS uses ``client.tts.generate``
(raw PCM s16le 24 kHz, the format the browser player already schedules). STT uses
``client.stt.auto_finalize.websocket`` and hands each ``turn.end`` transcript to the gateway,
so Cartesia's turn detection decides when the technician has finished talking. Without
credentials or the SDK both raise ``CartesiaUnavailable`` and the browser speech path is used.
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
from typing import AsyncIterator, Awaitable, Callable

logger = logging.getLogger("stepwise.cartesia")

TTS_SAMPLE_RATE = 24000


class CartesiaUnavailable(RuntimeError):
    pass


def status(api_key: str = "") -> dict[str, object]:
    installed = importlib.util.find_spec("cartesia") is not None
    return {"configured": bool(api_key), "sdk_installed": installed, "provider": "cartesia" if api_key and installed else "mock"}


def available(api_key: str) -> bool:
    return bool(api_key) and importlib.util.find_spec("cartesia") is not None


class CartesiaTTS:
    def __init__(self, api_key: str, voice_id: str, model_id: str = "sonic-latest") -> None:
        self.api_key = api_key
        self.voice_id = voice_id
        self.model_id = model_id
        self._client = None

    async def stream(self, transcript: str) -> AsyncIterator[bytes]:
        """Yield PCM16 chunks with an even byte length (the browser reads them as Int16Array)."""
        if not available(self.api_key):
            raise CartesiaUnavailable("Cartesia credentials or the optional SDK are missing")
        if self._client is None:
            from cartesia import AsyncCartesia

            self._client = AsyncCartesia(api_key=self.api_key)
        resp = await self._client.tts.generate(
            model_id=self.model_id,
            transcript=transcript,
            voice={"id": self.voice_id},
            output_format={"container": "raw", "encoding": "pcm_s16le", "sample_rate": TTS_SAMPLE_RATE},
        )
        carry = b""
        async for chunk in resp.iter_bytes():
            data = carry + chunk
            cut = len(data) - (len(data) % 2)
            carry = data[cut:]
            if cut:
                yield data[:cut]


class CartesiaSTT:
    """One live Ink STT websocket per browser connection. ``send`` streams 16 kHz PCM16."""

    def __init__(
        self,
        api_key: str,
        model: str,
        sample_rate: int,
        on_partial: Callable[[str], Awaitable[None]],
        on_final: Callable[[str], Awaitable[None]],
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.sample_rate = sample_rate
        self.on_partial = on_partial
        self.on_final = on_final
        self._manager = None
        self._conn = None
        self._task: asyncio.Task | None = None

    @property
    def connected(self) -> bool:
        return self._conn is not None

    async def start(self) -> None:
        if not available(self.api_key):
            raise CartesiaUnavailable("Cartesia credentials or the optional SDK are missing")
        from cartesia import AsyncCartesia

        client = AsyncCartesia(api_key=self.api_key)
        self._manager = client.stt.auto_finalize.websocket(encoding="pcm_s16le", model=self.model, sample_rate=self.sample_rate)
        self._conn = await self._manager.__aenter__()
        self._task = asyncio.create_task(self._receive(), name="stepwise-cartesia-stt")

    async def send(self, pcm: bytes) -> None:
        if self._conn is None:
            await self.start()
        await self._conn.send_raw(pcm)

    async def _receive(self) -> None:
        try:
            async for event in self._conn:
                kind = getattr(event, "type", "")
                if kind == "turn.update" and event.transcript:
                    await self.on_partial(event.transcript)
                elif kind == "turn.end" and event.transcript.strip():
                    await self.on_final(event.transcript.strip())
                elif kind == "error":
                    logger.warning("cartesia stt error: %s", getattr(event, "message", event))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a dropped STT socket reopens on the next audio
            logger.warning("cartesia stt receive ended: %r", exc)
        finally:
            self._conn = None

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
        if self._manager is not None:
            try:
                await self._manager.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001
                pass
        self._conn = None
        self._manager = None
