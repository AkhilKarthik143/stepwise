"""
AR Technician Assistant — FastAPI + aiortc WebRTC server.
=========================================================

This is the WebRTC *transport* layer and the media-processing orchestrator:

  * Serves the WebXR frontend (/ and /static).
  * /offer negotiates an aiortc RTCPeerConnection with the browser/AR glasses.
  * For each connection a `PeerSession`:
      - Video: pulls frames from the inbound WebRTC video track, downscales +
        JPEG-encodes them with OpenCV at <= VIDEO_FPS (Gemini Live's 1 fps cap),
        and feeds them to the Gemini bridge.
      - Audio (mic): pulls inbound audio frames, resamples to 16 kHz mono PCM16,
        and feeds them to Gemini.
      - AI output: Gemini's 24 kHz PCM speech is resampled to 48 kHz and pushed
        onto the outbound WebRTC audio track that plays on the AR glasses.
      - Tool calls: `query_technical_manual` is routed to the NotebookLM RAG
        service and the grounded answer is returned to Gemini;
        `annotate_component` / `clear_annotations` are forwarded to the client
        as AR-overlay events over the "events" WebRTC data channel, which also
        carries typed user text upstream (client -> Gemini).

The Gemini WebSocket protocol lives in services/gemini_bridge.py; the RAG tool in
services/knowledge.py; the media codecs/track in services/webrtc_tracks.py. This
file only orchestrates transport + lifecycle.

Run:
    python main.py
    uvicorn main:app --host 0.0.0.0 --port 8443 \
        --ssl-certfile certs/cert.pem --ssl-keyfile certs/key.pem
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import secrets
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.mediastreams import MediaStreamError
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

import config
from services import knowledge
from services.gemini_bridge import GeminiBridge
from services.metrics import metrics
from services.webrtc_tracks import (
    GeminiAudioTrack,
    InboundAudioConverter,
    frame_to_jpeg,
)

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-7s [%(name)s] %(message)s",
)
logger = logging.getLogger("main")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

_sessions: set["PeerSession"] = set()

# Per-IP sliding-window rate limiter for /offer (in-memory, single-worker).
_rate_buckets: dict[str, deque] = {}
# Strong refs to fire-and-forget teardown tasks so they aren't GC'd mid-await.
_cleanup_tasks: set = set()
# True while the lifespan exit is draining sessions: new /offer attempts get 503
# instead of joining a server that's about to disappear under them.
_shutting_down = False
# Offers past the cheap gates but not yet registered in _sessions. The notebook
# switch guard must see these too — otherwise an /offer awaiting its body can
# straddle the swap (TOCTOU) and start a session against the new notebook while
# the switch believed the server was idle.
_offers_inflight = 0


class _SessionLogAdapter(logging.LoggerAdapter):
    """Per-session log tag WITHOUT logger.getChild: the logging module retains
    every named logger forever, so per-session child loggers would accumulate
    unboundedly on a long-lived server. An adapter is a plain object, GC'd with
    the session, and keeps the greppable [s<id>] prefix."""

    def process(self, msg, kwargs):
        return f"[s{self.extra['sid']}] {msg}", kwargs


def _sync_session_gauge() -> None:
    """Keep the sessions_active metric in lock-step with the live session set."""
    metrics.set_gauge("sessions_active", len(_sessions))


def _turn_urls() -> list[str]:
    """TURN_URL may be ONE url or a comma-separated list of transports that share
    a single credential, e.g.
        turn:host:80,turn:host:443,turns:host:443?transport=tcp
    Providing several lets the browser fall back to TCP/TLS:443 when a network
    (cellular, locked-down Wi-Fi) blocks plain UDP — the common cause of an ICE
    'failed' on an otherwise-correct deploy. Parsed at use time so a monkeypatched
    config.TURN_URL is honoured in tests."""
    return [u.strip() for u in config.TURN_URL.split(",") if u.strip()]


def _ice_servers_json() -> list[dict]:
    """ICE servers for the browser RTCPeerConnection (STUN + optional TURN)."""
    servers: list[dict] = []
    if config.STUN_URL:
        servers.append({"urls": config.STUN_URL})
    turn = _turn_urls()
    if turn:
        servers.append(
            {
                # `urls` may be a string or an array per the WebRTC spec.
                "urls": turn if len(turn) > 1 else turn[0],
                "username": config.TURN_USERNAME,
                "credential": config.TURN_CREDENTIAL,
            }
        )
    return servers


def _rtc_ice_servers() -> list[RTCIceServer]:
    """The same ICE servers for the server-side aiortc PeerConnection."""
    servers: list[RTCIceServer] = []
    if config.STUN_URL:
        servers.append(RTCIceServer(urls=config.STUN_URL))
    turn = _turn_urls()
    if turn:
        servers.append(
            RTCIceServer(
                urls=turn if len(turn) > 1 else turn[0],  # aiortc accepts str | list
                username=config.TURN_USERNAME or None,
                credential=config.TURN_CREDENTIAL or None,
            )
        )
    return servers


def _client_ip(request: Request) -> str:
    # X-Forwarded-For is client-spoofable; only trust it behind a known proxy
    # (TRUST_FORWARDED_FOR), else use the real socket peer. Trusting it blindly
    # lets an attacker rotate the header to bypass the limiter and grow memory.
    if config.TRUST_FORWARDED_FOR:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limited(ip: str) -> bool:
    """True if `ip` has exceeded RATE_LIMIT_PER_MIN /offer requests in 60s.

    Bounds memory: empty buckets are removed, and the tracked-IP count is capped
    (oldest evicted) so a flood of distinct IPs can't grow the dict without limit.
    """
    limit = config.RATE_LIMIT_PER_MIN
    if limit <= 0:
        return False
    now = time.monotonic()
    bucket = _rate_buckets.get(ip)
    if bucket is None:
        # Cap distinct tracked IPs (evict oldest-inserted) before adding a new one.
        while len(_rate_buckets) >= config.RATE_LIMIT_MAX_IPS:
            _rate_buckets.pop(next(iter(_rate_buckets)), None)
        bucket = _rate_buckets[ip] = deque()
    while bucket and now - bucket[0] > 60.0:
        bucket.popleft()
    if len(bucket) >= limit:
        return True
    bucket.append(now)
    return False


def _provided_token(request: Request) -> str:
    provided = request.headers.get("x-api-key", "")
    if not provided:
        authz = request.headers.get("authorization", "")
        if authz.lower().startswith("bearer "):
            provided = authz[7:].strip()
    return provided


def _identity(request: Request) -> dict | None:
    """{'email','company'} for a valid caller, else None. Accepts per-user signed
    tokens (multi-tenant) and the legacy shared token (maps to 'default')."""
    from services import tenant_auth

    if not config.API_AUTH_TOKEN:
        return {"email": "", "company": "default"}  # auth disabled (dev)
    return tenant_auth.verify_token(_provided_token(request))


def _auth_ok(request: Request) -> bool:
    """True if no token is configured, or the request carries a valid one."""
    return _identity(request) is not None


# ===========================================================================
# Per-connection session: media pumps + Gemini bridge + RAG tool dispatch.
# ===========================================================================
class PeerSession:
    def __init__(self, pc: RTCPeerConnection) -> None:
        self.pc = pc
        # Per-session id + scoped logger: every line this session emits carries
        # [s<id>], so interleaved multi-session logs stay attributable.
        self.sid = secrets.token_hex(4)
        self._log = _SessionLogAdapter(logger, {"sid": self.sid})
        # Outbound track carrying the AI's voice back to the glasses.
        self.out_track = GeminiAudioTrack()
        self.bridge = GeminiBridge(
            on_audio_out=self.out_track.push_pcm24k,
            tool_dispatch=self._dispatch_tool,
            on_interrupt=self.out_track.clear,
            on_text=lambda t: self._log.info("Gemini text: %s", t.strip()),
            on_transcript=self._on_transcript,
            on_input_transcript=self._on_input_transcript,
            on_turn_complete=self._on_turn_complete,
            on_session_end=self._on_gemini_session_end,
            on_reconnecting=self._on_gemini_reconnecting,
            on_reconnected=self._on_gemini_reconnected,
        )
        self._audio_converter = InboundAudioConverter()
        self._pump_tasks: list[asyncio.Task] = []
        self._watchdog: asyncio.Task | None = None
        self._prewarm_task: asyncio.Task | None = None
        self._events_dc = None  # client-created RTCDataChannel for UI events
        self._lookups_inflight = 0  # refcount for the "Checking the manual" indicator
        self._started = time.monotonic()
        self._last_media = time.monotonic()  # updated by both media pumps
        self._reaper_task: asyncio.Task | None = None
        self._closed = False
        pc.addTrack(self.out_track)

    # -- client event channel (AR annotations, etc.) -----------------------
    def attach_data_channel(self, channel) -> None:
        self._events_dc = channel
        self._log.info("Data channel '%s' attached.", getattr(channel, "label", "?"))
        # Inbound direction (client -> server): typed user text. Registered
        # defensively — fakes/channels without .on() just don't get the handler.
        register = getattr(channel, "on", None)
        if callable(register):
            @channel.on("message")
            def _on_message(message):  # noqa: ANN001
                self._handle_client_message(message)

    # Raw inbound frame cap, DERIVED from the configured text cap (6x covers the
    # worst-case JSON escaping: every char becoming a \uXXXX sequence) plus
    # envelope headroom. A hardcoded cap silently dropped valid messages when an
    # operator raised USER_TEXT_MAX_CHARS.
    _MAX_CLIENT_FRAME = 6 * config.USER_TEXT_MAX_CHARS + 1024

    def _handle_client_message(self, message) -> None:
        """Validate + route one client->server data-channel frame.

        STRICT posture (this is the first server-bound input over the channel):
        text frames only, bounded size, JSON object, known type, string payload,
        length-capped. Anything else is silently dropped — never an exception,
        never an echo back to the model.
        """
        if self._closed:
            return
        if not isinstance(message, str) or len(message) > self._MAX_CLIENT_FRAME:
            # Count frame-size drops so a flood (or a misconfigured client) is
            # observable instead of silently vanishing.
            metrics.inc("user_text_dropped_total", labels={"reason": "frame_size"})
            return
        try:
            msg = json.loads(message)
        except Exception:  # noqa: BLE001
            return
        if not isinstance(msg, dict) or msg.get("type") != "user_text":
            return
        text = msg.get("text")
        if not isinstance(text, str):
            return
        text = text.strip()
        if not text or len(text) > config.USER_TEXT_MAX_CHARS:
            return
        metrics.inc("user_text_total")
        # Typed input IS session activity: a technician conversing by keyboard
        # (loud floor / no mic) must not be idle-reaped mid-conversation.
        self._last_media = time.monotonic()
        self._log.info("User typed: %r", text[:120])
        # Strong ref so the send task isn't GC'd mid-await (same pattern as cleanup).
        task = asyncio.create_task(self.bridge.send_text(text))
        _cleanup_tasks.add(task)
        task.add_done_callback(_cleanup_tasks.discard)

    def send_event(self, event: dict) -> bool:
        """Push a JSON UI event to the client over the data channel."""
        dc = self._events_dc
        if dc is None or getattr(dc, "readyState", None) != "open":
            self._log.debug("No open data channel; dropping event %s", event.get("type"))
            return False
        try:
            dc.send(json.dumps(event))
            return True
        except Exception:  # noqa: BLE001
            self._log.exception("Failed to send data-channel event")
            return False

    def _on_gemini_session_end(self) -> None:
        """Gemini is PERMANENTLY dead (reconnects exhausted) -> tear down."""
        if self._closed:
            return
        self._log.warning("Gemini session ended (unrecoverable) — tearing down PeerSession.")
        # Tell the client WHY (same pattern as the reaper/shutdown): without
        # this the technician watches "Reconnecting…" dissolve into a generic
        # network error and blames their own Wi-Fi for the AI's death.
        self.send_event({"type": "status", "state": "ended", "reason": "ai_lost"})

        async def _flush_then_cleanup() -> None:
            await asyncio.sleep(0.15)  # let the data channel flush the explanation
            await _cleanup(self)

        # Retain a strong ref so the teardown task isn't garbage-collected mid-await.
        task = asyncio.create_task(_flush_then_cleanup())
        _cleanup_tasks.add(task)
        task.add_done_callback(_cleanup_tasks.discard)

    def _on_gemini_reconnecting(self) -> None:
        """Transient Gemini drop -> tell the client we're reconnecting (WebRTC stays up)."""
        self.send_event({"type": "status", "state": "reconnecting"})

    def _on_gemini_reconnected(self) -> None:
        """Gemini link re-established -> clear the reconnecting status on the client."""
        self.send_event({"type": "status", "state": "connected"})

    def _on_transcript(self, text: str) -> None:
        """Incremental caption fragment of the AI's speech -> client caption line."""
        self.send_event({"type": "transcript", "role": "assistant", "text": text})

    def _on_input_transcript(self, text: str) -> None:
        """Incremental transcription of the TECHNICIAN's speech -> 'You' turns."""
        self.send_event({"type": "transcript", "role": "user", "text": text})

    def _on_turn_complete(self) -> None:
        """Model turn finished -> client commits the caption into the transcript."""
        self.send_event({"type": "transcript_done"})

    # -- tool dispatch ------------------------------------------------------
    async def _dispatch_tool(self, name: str, args: dict) -> str:
        if name == config.QUERY_TOOL_NAME:
            metrics.inc("toolcalls_total", labels={"tool": "query"})
            # Tell the client the AI is consulting the manual (rendered as a
            # "Checking the manual…" indicator) and ALWAYS clear it afterwards —
            # the finally fires even if the lookup raises. REFCOUNTED: lookups
            # can overlap (the model may re-ask mid-lookup), and the first one
            # finishing must not clear the indicator while another still runs.
            self._lookups_inflight += 1
            if self._lookups_inflight == 1:
                self.send_event({"type": "activity", "state": "lookup"})
            try:
                query = args.get("query", "")
                answer = await knowledge.fetch_technical_guidance(query)
                # Surface WHICH manual source(s) grounded the answer, so the
                # technician can trust a spoken value. Best-effort: no titles ->
                # no event (the answer is unchanged either way).
                titles = self._sanitize_source_titles(knowledge.last_source_titles(query))
                if titles:
                    metrics.inc("sources_sent_total")
                    self.send_event({"type": "sources", "titles": titles})
                return answer
            finally:
                self._lookups_inflight = max(0, self._lookups_inflight - 1)
                if self._lookups_inflight == 0:
                    self.send_event({"type": "activity", "state": "idle"})
        if name == config.ANNOTATE_TOOL_NAME:
            metrics.inc("toolcalls_total", labels={"tool": "annotate"})
            return self._handle_annotate(args)
        if name == config.ANNOTATE_CLEAR_TOOL_NAME:
            metrics.inc("toolcalls_total", labels={"tool": "clear"})
            return self._handle_clear(args)
        if name == config.TAKE_SNAPSHOT_TOOL_NAME:
            metrics.inc("toolcalls_total", labels={"tool": "snapshot"})
            sent = self.send_event({"type": "snapshot"})
            if sent:
                # Honest ack: the server only knows the request reached the
                # device — the capture itself can still fail client-side. Don't
                # let the model verbally confirm a save it can't verify.
                return (
                    "Asked the technician's device to save a photo of the current "
                    "view with your highlights — it should appear in their downloads."
                )
            return (
                "Couldn't save a photo — the device channel isn't connected. "
                "Tell the technician to use the Snap button instead."
            )
        if name == config.SHOW_MODEL_TOOL_NAME:
            metrics.inc("toolcalls_total", labels={"tool": "show_model"})
            return self._handle_show_model(args)
        if name == config.CLEAR_MODEL_TOOL_NAME:
            metrics.inc("toolcalls_total", labels={"tool": "clear_model"})
            return self._handle_clear_model()
        if name == config.HIGHLIGHT_MODEL_TOOL_NAME:
            metrics.inc("toolcalls_total", labels={"tool": "highlight_model"})
            return self._handle_highlight_model(args)
        if name == config.SET_DIAGRAM_STEP_TOOL_NAME:
            metrics.inc("toolcalls_total", labels={"tool": "set_diagram_step"})
            return self._handle_set_diagram_step(args)
        metrics.inc("toolcalls_total", labels={"tool": "unknown"})
        self._log.warning("Unknown tool requested by model: %s", name)
        return f"Unknown tool '{name}'. No such capability is available."

    @staticmethod
    def _sanitize_step(value) -> int | None:
        """Coerce the step arg to a positive int, else None (omit the badge)."""
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value if value > 0 else None
        if isinstance(value, float) and math.isfinite(value) and value >= 1:
            return int(value)
        if isinstance(value, str):
            try:
                n = int(value.strip())
                return n if n > 0 else None
            except ValueError:
                return None
        return None

    def _handle_annotate(self, args: dict) -> str:
        """Forward a spatial highlight to the client and ack to the model."""
        label = str(args.get("label") or "component").strip()
        detail = str(args.get("detail") or "").strip()
        box = args.get("box")
        if not (
            isinstance(box, list)
            and len(box) == 4
            and all(
                isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n)
                for n in box
            )
        ):
            return (
                f"Could not highlight '{label}' — the bounding box was missing or "
                "malformed (need 4 finite numbers [ymin, xmin, ymax, xmax] normalized 0-1000)."
            )
        # Sanitize the optional presentation fields to known-safe values so a
        # malformed arg can never reach the client as an unexpected shape/level.
        shape = str(args.get("shape") or "box").strip().lower()
        if shape not in config.ANNOTATE_SHAPES:
            shape = "box"
        level = str(args.get("level") or "info").strip().lower()
        if level not in config.ANNOTATE_LEVELS:
            level = "info"
        step = self._sanitize_step(args.get("step"))

        event = {
            "type": "annotate",
            "label": label,
            "detail": detail,
            "box": [float(n) for n in box],
            "shape": shape,
            "level": level,
        }
        if step is not None:
            event["step"] = step
        sent = self.send_event(event)
        if sent:
            metrics.inc("annotations_sent_total", labels={"level": level})
            tag = f" (step {step})" if step is not None else ""
            return f"Highlighted the {label}{tag} in the technician's view."
        return (
            f"Noted the {label}, but the AR overlay channel isn't connected so it "
            "could not be drawn. Continue guiding by voice."
        )

    def _handle_clear(self, args: dict) -> str:
        """Remove one highlight (by label) or all of them from the client view."""
        raw = args.get("label")
        label = str(raw).strip() if isinstance(raw, str) and raw.strip() else None
        sent = self.send_event({"type": "annotate_clear", "label": label})
        if not sent:
            return "No AR overlay channel is connected, so there was nothing to clear."
        metrics.inc("annotations_cleared_total")
        return (
            f"Cleared the '{label}' highlight." if label else "Cleared all highlights."
        )

    @staticmethod
    def _num_list(value, count: int, default: list[float], lo: float, hi: float) -> list[float]:
        """Coerce a model-supplied array into exactly `count` finite, clamped floats.

        Missing/garbage elements fall back to `default` — never NaN/Inf/None reach
        the client renderer.
        """
        out = list(default)
        if isinstance(value, list):
            for i in range(min(count, len(value))):
                v = value[i]
                if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
                    out[i] = max(lo, min(hi, float(v)))
        return out

    @staticmethod
    def _sanitize_source_titles(titles) -> list[str]:
        """Clean a list of grounding-source titles for the client provenance chip.

        Model/RAG-derived, so strictly bounded: list only, str items, stripped,
        truncated to 80, blanks dropped, de-duped (case-insensitive), capped at 3.
        """
        if not isinstance(titles, list):
            return []
        out: list[str] = []
        seen: set[str] = set()
        for t in titles:
            if not isinstance(t, str):
                continue
            norm = " ".join(t.split()).strip()[:80]
            key = norm.lower()
            if not norm or key in seen:
                continue
            seen.add(key)
            out.append(norm)
            if len(out) >= 3:
                break
        return out

    def _sanitize_model_part(self, raw, mode: str) -> dict | None:
        """Validate ONE model primitive; return a clean dict or None to drop it."""
        if not isinstance(raw, dict):
            return None
        shape = str(raw.get("shape") or "").strip().lower()
        shapes = config.MODEL_3D_SHAPES if mode == "3d" else config.MODEL_2D_SHAPES
        if shape not in shapes:
            return None
        color = str(raw.get("color") or "info").strip().lower()
        if color not in config.MODEL_COLORS:
            color = "info"
        label = str(raw.get("label") or "").strip()[:48]
        if mode == "3d":
            part = {
                "shape": shape,
                "position": self._num_list(raw.get("position"), 3, [0.0, 0.0, 0.0], -1000.0, 1000.0),
                "size": self._num_list(raw.get("size"), 3, [1.0, 1.0, 1.0], 0.001, 1000.0),
                "rotation": self._num_list(raw.get("rotation"), 3, [0.0, 0.0, 0.0], -3600.0, 3600.0),
                "color": color,
                "label": label,
            }
        else:
            part = {
                "shape": shape,
                "position": self._num_list(raw.get("position"), 2, [50.0, 50.0], -50.0, 150.0),
                "size": self._num_list(raw.get("size"), 2, [10.0, 10.0], -50.0, 150.0),
                "rotation": self._num_list(raw.get("rotation"), 1, [0.0], -3600.0, 3600.0),
                "color": color,
                "label": label,
            }
        # Optional explanatory note (what the part is / what to do). Only emitted
        # when non-empty, so old-style parts stay byte-identical and the event
        # carries no empty-string noise.
        note = str(raw.get("note") or "").strip()[: config.MODEL_NOTE_MAX]
        if note:
            part["note"] = note
        # Optional dashed flag (2D: hidden/internal/reference geometry). Accept a
        # real bool or the string "true"; emit only when on, so solid parts stay
        # byte-identical.
        dashed = raw.get("dashed")
        if dashed is True or (isinstance(dashed, str) and dashed.strip().lower() == "true"):
            part["dashed"] = True
        # Optional 3D material (PBR finish). Only a known preset is forwarded.
        material = str(raw.get("material") or "").strip().lower()
        if material in config.MODEL_MATERIALS:
            part["material"] = material
        # Optional 3D opacity (see-through housings). Emit only when actually
        # see-through (< 1) and a real finite number; clamp to [MIN, 1]. Solid
        # parts stay byte-identical (no opacity key).
        raw_op = raw.get("opacity")
        if isinstance(raw_op, (int, float)) and not isinstance(raw_op, bool) and math.isfinite(raw_op):
            op = max(config.MODEL_OPACITY_MIN, min(1.0, float(raw_op)))
            if op < 1.0:
                part["opacity"] = op
        # Optional looping motion (3D demonstration). Validated into a clean dict.
        anim = self._sanitize_animate(raw.get("animate"))
        if anim is not None:
            part["animate"] = anim
        # Optional tap-to-view spec sheet + safety warning (interactive depth).
        spec_rows = self._sanitize_spec_rows(raw.get("spec"))
        if spec_rows:
            part["spec"] = spec_rows
        warning = str(raw.get("warning") or "").strip()[: config.MODEL_WARNING_MAX]
        if warning:
            part["warning"] = warning
        # Optional playback step (1-based, bounded). Omitted = always-present part.
        step = self._sanitize_step(raw.get("step"))
        if step is not None:
            part["step"] = min(step, config.MODEL_MAX_PARTS)
        return part

    def _sanitize_animate(self, raw) -> dict | None:
        """Validate a looping motion descriptor -> clean dict, or None to drop it.

        A known `type` is required; axis defaults to 'y'; amount/speed/pivot are
        bounded and only included when a real finite number (or list) is given.
        """
        if not isinstance(raw, dict):
            return None
        atype = str(raw.get("type") or "").strip().lower()
        if atype not in config.MODEL_ANIM_TYPES:
            return None
        out: dict = {"type": atype}
        axis = str(raw.get("axis") or "y").strip().lower()
        out["axis"] = axis if axis in config.MODEL_AXES else "y"
        amount = raw.get("amount")
        if isinstance(amount, (int, float)) and not isinstance(amount, bool) and math.isfinite(amount):
            out["amount"] = max(-1000.0, min(1000.0, float(amount)))
        speed = raw.get("speed")
        if isinstance(speed, (int, float)) and not isinstance(speed, bool) and math.isfinite(speed):
            out["speed"] = max(
                config.MODEL_ANIM_SPEED_MIN, min(config.MODEL_ANIM_SPEED_MAX, float(speed))
            )
        # pivot is meaningful only for rotation (about an offset axis); ignore it
        # for slide/pulse, where it would otherwise shift the motion off-centre.
        if atype in ("swing", "spin") and isinstance(raw.get("pivot"), list):
            out["pivot"] = self._num_list(raw.get("pivot"), 3, [0.0, 0.0, 0.0], -1000.0, 1000.0)
        return out

    @staticmethod
    def _resolve_asset(raw) -> dict | None:
        """Resolve an assetId against the operator catalog -> {url, title}, or None
        (unknown id / not a string / empty catalog) so it falls back to primitives."""
        if not isinstance(raw, str):
            return None
        entry = config.MODEL_ASSETS.get(raw.strip())
        if not isinstance(entry, dict):
            return None
        url = str(entry.get("url") or "").strip()
        if not url:
            return None
        title = str(entry.get("title") or raw.strip()).strip()[:80]
        return {"url": url, "title": title}

    @staticmethod
    def _sanitize_spec_rows(raw) -> list[dict] | None:
        """Validate the tap-to-view spec sheet -> a capped list of {label, value}
        rows, or None. Each row needs a non-empty label AND value; both clamped."""
        if not isinstance(raw, list):
            return None
        rows: list[dict] = []
        for item in raw[: config.MODEL_SPEC_MAX_ROWS]:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or "").strip()[: config.MODEL_SPEC_LABEL_MAX]
            value = str(item.get("value") or "").strip()[: config.MODEL_SPEC_VALUE_MAX]
            if label and value:
                rows.append({"label": label, "value": value})
        return rows or None

    @staticmethod
    def _sanitize_anchor(raw) -> dict | None:
        """Validate a 2D diagram's camera anchor box → {box:[...]} or None.

        Same rigor + convention as annotate's box: 4 finite numbers (no bool),
        each clamped to [0,1000], with a positive area (xmax>xmin, ymax>ymin).
        """
        if not isinstance(raw, dict):
            return None
        box = raw.get("box")
        if not (
            isinstance(box, list)
            and len(box) == 4
            and all(
                isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n)
                for n in box
            )
        ):
            return None
        ymin, xmin, ymax, xmax = (max(0.0, min(1000.0, float(n))) for n in box)
        if xmax <= xmin or ymax <= ymin:  # degenerate / inverted
            return None
        return {"box": [ymin, xmin, ymax, xmax]}

    def _handle_show_model(self, args: dict) -> str:
        """Forward an AI-composed 3D/2D explanatory diagram to the client viewer.

        Everything here is model-generated structured data heading to a renderer,
        so it is strictly sanitized: known mode, bounded title/caption, a capped
        list of fully-validated primitive parts (bad parts dropped, never NaN).
        """
        mode = str(args.get("mode") or "3d").strip().lower()
        if mode not in config.MODEL_MODES:
            mode = "3d"
        title = str(args.get("title") or "Diagram").strip()[:80] or "Diagram"
        caption = str(args.get("caption") or "").strip()[:240]
        raw_parts = args.get("parts")
        parts: list[dict] = []
        if isinstance(raw_parts, list):
            for rp in raw_parts[: config.MODEL_MAX_PARTS]:
                clean = self._sanitize_model_part(rp, mode)
                if clean is not None:
                    parts.append(clean)
        if not parts:
            return (
                "Could not show that diagram — no valid shapes were provided. "
                "Describe it with a few primitive parts (e.g. box/cylinder/arrow) "
                "and try again."
            )
        event = {"type": "model", "mode": mode, "title": title, "caption": caption, "parts": parts}
        # Optional camera anchor (2D only): pin the diagram over the equipment.
        anchor = self._sanitize_anchor(args.get("anchor")) if mode == "2d" else None
        if anchor is not None:
            event["anchor"] = anchor
        # Optional pre-built 3D model (operator catalog). A known id resolves to
        # {url,title}; an unknown id (or 2D mode) is omitted, so the diagram
        # falls back to the primitive shapes — never a broken/empty model.
        asset = self._resolve_asset(args.get("assetId")) if mode == "3d" else None
        if asset is not None:
            event["asset"] = asset
        sent = self.send_event(event)
        if sent:
            metrics.inc("models_shown_total", labels={"mode": mode})
            where = "pinned over the technician's view" if anchor else "in the technician's view"
            return (
                f"Showing a {mode.upper()} diagram '{title}' ({len(parts)} parts) {where}. "
                "Talk them through what they're looking at."
            )
        return (
            f"Composed the '{title}' diagram, but the display channel isn't "
            "connected so it couldn't be shown. Keep guiding by voice."
        )

    def _handle_clear_model(self) -> str:
        sent = self.send_event({"type": "model_clear"})
        if not sent:
            return "No display channel is connected, so there was no diagram to hide."
        metrics.inc("models_cleared_total")
        return "Hid the diagram."

    def _handle_highlight_model(self, args: dict) -> str:
        """Emphasize parts of the ALREADY-shown diagram by label (no redraw).

        The backend is a stateless forwarder — it sanitizes the label list and
        emits one event; the client matches labels against the active diagram
        and drops any that don't exist (so a stale/unknown label glows nothing).
        An empty list is the explicit "stop emphasizing" path.
        """
        raw = args.get("labels")
        labels: list[str] = []
        seen: set[str] = set()
        if isinstance(raw, list):
            for item in raw[: config.MODEL_MAX_PARTS]:
                if not isinstance(item, str):
                    continue
                cleaned = item.strip()[:48]
                key = cleaned.lower()
                if not cleaned or key in seen:
                    continue
                seen.add(key)
                labels.append(cleaned)
        sent = self.send_event({"type": "model_emphasis", "labels": labels})
        if not sent:
            return "No display channel is connected, so there's no diagram to emphasize."
        metrics.inc("models_emphasized_total")
        if labels:
            return (
                f"Emphasized {len(labels)} part(s): {', '.join(labels)}. "
                "Talk the technician through them."
            )
        return "Cleared the emphasis on the diagram."

    def _handle_set_diagram_step(self, args: dict) -> str:
        """Set the active playback step on the already-shown diagram (no redraw).

        Stateless forwarder: coerce step to a bounded int (0 = show all) and emit
        one event; the client clamps it to the steps that actually exist.
        """
        raw = args.get("step")
        step = 0
        if isinstance(raw, bool):
            step = 0
        elif isinstance(raw, (int, float)) and math.isfinite(raw):
            step = max(0, min(config.MODEL_MAX_PARTS, int(raw)))
        elif isinstance(raw, str):
            try:
                step = max(0, min(config.MODEL_MAX_PARTS, int(raw.strip())))
            except ValueError:
                step = 0
        sent = self.send_event({"type": "model_step", "step": step})
        if not sent:
            return "No display channel is connected, so there's no diagram to step through."
        metrics.inc("model_steps_total")
        if step > 0:
            return f"Now on step {step} of the diagram. Talk the technician through it."
        return "Showing the whole diagram (playback off)."

    # -- lifecycle ----------------------------------------------------------
    # Reaper poll cadence (class attr so tests can shrink it).
    _REAPER_INTERVAL = 15.0

    async def start(self) -> None:
        """Open the Gemini Live session (must succeed before we answer the SDP)."""
        await self.bridge.start()
        self._log.info("Session %s started.", self.sid)
        # Pre-warm NotebookLM in the background so the first toolCall isn't a cold
        # start. No-op unless the warm singleton is up; debounced internally. Keep
        # a reference so the task isn't garbage-collected mid-run.
        self._prewarm_task = asyncio.create_task(knowledge.prewarm(), name="prewarm")
        # Lifecycle bounds: end abandoned/over-long sessions so they can't hold a
        # MAX_SESSIONS slot + a live Gemini connection forever.
        if config.SESSION_MAX_SECONDS > 0 or config.SESSION_IDLE_SECONDS > 0:
            self._reaper_task = asyncio.create_task(self._reaper(), name="session-reaper")

    async def _reaper(self) -> None:
        """End the session on wall-clock or media-idle limits (cost/capacity)."""
        while not self._closed:
            try:
                await asyncio.sleep(self._REAPER_INTERVAL)
            except asyncio.CancelledError:
                return
            now = time.monotonic()
            if config.SESSION_MAX_SECONDS > 0 and now - self._started >= config.SESSION_MAX_SECONDS:
                reason = "max_duration"
            elif (
                config.SESSION_IDLE_SECONDS > 0
                and now - self._last_media >= config.SESSION_IDLE_SECONDS
            ):
                reason = "idle"
            else:
                continue
            self._log.warning("Reaping session (%s).", reason)
            metrics.inc("sessions_reaped_total", labels={"reason": reason})
            # Tell the client WHY before the transport drops (best-effort), and
            # give the data channel a moment to flush before pc.close() races it.
            self.send_event({"type": "status", "state": "ended", "reason": reason})
            await asyncio.sleep(0.15)
            task = asyncio.create_task(_cleanup(self))
            _cleanup_tasks.add(task)
            task.add_done_callback(_cleanup_tasks.discard)
            return

    def add_inbound_track(self, track) -> None:
        if track.kind == "audio":
            self._log.info("Inbound audio (mic) track attached.")
            self._pump_tasks.append(
                asyncio.create_task(self._pump_audio(track), name="pump-audio")
            )
        elif track.kind == "video":
            self._log.info("Inbound video (camera) track attached.")
            self._pump_tasks.append(
                asyncio.create_task(self._pump_video(track), name="pump-video")
            )

    # -- ICE "disconnected" watchdog ---------------------------------------
    # Per the WebRTC spec, "disconnected" is transient and self-healing; only
    # "failed"/"closed" are terminal. Instead of tearing down on a blip, we wait
    # out a grace period and clean up only if it never recovers.
    def schedule_disconnect_watchdog(self) -> None:
        if self._closed or (self._watchdog and not self._watchdog.done()):
            return
        self._watchdog = asyncio.create_task(self._disconnect_watchdog())

    def cancel_disconnect_watchdog(self) -> None:
        wd = self._watchdog
        self._watchdog = None
        # Never cancel from within the watchdog's own _cleanup call.
        if wd and wd is not asyncio.current_task() and not wd.done():
            wd.cancel()

    async def _disconnect_watchdog(self) -> None:
        try:
            await asyncio.sleep(15.0)
        except asyncio.CancelledError:
            return
        if self.pc.connectionState in ("disconnected", "failed"):
            self._log.info("PC still %s after grace period — cleaning up.", self.pc.connectionState)
            await _cleanup(self)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.cancel_disconnect_watchdog()
        if self._prewarm_task is not None:
            self._prewarm_task.cancel()
        if self._reaper_task is not None and self._reaper_task is not asyncio.current_task():
            self._reaper_task.cancel()
        for task in self._pump_tasks:
            task.cancel()
        pending = [
            t
            for t in (*self._pump_tasks, self._prewarm_task, self._reaper_task)
            if t is not None and t is not asyncio.current_task()
        ]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await self.bridge.close()
        # End-of-session summary: one greppable line per session for ops.
        self._log.info(
            "Session %s closed after %.0fs.", self.sid, time.monotonic() - self._started
        )

    # -- media pumps --------------------------------------------------------
    async def _pump_audio(self, track) -> None:
        """Inbound mic -> 16 kHz mono PCM16 -> Gemini."""
        while not self._closed:
            try:
                frame = await track.recv()
            except MediaStreamError:
                break
            except Exception:  # noqa: BLE001
                self._log.exception("Audio pump recv error")
                break
            self._last_media = time.monotonic()
            try:
                pcm16 = self._audio_converter.to_pcm16(frame)
                if pcm16:
                    self.bridge.enqueue_audio(pcm16)
            except Exception:  # noqa: BLE001
                self._log.exception("Audio pump conversion error")
        self._log.info("Audio pump stopped.")

    async def _pump_video(self, track) -> None:
        """Inbound camera -> JPEG (downscaled, throttled to VIDEO_FPS) -> Gemini."""
        interval = 1.0 / max(0.1, config.VIDEO_FPS)
        last_sent = 0.0
        while not self._closed:
            try:
                frame = await track.recv()  # drain every frame to avoid backpressure
            except MediaStreamError:
                break
            except Exception:  # noqa: BLE001
                self._log.exception("Video pump recv error")
                break
            self._last_media = time.monotonic()
            now = time.monotonic()
            if now - last_sent < interval:
                continue  # throttle: forward only ~VIDEO_FPS frames/sec
            try:
                # Encode in a worker thread: cv2/PyAV release the GIL, and the
                # multi-ms scale+JPEG must not stall the event loop that paces
                # the AI's 20 ms voice frames (audible 1 Hz jitter otherwise).
                # Sequential await (<= VIDEO_FPS encodes/sec) preserves ordering.
                jpeg = await asyncio.to_thread(frame_to_jpeg, frame)
                if jpeg:
                    self.bridge.enqueue_video(jpeg)
            except Exception:  # noqa: BLE001
                self._log.exception("Video pump encode error")
            finally:
                # Stamp AFTER the encode so its wall time is charged against the
                # throttle interval. Stamping before (the old way) meant a slow
                # encode (>= interval) re-armed the throttle by the time it
                # finished — zero frames ever dropped again, aiortc's unbounded
                # receive queue grew monotonically, and Gemini saw ever-staler
                # frames. Stamping after restores the drop phase: the queued
                # backlog drains at full speed (recv + drop) after every encode.
                last_sent = time.monotonic()
        self._log.info("Video pump stopped.")


async def _cleanup(session: "PeerSession") -> None:
    # Close FIRST (cancels in-flight tool tasks), THEN release the slot: the
    # notebook-switch guard reads _sessions, and discarding early would let a
    # still-running lookup straddle the swap.
    await session.close()
    _sessions.discard(session)
    _sync_session_gauge()
    try:
        await session.pc.close()
    except Exception:  # noqa: BLE001
        pass


# ===========================================================================
# FastAPI app
# ===========================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Reset on (re)start: a second lifespan cycle in the same process (tests,
    # embedded runners) must not inherit a stale draining flag.
    global _shutting_down
    _shutting_down = False
    for problem in config.validate(strict=False):
        logger.warning("CONFIG: %s", problem)
    logger.info("Serving frontend from %s", STATIC_DIR)
    logger.info(
        "Gemini model=%s version=%s | NotebookLM notebook=%s",
        config.GEMINI_LIVE_MODEL,
        config.GEMINI_API_VERSION,
        config.ACTIVE_NOTEBOOK_ID or "(unset)",
    )
    # Open the warm NotebookLM client (best-effort) so the first tool call is
    # fast; this also kicks off a background pre-warm of the active notebook.
    await knowledge.startup()
    yield
    _shutting_down = True
    logger.info("Shutting down — draining %d session(s).", len(_sessions))
    # Tell every live client WHY the session is about to end (an unexplained
    # drop reads as a network failure and generates support calls), then give
    # the data channels a moment to flush before tearing transport down.
    for session in list(_sessions):
        session.send_event(
            {"type": "status", "state": "ended", "reason": "server_shutdown"}
        )
    if _sessions:
        await asyncio.sleep(0.25)
    for session in list(_sessions):
        await _cleanup(session)
    await knowledge.shutdown()


app = FastAPI(title="AR Technician Assistant", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,  # lock down via ALLOWED_ORIGINS in prod
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model": config.GEMINI_LIVE_MODEL,
        "api_version": config.GEMINI_API_VERSION,
        "notebook_configured": bool(config.ACTIVE_NOTEBOOK_ID),
        "active_sessions": len(_sessions),
        "max_sessions": config.MAX_SESSIONS,
        # Tells the client whether to show the login gate (set when both a token
        # and a user list are configured). No secrets are exposed.
        "auth_required": config.AUTH_ENABLED,
    }


@app.post("/login")
async def login(request: Request) -> JSONResponse:
    """Email + password login. On success returns the API bearer token the client
    then sends on /offer + /ice-config. Credentials are checked against hashed
    users; rate-limited; no sign-up. 503 if login isn't configured on this server."""
    if _rate_limited(_client_ip(request)):
        metrics.inc("login_total", labels={"result": "rate_limited"})
        return JSONResponse({"error": "Too many requests. Wait a minute and try again."}, status_code=429)
    if not config.AUTH_ENABLED:
        return JSONResponse({"error": "Login is not configured on this server."}, status_code=503)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "Invalid request body."}, status_code=400)
    email = body.get("email") if isinstance(body, dict) else None
    password = body.get("password") if isinstance(body, dict) else None
    if isinstance(email, str) and isinstance(password, str) and config.verify_login(email, password):
        from services import tenant_auth

        company = config.AUTH_COMPANIES.get(email.strip().lower(), "default")
        metrics.inc("login_total", labels={"result": "ok"})
        # Per-user signed token carrying identity + company (multi-tenant scoping).
        return JSONResponse({"token": tenant_auth.issue_token(email, company)})
    metrics.inc("login_total", labels={"result": "fail"})
    return JSONResponse({"error": "Invalid email or password."}, status_code=401)


@app.post("/recognize")
async def recognize(request: Request) -> JSONResponse:
    """Specialized image recognition via the NVIDIA-hosted VLM: identify parts +
    read labels/model numbers from ONE still image. Auth-gated + rate-limited.
    Body: {"image": "<base64 or data URL>", "prompt"?: "<optional instruction>"}.
    Returns {"detections": "<text>"}; 503 if the recognizer isn't configured."""
    if not _auth_ok(request):
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    if _rate_limited(_client_ip(request)):
        return JSONResponse({"error": "Too many requests. Wait a minute."}, status_code=429)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "Invalid request body."}, status_code=400)
    image = body.get("image") if isinstance(body, dict) else None
    prompt = body.get("prompt") if isinstance(body, dict) else ""
    if not isinstance(image, str) or not image.strip():
        return JSONResponse({"error": "Missing 'image'."}, status_code=400)
    if len(image) > config.MAX_IMAGE_BYTES:  # base64 image is large but bounded
        return JSONResponse({"error": "Image too large."}, status_code=413)
    from services import vision_nvidia

    try:
        detections = await vision_nvidia.recognize(
            image, prompt if isinstance(prompt, str) else ""
        )
        metrics.inc("recognize_total", labels={"result": "ok"})
        return JSONResponse({"detections": detections})
    except vision_nvidia.VisionUnavailable as e:
        metrics.inc("recognize_total", labels={"result": "unavailable"})
        return JSONResponse({"error": str(e)}, status_code=503)
    except Exception:  # noqa: BLE001 — never leak internals / the API key
        metrics.inc("recognize_total", labels={"result": "error"})
        return JSONResponse({"error": "Recognition failed."}, status_code=502)


@app.post("/chat")
async def chat_endpoint(request: Request) -> JSONResponse:
    """Typed text/vision chat (separate from the live voice call). Auth-gated +
    rate-limited. Body: {"text": "...", "image"?: "<base64/data URL>",
    "history"?: [{"role","text"}, ...]}. Returns {"reply": "<text>"}."""
    if not _auth_ok(request):
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    if _rate_limited(_client_ip(request)):
        return JSONResponse({"error": "Too many requests. Wait a minute."}, status_code=429)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "Invalid request body."}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "Invalid request body."}, status_code=400)
    text = body.get("text") if isinstance(body.get("text"), str) else ""
    image = body.get("image") if isinstance(body.get("image"), str) else ""
    history = body.get("history") if isinstance(body.get("history"), list) else None
    if image and len(image) > config.MAX_IMAGE_BYTES:
        return JSONResponse({"error": "Image too large."}, status_code=413)
    if not (text.strip() or image.strip()):
        return JSONResponse({"error": "Empty message."}, status_code=400)
    from services import chat as chat_service

    try:
        reply = await chat_service.chat(text, image, history)
        metrics.inc("chat_total", labels={"result": "ok"})
        return JSONResponse({"reply": reply})
    except chat_service.ChatUnavailable as e:
        metrics.inc("chat_total", labels={"result": "unavailable"})
        return JSONResponse({"error": str(e)}, status_code=503)
    except Exception:  # noqa: BLE001
        metrics.inc("chat_total", labels={"result": "error"})
        return JSONResponse({"error": "Chat failed."}, status_code=502)


@app.post("/generate-image")
async def generate_image_endpoint(request: Request) -> JSONResponse:
    """Generate an image from a text prompt (Gemini image model). Auth-gated +
    rate-limited. Body: {"prompt": "..."}. Returns {"image": "<base64>", "mime"}."""
    if not _auth_ok(request):
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    if _rate_limited(_client_ip(request)):
        return JSONResponse({"error": "Too many requests. Wait a minute."}, status_code=429)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "Invalid request body."}, status_code=400)
    prompt = body.get("prompt") if isinstance(body, dict) else None
    if not isinstance(prompt, str) or not prompt.strip():
        return JSONResponse({"error": "Missing 'prompt'."}, status_code=400)
    from services import imagegen

    try:
        b64, mime = await imagegen.generate(prompt)
        metrics.inc("imagegen_total", labels={"result": "ok"})
        return JSONResponse({"image": b64, "mime": mime})
    except imagegen.ImageGenUnavailable as e:
        metrics.inc("imagegen_total", labels={"result": "unavailable"})
        return JSONResponse({"error": str(e)}, status_code=503)
    except Exception:  # noqa: BLE001
        metrics.inc("imagegen_total", labels={"result": "error"})
        return JSONResponse({"error": "Image generation failed."}, status_code=502)


# ===========================================================================
# Solution Memory — per-company database of solved cases (multi-tenant).
# The company is ALWAYS taken from the caller's verified token, never from the
# request body — a user cannot address another tenant's data.
# ===========================================================================
@app.post("/solutions")
async def save_solution_endpoint(request: Request) -> JSONResponse:
    ident = _identity(request)
    if ident is None:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    if _rate_limited(_client_ip(request)):
        return JSONResponse({"error": "Too many requests. Wait a minute."}, status_code=429)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "Invalid request body."}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "Invalid request body."}, status_code=400)
    photo = body.get("photo") if isinstance(body.get("photo"), str) else ""
    if photo and len(photo) > config.MAX_IMAGE_BYTES:
        return JSONResponse({"error": "Photo too large."}, status_code=413)
    from services import solutions

    try:
        sid = solutions.save_solution(
            company=ident["company"],
            author=ident["email"],
            title=str(body.get("title") or ""),
            equipment=str(body.get("equipment") or ""),
            problem=str(body.get("problem") or ""),
            fix=str(body.get("fix") or ""),
            tags=str(body.get("tags") or ""),
            photo_b64=photo,
        )
        metrics.inc("solutions_total", labels={"op": "save"})
        return JSONResponse({"id": sid})
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "Could not save the solution."}, status_code=500)


@app.get("/solutions")
async def search_solutions_endpoint(request: Request) -> JSONResponse:
    ident = _identity(request)
    if ident is None:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    from services import solutions

    q = request.query_params.get("q", "")
    try:
        results = solutions.search_solutions(ident["company"], q)
        metrics.inc("solutions_total", labels={"op": "search"})
        return JSONResponse({"solutions": results})
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "Search failed."}, status_code=500)


@app.get("/solutions/{sid}")
async def get_solution_endpoint(sid: str, request: Request) -> JSONResponse:
    ident = _identity(request)
    if ident is None:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    from services import solutions

    try:
        sol = solutions.get_solution(ident["company"], sid)
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "Lookup failed."}, status_code=500)
    if sol is None:
        return JSONResponse({"error": "Not found."}, status_code=404)
    return JSONResponse({"solution": sol})


@app.get("/ready")
async def ready() -> JSONResponse:
    """Readiness probe (k8s): 200 only when the app can actually serve sessions."""
    problems = config.validate(strict=False)
    if _shutting_down:
        problems = [*problems, "Server is shutting down."]
    ok = not problems
    return JSONResponse(
        {"ready": ok, "problems": problems, "active_sessions": len(_sessions)},
        status_code=200 if ok else 503,
    )


@app.get("/ice-config")
async def ice_config(request: Request) -> JSONResponse:
    """ICE servers (STUN + optional TURN) for the browser RTCPeerConnection.

    Auth-gated like /offer when API_AUTH_TOKEN is set: the response can embed
    long-lived TURN credentials, which must not be harvestable by any
    unauthenticated caller (relay abuse / relay-loop DoS). Dev behavior with no
    token configured is unchanged. The client falls back to plain STUN on 401.
    """
    if not _auth_ok(request):
        metrics.inc("ice_config_rejected_total")
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    return JSONResponse({"iceServers": _ice_servers_json()})


@app.post("/offer")
async def offer(request: Request) -> JSONResponse:
    """WebRTC SDP negotiation.

    Body:    {"sdp": "<offer sdp>", "type": "offer"}
    Returns: {"sdp": "<answer sdp>", "type": "answer"}
    """
    metrics.inc("offer_requests_total")
    # --- access control + resource protection (before allocating anything) ---
    if _shutting_down:
        metrics.inc("offer_rejected_total", labels={"reason": "shutting_down"})
        return JSONResponse(
            {"error": "Server is shutting down. Try again shortly."}, status_code=503
        )
    if not _auth_ok(request):
        metrics.inc("offer_rejected_total", labels={"reason": "unauthorized"})
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    if _rate_limited(_client_ip(request)):
        metrics.inc("offer_rejected_total", labels={"reason": "rate_limited"})
        return JSONResponse({"error": "Too many requests."}, status_code=429)
    clen = request.headers.get("content-length")
    if clen and clen.isdigit() and int(clen) > config.MAX_OFFER_BYTES:
        metrics.inc("offer_rejected_total", labels={"reason": "too_large"})
        return JSONResponse({"error": "Request body too large."}, status_code=413)

    # From here the offer is "in flight" for the notebook-switch guard: it may
    # become a session after several awaits, and a swap must not slip between.
    global _offers_inflight
    _offers_inflight += 1
    try:
        return await _offer_inner(request)
    finally:
        _offers_inflight -= 1


async def _offer_inner(request: Request) -> JSONResponse:
    # Read the body with a HARD cap on the ACTUAL bytes — a chunked / missing
    # Content-Length request cannot slip past the header check above.
    body = bytearray()
    try:
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > config.MAX_OFFER_BYTES:
                metrics.inc("offer_rejected_total", labels={"reason": "too_large"})
                return JSONResponse({"error": "Request body too large."}, status_code=413)
    except Exception:  # noqa: BLE001
        metrics.inc("offer_rejected_total", labels={"reason": "body_read"})
        return JSONResponse({"error": "Could not read request body."}, status_code=400)

    # Validate the (untrusted) body: JSON object with string sdp/type.
    try:
        params = json.loads(body) if body else None
    except Exception:  # noqa: BLE001 - non-JSON / garbage body
        metrics.inc("offer_rejected_total", labels={"reason": "bad_json"})
        return JSONResponse({"error": "Request body must be JSON."}, status_code=400)
    if (
        not isinstance(params, dict)
        or not isinstance(params.get("sdp"), str)
        or not isinstance(params.get("type"), str)
    ):
        metrics.inc("offer_rejected_total", labels={"reason": "bad_schema"})
        return JSONResponse(
            {"error": "Body must be a JSON object with string 'sdp' and 'type'."},
            status_code=400,
        )

    # Capacity gate — checked HERE (no await before _sessions.add below) so
    # concurrent /offer requests cannot overshoot the cap (TOCTOU-safe).
    if len(_sessions) >= config.MAX_SESSIONS:
        metrics.inc("offer_rejected_total", labels={"reason": "at_capacity"})
        logger.warning("Session cap (%d) reached — rejecting /offer.", config.MAX_SESSIONS)
        return JSONResponse({"error": "Server at capacity. Try again shortly."}, status_code=429)

    offer_desc = RTCSessionDescription(sdp=params["sdp"], type=params["type"])
    pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=_rtc_ice_servers()))
    session = PeerSession(pc)
    _sessions.add(session)
    _sync_session_gauge()

    @pc.on("track")
    def on_track(track):  # noqa: ANN001
        session.add_inbound_track(track)

    @pc.on("datachannel")
    def on_datachannel(channel):  # noqa: ANN001
        session.attach_data_channel(channel)

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        state = pc.connectionState
        session._log.info("PC connection state: %s", state)
        if state in ("failed", "closed"):
            await _cleanup(session)
        elif state == "disconnected":
            # Transient — ride it out; the watchdog cleans up only if it sticks.
            session.schedule_disconnect_watchdog()
        elif state == "connected":
            session.cancel_disconnect_watchdog()

    # Apply the remote offer (fires on("track") for the client's mic + camera).
    # Guarded: malformed/attacker-controlled SDP must not leak the session/pc.
    try:
        await pc.setRemoteDescription(offer_desc)
    except Exception:  # noqa: BLE001
        logger.exception("Invalid SDP offer")
        await _cleanup(session)
        metrics.inc("offer_rejected_total", labels={"reason": "bad_sdp"})
        return JSONResponse({"error": "Invalid SDP offer."}, status_code=400)

    # Open the Gemini Live session now so it is ready as soon as media flows.
    # NOTE: never echo the exception to the client — a connect-time error string
    # can embed the Gemini key (it's a query param of the WS URI). Log it server-side.
    try:
        await session.start()
    except Exception:  # noqa: BLE001
        logger.exception("Failed to start Gemini Live session")
        await _cleanup(session)
        metrics.inc("offer_rejected_total", labels={"reason": "gemini_start"})
        return JSONResponse({"error": "Failed to start AI session."}, status_code=502)

    # Produce and return the SDP answer (guarded so a failure can't leak the pc).
    try:
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
    except Exception:  # noqa: BLE001
        logger.exception("Failed to negotiate SDP answer")
        await _cleanup(session)
        metrics.inc("offer_rejected_total", labels={"reason": "sdp_negotiation"})
        return JSONResponse({"error": "SDP negotiation failed."}, status_code=500)

    metrics.inc("sessions_started_total")
    return JSONResponse(
        {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
    )


@app.get("/notebooks")
async def notebooks(request: Request) -> JSONResponse:
    """List available NotebookLM notebooks for the runtime manual picker.

    Auth-gated like /offer: notebook titles can reveal what equipment a site
    runs. Returns id/title plus which one is currently active.
    """
    if not _auth_ok(request):
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    try:
        items = await asyncio.wait_for(knowledge.list_notebooks(), timeout=30.0)
    except Exception:  # noqa: BLE001
        logger.exception("Notebook list failed")
        return JSONResponse({"error": "Could not list notebooks."}, status_code=502)
    return JSONResponse(
        {
            "notebooks": [
                {**it, "active": it["id"] == config.ACTIVE_NOTEBOOK_ID} for it in items
            ],
            "active": config.ACTIVE_NOTEBOOK_ID,
        }
    )


@app.post("/notebooks/switch")
async def notebooks_switch(request: Request) -> JSONResponse:
    """Switch the active manual at runtime (no server restart).

    Refused while sessions are live (409) so an in-flight tool call can never
    straddle the swap; the switch atomically resets all notebook-scoped state.
    """
    if not _auth_ok(request):
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    # Parse the body FIRST: every await before the guard is a TOCTOU window.
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "Request body must be JSON."}, status_code=400)
    nb_id = body.get("id") if isinstance(body, dict) else None
    if not isinstance(nb_id, str) or not nb_id.strip() or len(nb_id) > 200:
        return JSONResponse({"error": "Body must include a notebook 'id'."}, status_code=400)
    # Guard immediately before the switch, with NO await in between — and cover
    # offers still negotiating (they become sessions a few awaits later).
    if _sessions or _offers_inflight:
        return JSONResponse(
            {"error": "Sessions are active — end them before switching manuals."},
            status_code=409,
        )
    await knowledge.switch_notebook(nb_id.strip())
    metrics.inc("notebook_switches_total")
    return JSONResponse({"ok": True, "active": config.ACTIVE_NOTEBOOK_ID})


@app.get("/metrics")
async def metrics_endpoint() -> PlainTextResponse:
    """Prometheus text exposition of in-process counters/gauges/timers.

    No external metrics dependency; scrape this directly. For a multi-worker
    deployment, aggregate the per-worker series at your collector.
    """
    metrics.set_gauge("sessions_active", len(_sessions))  # authoritative, on read
    return PlainTextResponse(metrics.prometheus(), media_type="text/plain; version=0.0.4")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# Conventional local cert location written by scripts/make_cert.{sh,ps1}.
_DEFAULT_CERT_DIR = Path(__file__).resolve().parent / "certs"


def _resolve_ssl() -> tuple[str | None, str | None]:
    """Locate a TLS cert/key: explicit env (SSL_CERTFILE/SSL_KEYFILE) first, then
    the conventional ./certs/cert.pem + key.pem from make_cert — so a generated
    cert just works (turnkey HTTPS for LAN/iPad) with no env wiring."""
    cert, key = config.SSL_CERTFILE, config.SSL_KEYFILE
    if not (cert and key):
        default_cert = _DEFAULT_CERT_DIR / "cert.pem"
        default_key = _DEFAULT_CERT_DIR / "key.pem"
        if default_cert.is_file() and default_key.is_file():
            cert, key = str(default_cert), str(default_key)
    if cert and key and Path(cert).is_file() and Path(key).is_file():
        return cert, key
    return None, None


if __name__ == "__main__":
    import uvicorn

    cert, key = _resolve_ssl()
    if not (config.TURN_URL and config.TURN_USERNAME and config.TURN_CREDENTIAL):
        logger.info(
            "TURN not configured (TURN_URL/TURN_USERNAME/TURN_CREDENTIAL). Same-Wi-Fi "
            "clients connect fine via host candidates, but an OFF-network client (e.g. an "
            "iPad on cellular reaching a tunnel) will likely fail to connect media without "
            "a TURN relay. See README -> 'Run it from anywhere (off your Wi-Fi)'."
        )
    if cert and key:
        logger.info("Starting HTTPS server on https://%s:%s", config.HOST, config.PORT)
        uvicorn.run("main:app", host=config.HOST, port=config.PORT,
                    ssl_certfile=cert, ssl_keyfile=key)
    else:
        logger.warning(
            "No TLS cert/key found (SSL_CERTFILE/SSL_KEYFILE). Starting plain HTTP "
            "— fine for http://localhost, but WebXR and camera/mic access from a "
            "headset over LAN REQUIRE HTTPS. See README to make certs."
        )
        uvicorn.run("main:app", host=config.HOST, port=config.PORT)
