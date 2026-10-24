"""
WebRTC media plumbing (aiortc / PyAV / OpenCV).
===============================================

Responsibilities:
  * GeminiAudioTrack  — an OUTBOUND aiortc audio track that plays the AI's
    24 kHz PCM16 speech back to the browser / AR glasses. We accept raw PCM
    pushed in from the Gemini layer, resample 24k -> 48k, and emit paced 20 ms
    frames (with silence fill so RTP keeps flowing during gaps).
  * frame_to_jpeg()        — INBOUND video frame -> downscaled JPEG bytes.
  * audioframe_to_pcm16()  — INBOUND audio frame -> 16 kHz mono PCM16 bytes.

This module is intentionally Gemini-agnostic: it only moves bytes/samples.
"""
from __future__ import annotations

import asyncio
import fractions
import logging
import time

import av
import cv2
import numpy as np
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack

import config

logger = logging.getLogger("webrtc_tracks")

# Outbound track runs at 48 kHz mono — the canonical rate aiortc's Opus encoder
# expects, so no surprises at the codec layer.
OUTPUT_RATE = 48_000
OUTPUT_LAYOUT = "mono"
OUTPUT_FORMAT = "s16"
FRAME_DURATION_MS = 20
SAMPLES_PER_FRAME = OUTPUT_RATE * FRAME_DURATION_MS // 1000  # 960 samples
BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2                       # s16 = 2 bytes/sample

# Speech must play at real time, so a turn's audio (delivered by Gemini in a
# fast burst) is buffered and drained at 1x. This cap is a safety valve only:
# it bounds memory if a runaway/very long turn is generated. Normal short
# replies stay far below it.
MAX_BUFFER_SECONDS = 20
MAX_BUFFER_BYTES = OUTPUT_RATE * MAX_BUFFER_SECONDS * 2


def _resample(resampler: av.AudioResampler, frame: av.AudioFrame) -> list[av.AudioFrame]:
    """Normalize PyAV's resampler return value to a list of frames.

    PyAV >= 9 returns a list; older versions return a single frame or None.
    """
    out = resampler.resample(frame)
    if out is None:
        return []
    if isinstance(out, list):
        return out
    return [out]


# ---------------------------------------------------------------------------
# Inbound conversion helpers
# ---------------------------------------------------------------------------
def frame_to_jpeg(
    frame: av.VideoFrame,
    max_width: int = None,
    quality: int = None,
) -> bytes | None:
    """Convert an inbound video frame to downscaled JPEG bytes for Gemini.

    Fast path: downscale + colorspace-convert in ONE swscale pass via PyAV's
    frame.reformat() — converting at the TARGET size instead of converting the
    full-resolution frame first and resizing after (that wasted a full-res
    BGR conversion every frame). Falls back to the original to_ndarray +
    cv2.resize path if reformat fails for any reason.

    Synchronous + self-contained on purpose: the caller runs it in a worker
    thread (asyncio.to_thread) so the multi-ms encode never stalls the event
    loop that paces the AI's 20 ms voice frames.
    """
    max_width = max_width or config.VIDEO_MAX_WIDTH
    quality = quality or config.VIDEO_JPEG_QUALITY

    img = None
    w = getattr(frame, "width", 0) or 0
    h = getattr(frame, "height", 0) or 0
    if w > max_width and h > 0:
        # Single-pass scale+convert at the target geometry (no upscaling).
        target_w = max_width
        target_h = max(1, int(h * (max_width / float(w))))
        try:
            img = frame.reformat(width=target_w, height=target_h, format="bgr24").to_ndarray()
        except Exception:  # noqa: BLE001 - fall back to the two-pass path
            logger.debug("frame.reformat failed; falling back to to_ndarray+resize", exc_info=True)
            img = None

    if img is None:
        try:
            img = frame.to_ndarray(format="bgr24")
        except Exception:  # noqa: BLE001
            logger.exception("Failed to convert video frame to ndarray")
            return None
        ih, iw = img.shape[:2]
        if iw > max_width:
            scale = max_width / float(iw)
            img = cv2.resize(
                img, (max_width, max(1, int(ih * scale))), interpolation=cv2.INTER_AREA
            )

    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        logger.warning("cv2.imencode failed for video frame")
        return None
    return buf.tobytes()


class InboundAudioConverter:
    """Resamples inbound browser audio frames to 16 kHz mono PCM16 for Gemini.

    Kept as a stateful object because PyAV's resampler carries internal buffer
    state across calls; reusing one instance per track yields clean audio.
    """

    def __init__(self) -> None:
        self._resampler = av.AudioResampler(
            format="s16", layout="mono", rate=config.GEMINI_INPUT_SAMPLE_RATE
        )

    def to_pcm16(self, frame: av.AudioFrame) -> bytes:
        out = bytearray()
        for f in _resample(self._resampler, frame):
            out += f.to_ndarray().astype("<i2").tobytes()
        return bytes(out)


# ---------------------------------------------------------------------------
# Outbound AI-voice track
# ---------------------------------------------------------------------------
class GeminiAudioTrack(MediaStreamTrack):
    """Outbound audio track that streams the AI's spoken responses.

    Gemini hands us 24 kHz PCM16. We resample to 48 kHz mono, buffer it, and
    emit real-time-paced 20 ms frames from recv(). When the buffer is empty we
    emit silence so the RTP stream (and the browser's audio element) stays
    healthy. `clear()` supports barge-in (model interrupted -> drop queued audio).
    """

    kind = "audio"

    def __init__(self) -> None:
        super().__init__()
        self._buffer = bytearray()
        self._pts = 0                          # monotonic sample count, for frame.pts
        self._next_time: float | None = None   # monotonic wall-clock frame deadline
        # 24k (Gemini) -> 48k (track) mono resampler.
        self._resampler = av.AudioResampler(
            format=OUTPUT_FORMAT, layout=OUTPUT_LAYOUT, rate=OUTPUT_RATE
        )

    def push_pcm24k(self, pcm: bytes) -> None:
        """Feed raw 24 kHz mono PCM16 bytes from the Gemini layer."""
        if not pcm:
            return
        samples = np.frombuffer(pcm, dtype="<i2")
        if samples.size == 0:
            return
        frame = av.AudioFrame.from_ndarray(
            samples.reshape(1, -1), format="s16", layout="mono"
        )
        frame.sample_rate = config.GEMINI_OUTPUT_SAMPLE_RATE
        chunk = bytearray()
        for f in _resample(self._resampler, frame):
            chunk += f.to_ndarray().astype("<i2").tobytes()
        if not chunk:
            return
        # The asyncio loop is single-threaded, so appending here (called from the
        # Gemini receive loop) races nothing with recv() (the aiortc sender).
        self._buffer += chunk
        # Safety valve: bound buffered audio so a runaway turn can't grow memory.
        if len(self._buffer) > MAX_BUFFER_BYTES:
            overflow = len(self._buffer) - MAX_BUFFER_BYTES
            del self._buffer[:overflow]
            logger.warning("Outbound audio buffer over %ds; dropped %d bytes",
                           MAX_BUFFER_SECONDS, overflow)

    def clear(self) -> None:
        """Drop any buffered audio (barge-in / model interruption).

        Also REBUILD the resampler: av.AudioResampler carries internal filter
        state across calls, so the interrupted turn's tail would otherwise bleed
        into the first chunk of the next response as an audible click. A fresh
        resampler starts the next turn clean (the interrupted samples are being
        dropped anyway, so nothing legitimate is lost).
        """
        self._buffer.clear()
        self._resampler = av.AudioResampler(
            format=OUTPUT_FORMAT, layout=OUTPUT_LAYOUT, rate=OUTPUT_RATE
        )

    async def recv(self) -> av.AudioFrame:
        if self.readyState != "live":
            raise MediaStreamError

        # Real-time pacing on a MONOTONIC clock (immune to NTP/DST wall-clock
        # jumps that could otherwise stall or burst the stream).
        now = time.monotonic()
        if self._next_time is None:
            self._next_time = now
        delay = self._next_time - now
        if delay > 0:
            await asyncio.sleep(delay)
        self._next_time += FRAME_DURATION_MS / 1000.0
        # If the loop stalled and we're far behind schedule, re-anchor to "now"
        # rather than emitting a burst of frames to catch up (which garbles audio).
        if time.monotonic() - self._next_time > 0.2:
            self._next_time = time.monotonic()

        # Pull exactly one frame's worth of audio, padding with silence.
        if len(self._buffer) >= BYTES_PER_FRAME:
            data = bytes(self._buffer[:BYTES_PER_FRAME])
            del self._buffer[:BYTES_PER_FRAME]
        else:
            data = bytes(self._buffer) + b"\x00" * (BYTES_PER_FRAME - len(self._buffer))
            self._buffer.clear()

        samples = np.frombuffer(data, dtype="<i2").reshape(1, -1)
        frame = av.AudioFrame.from_ndarray(samples, format=OUTPUT_FORMAT, layout=OUTPUT_LAYOUT)
        frame.sample_rate = OUTPUT_RATE
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, OUTPUT_RATE)
        self._pts += SAMPLES_PER_FRAME
        return frame
