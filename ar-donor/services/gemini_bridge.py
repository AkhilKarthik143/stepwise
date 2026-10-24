"""
Cognitive engine: Gemini Multimodal Live API bridge (BidiGenerateContent).
==========================================================================

Owns the *Gemini protocol* and nothing else — no aiortc/WebRTC awareness. It
opens a persistent bidirectional WebSocket and runs two concurrent loops:

  upstream()   : drains an internal send-queue (audio PCM16 @16k + JPEG frames
                 that the transport layer enqueues) and pushes them to Gemini
                 as `realtimeInput` frames.
  downstream() : reads Gemini's stream and handles model audio playout, speech
                 interruption (barge-in), and `toolCall` interception. Each tool
                 call runs as a background task so the loop keeps draining while
                 the (multi-second) RAG lookup is in flight; the resulting
                 `toolResponse` is piped straight back to Gemini.

Wire format (verified against ai.google.dev/api/live):
  setup           -> {"setup": {model, generationConfig, systemInstruction, tools}}
  realtime audio  -> {"realtimeInput": {"audio": {mimeType, data}}}   (or mediaChunks)
  realtime video  -> {"realtimeInput": {"video": {mimeType, data}}}   (or mediaChunks)
  server audio    -> {"serverContent": {"modelTurn": {"parts": [{"inlineData": {...}}]}}}
  barge-in        -> {"serverContent": {"interrupted": true}}
  tool call       -> {"toolCall": {"functionCalls": [{id, name, args}]}}
  tool response   -> {"toolResponse": {"functionResponses": [{id, name, response}]}}

NOTE on terminology: the *client* sends `setup`; the *server* replies
`setupComplete`. (The brief's "send the setupComplete frame" is the same
handshake described from the server's perspective.)
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Awaitable, Callable, Optional

import websockets

import config
from services.metrics import metrics

logger = logging.getLogger("gemini_bridge")

# Caller-supplied sinks/handlers.
AudioSink = Callable[[bytes], None]                   # receives raw 24 kHz PCM16
InterruptSink = Callable[[], None]                    # called on model barge-in
TextSink = Callable[[str], None]                      # optional: model text parts
ToolDispatch = Callable[[str, dict], Awaitable[str]]  # (name, args) -> answer text

# Bounded send-queue: a full queue means we're behind, so we drop the OLDEST
# realtime chunk (stale audio/video is worthless in real time).
_SEND_QUEUE_MAXSIZE = 256


def _model_path(model: str) -> str:
    return model if model.startswith("models/") else f"models/{model}"


class GeminiBridge:
    def __init__(
        self,
        *,
        on_audio_out: AudioSink,
        tool_dispatch: ToolDispatch,
        on_interrupt: Optional[InterruptSink] = None,
        on_text: Optional[TextSink] = None,
        on_transcript: Optional[TextSink] = None,
        on_input_transcript: Optional[TextSink] = None,
        on_turn_complete: Optional[Callable[[], None]] = None,
        on_session_end: Optional[Callable[[], None]] = None,
        on_reconnecting: Optional[Callable[[], None]] = None,
        on_reconnected: Optional[Callable[[], None]] = None,
    ) -> None:
        self._on_audio_out = on_audio_out
        self._tool_dispatch = tool_dispatch
        self._on_interrupt = on_interrupt
        self._on_text = on_text
        # Incremental transcription fragments of the model's SPOKEN audio
        # (serverContent.outputTranscription.text) — drives live captions.
        self._on_transcript = on_transcript
        # Incremental transcription of the TECHNICIAN's speech
        # (serverContent.inputTranscription.text) — the "You" side of the record.
        self._on_input_transcript = on_input_transcript
        # Fired on serverContent.turnComplete — lets the client segment caption
        # fragments into finished transcript turns.
        self._on_turn_complete = on_turn_complete
        # Fired exactly once when the Gemini session is PERMANENTLY dead — i.e.
        # reconnection was exhausted (or disabled) — so the transport layer tears
        # the whole session down. A recoverable drop reconnects silently instead.
        self._on_session_end = on_session_end
        # Fired before each reconnect attempt (transient drop) — lets the client
        # show a "reconnecting" status while the WebRTC link stays up.
        self._on_reconnecting = on_reconnecting
        self._on_reconnected = on_reconnected
        self._ever_ready = False  # has setupComplete ever arrived?

        self._ws = None
        self._send_queue: asyncio.Queue = asyncio.Queue(maxsize=_SEND_QUEUE_MAXSIZE)
        self._send_lock = asyncio.Lock()
        self._ready = asyncio.Event()
        self._closed = False          # caller-initiated close (close())
        self._dead = False            # permanently dead (_signal_dead())
        self._end_signaled = False
        self._supervisor: Optional[asyncio.Task] = None
        self._loop_tasks: list[asyncio.Task] = []
        self._inflight_tools: set[asyncio.Task] = set()
        # call-id -> task, so toolCallCancellation can cancel the matching lookup.
        self._inflight_by_id: dict[str, asyncio.Task] = {}
        # Socket currently being retired (kept reachable for close() if the
        # retire coroutine is cancelled mid-close).
        self._retiring_ws = None
        # Session-resumption handle (Gemini Live) for context continuity across
        # reconnects; updated from sessionResumptionUpdate frames.
        self._resume_handle: Optional[str] = None

    def _signal_dead(self) -> None:
        """Mark the session dead and notify the transport layer exactly once.

        Called when a protocol loop exits for any reason OTHER than a
        caller-initiated close (cancellation). Idempotent and safe to call from
        both loops.
        """
        if self._end_signaled or self._closed:
            return
        self._end_signaled = True
        self._dead = True
        self._ready.set()  # unblock a start() that is still awaiting setupComplete
        if self._on_session_end:
            try:
                self._on_session_end()
            except Exception:  # noqa: BLE001
                logger.exception("on_session_end callback raised")

    # ----------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        """Launch the session supervisor and block until the first setupComplete.

        The supervisor keeps the Gemini link alive across drops (reconnect +
        backoff + session resumption); on first connect it sets _ready.
        """
        self._supervisor = asyncio.create_task(self._supervise(), name="gemini-supervisor")
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=20.0)
        except asyncio.TimeoutError:
            await self.close()
            raise RuntimeError("Gemini did not return setupComplete within 20s.")
        if self._dead:
            raise RuntimeError("Gemini session ended during setup.")
        logger.info("Gemini Live session ready (model=%s).", config.GEMINI_LIVE_MODEL)

    async def _supervise(self) -> None:
        """Own the connection lifecycle: connect, run, and reconnect on drop.

        Fires on_session_end only when reconnection is disabled or exhausted.
        """
        attempt = 0
        while not self._closed:
            connected_ok = False
            try:
                await self._connect()              # open ws + send setup
                session_start = time.monotonic()
                await self._run_loops()            # run until the session ends
                # Only count as "good" (reset backoff) if it reached setupComplete
                # AND stayed up a while — else a setup-then-instant-drop flap would
                # reset the counter forever and reconnect at the backoff floor.
                connected_ok = (
                    self._ready.is_set()
                    and (time.monotonic() - session_start) >= config.GEMINI_MIN_HEALTHY_SECONDS
                )
            except asyncio.CancelledError:
                raise  # caller closed us — do NOT signal session-end
            except Exception:  # noqa: BLE001
                logger.exception("Gemini session error")

            # The session is DOWN. Retire the socket immediately — before the
            # backoff sleep — so (a) send_text's readiness guard cannot pass on
            # a dead socket during the multi-second backoff window (typed text
            # was silently lost there), and (b) the stale ws + its keepalive
            # ping task don't leak across reconnects.
            await self._retire_socket()

            if self._closed:
                break

            # A good session that dropped resets the backoff; a connect/setup that
            # never readied counts toward the exhaustion limit.
            attempt = 0 if connected_ok else attempt + 1
            if not config.GEMINI_RECONNECT or attempt > config.GEMINI_MAX_RECONNECTS:
                logger.warning("Gemini link lost and not recoverable — giving up.")
                break

            backoff = min(config.GEMINI_RECONNECT_BACKOFF * (2 ** max(0, attempt - 1)), 30.0)
            metrics.inc("gemini_reconnects_total")
            logger.info(
                "Gemini link lost; reconnecting in %.1fs (attempt %d/%d)…",
                backoff, attempt, config.GEMINI_MAX_RECONNECTS,
            )
            if self._on_reconnecting:
                try:
                    self._on_reconnecting()
                except Exception:  # noqa: BLE001
                    logger.exception("on_reconnecting callback raised")
            await asyncio.sleep(backoff)

        self._signal_dead()

    async def _retire_socket(self) -> None:
        """Mark the session not-ready and close the old socket (drop/reconnect).

        Idempotent + best-effort. Ordering matters: _ready is cleared FIRST so
        every readiness guard (send_text, upstream) fails closed from this
        instant; only then is the socket detached and closed. The socket being
        retired stays referenced in _retiring_ws so close() can still reach it
        if this coroutine is cancelled (or times out) mid-retire.
        """
        self._ready.clear()
        old_ws, self._ws = self._ws, None
        if old_ws is not None:
            self._retiring_ws = old_ws
            try:
                await asyncio.wait_for(old_ws.close(), timeout=5.0)
            except Exception:  # noqa: BLE001 - already-dead sockets are fine
                pass
            finally:
                if self._retiring_ws is old_ws:
                    self._retiring_ws = None

    async def _connect(self) -> None:
        if not config.GEMINI_API_KEY:
            raise RuntimeError("GEMINI_API_KEY is not configured.")
        # Each attempt awaits its own setupComplete.
        self._ready.clear()
        # Flush media queued before/during the drop: replaying up to 256 stale
        # mic/JPEG chunks into a RESUMED session would feed the model seconds of
        # old audio/video as if they were said/seen just now.
        flushed = 0
        while True:
            try:
                self._send_queue.get_nowait()
                flushed += 1
            except asyncio.QueueEmpty:
                break
        if flushed:
            metrics.inc("gemini_reconnect_flushed_chunks_total", flushed)
            logger.info("Flushed %d stale media chunks before (re)connect.", flushed)
        uri = f"{config.GEMINI_WS_HOST}?key={config.GEMINI_API_KEY}"
        logger.info("Connecting to Gemini Live (%s)…", config.GEMINI_API_VERSION)
        # max_size=None: model audio/text frames can exceed the 1 MiB default.
        try:
            self._ws = await websockets.connect(
                uri, max_size=None, ping_interval=20, ping_timeout=60
            )
        except Exception as exc:  # noqa: BLE001
            # The URI embeds ?key=<API_KEY>; some websockets exceptions stringify
            # the full URI. Re-raise a sanitized error (suppressing the cause) so
            # the secret never reaches a traceback, a log line, or a client body.
            raise RuntimeError(
                f"Gemini websocket connect failed ({type(exc).__name__})"
            ) from None
        await self._send(self._build_setup_message())

    async def _run_loops(self) -> None:
        """Run upstream()+downstream() until the session ends, then stop both."""
        up = asyncio.create_task(self.upstream(), name="gemini-upstream")
        down = asyncio.create_task(self.downstream(), name="gemini-downstream")
        self._loop_tasks = [up, down]
        try:
            await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in (up, down):
                t.cancel()
            await asyncio.gather(up, down, return_exceptions=True)
            self._loop_tasks = []

    async def wait_ready(self) -> None:
        await self._ready.wait()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        tasks = [*self._loop_tasks, *self._inflight_tools]
        if self._supervisor is not None:
            tasks.append(self._supervisor)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
        # A socket mid-retire when we were called still needs closing.
        if self._retiring_ws is not None:
            try:
                await self._retiring_ws.close()
            except Exception:  # noqa: BLE001
                pass
            self._retiring_ws = None
        logger.info("Gemini Live session closed.")

    # --------------------------------------------------------------- enqueue API
    def enqueue_audio(self, pcm16: bytes) -> None:
        """Queue a chunk of 16 kHz mono PCM16 microphone audio for upstream()."""
        self._enqueue({"type": "audio", "data": pcm16})

    def enqueue_video(self, jpeg: bytes) -> None:
        """Queue a single JPEG camera frame for upstream()."""
        self._enqueue({"type": "video", "data": jpeg})

    def _enqueue(self, item: dict) -> None:
        if self._closed or not item.get("data"):
            return
        try:
            self._send_queue.put_nowait(item)
        except asyncio.QueueFull:
            # Drop the oldest queued chunk to stay real-time, then enqueue.
            try:
                self._send_queue.get_nowait()
                self._send_queue.put_nowait(item)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass

    # ------------------------------------------------------------------ upstream
    async def upstream(self) -> None:
        """Drain the send-queue and push realtimeInput frames to Gemini."""
        await self._ready.wait()
        try:
            while not self._closed:
                item = await self._send_queue.get()
                b64 = base64.b64encode(item["data"]).decode("ascii")
                message = (
                    self._audio_message(b64)
                    if item["type"] == "audio"
                    else self._video_message(b64)
                )
                try:
                    await self._send(message)
                except websockets.ConnectionClosed:
                    break
                except Exception:  # noqa: BLE001
                    logger.exception("upstream send failed")
        except asyncio.CancelledError:
            raise  # supervisor is restarting/closing us
        logger.debug("upstream loop stopped.")

    def _audio_message(self, b64: str) -> dict:
        mime = f"audio/pcm;rate={config.GEMINI_INPUT_SAMPLE_RATE}"
        if config.GEMINI_USE_MEDIA_CHUNKS:
            return {"realtimeInput": {"mediaChunks": [{"mimeType": mime, "data": b64}]}}
        return {"realtimeInput": {"audio": {"mimeType": mime, "data": b64}}}

    def _video_message(self, b64: str) -> dict:
        if config.GEMINI_USE_MEDIA_CHUNKS:
            return {"realtimeInput": {"mediaChunks": [{"mimeType": "image/jpeg", "data": b64}]}}
        return {"realtimeInput": {"video": {"mimeType": "image/jpeg", "data": b64}}}

    # ---------------------------------------------------------------- downstream
    async def downstream(self) -> None:
        """Read Gemini's stream and dispatch audio / barge-in / tool calls."""
        assert self._ws is not None
        try:
            async for raw in self._ws:
                msg = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
                try:
                    data = json.loads(msg)
                except json.JSONDecodeError:
                    logger.warning("Non-JSON message from Gemini: %r", msg[:200])
                    continue
                await self._dispatch(data)
        except websockets.ConnectionClosed as exc:
            logger.info("Gemini websocket closed: %s", exc)
        except asyncio.CancelledError:
            raise  # supervisor is restarting/closing us
        except Exception:  # noqa: BLE001
            logger.exception("Error in Gemini downstream loop")
        logger.debug("downstream loop stopped.")
        # Returns on ws close/end; the supervisor decides reconnect-vs-give-up.

    async def _dispatch(self, data: dict) -> None:
        if "setupComplete" in data:
            reconnected = self._ever_ready  # a prior session existed -> this is a reconnect
            self._ready.set()
            self._ever_ready = True
            if reconnected and self._on_reconnected:
                logger.info("Gemini session re-established.")
                try:
                    self._on_reconnected()
                except Exception:  # noqa: BLE001
                    logger.exception("on_reconnected callback raised")
            return
        if "serverContent" in data:
            self._handle_server_content(data["serverContent"])
            return
        if "toolCall" in data:
            # Run the (multi-second) RAG lookup as a background task so the
            # downstream loop keeps draining and can still deliver `interrupted`
            # / `toolCallCancellation` while it runs. _send_lock serializes the
            # eventual toolResponse write, so concurrent dispatch is safe.
            tool_call = data["toolCall"]
            # Guard BEFORE spawning: a malformed frame must not become a task
            # that dies with AttributeError inside _handle_tool_call.
            if not isinstance(tool_call, dict) or not tool_call.get("functionCalls"):
                logger.warning("Ignoring malformed toolCall frame: %r", type(tool_call).__name__)
                return
            task = asyncio.create_task(self._handle_tool_call(tool_call))
            self._inflight_tools.add(task)
            # Index the task by every call id it covers, so a cancellation frame
            # can find and cancel it.
            calls = tool_call.get("functionCalls") or []
            ids = tuple(
                c.get("id") for c in calls if isinstance(c, dict) and c.get("id")
            )
            for call_id in ids:
                self._inflight_by_id[call_id] = task

            def _done(t: asyncio.Task, _ids=ids) -> None:
                self._inflight_tools.discard(t)
                for cid in _ids:
                    if self._inflight_by_id.get(cid) is t:
                        self._inflight_by_id.pop(cid, None)

            task.add_done_callback(_done)
            return
        if "sessionResumptionUpdate" in data:
            upd = data["sessionResumptionUpdate"]
            if not isinstance(upd, dict):  # truthy non-dict must not raise
                return
            if upd.get("resumable") and upd.get("newHandle"):
                self._resume_handle = upd["newHandle"]
                logger.debug("Stored session-resumption handle.")
            return
        if "toolCallCancellation" in data:
            # The server revoked call ids (e.g. user barge-in): actually CANCEL
            # the matching in-flight lookups instead of letting them burn for up
            # to NOTEBOOKLM_TIMEOUT_SECONDS and answer ids the server discarded.
            tcc = data["toolCallCancellation"]
            ids = tcc.get("ids") if isinstance(tcc, dict) else None
            cancelled = 0
            for cid in ids if isinstance(ids, list) else []:
                task = self._inflight_by_id.get(cid)
                if task is not None and not task.done():
                    task.cancel()
                    cancelled += 1
            logger.info(
                "Tool call cancellation for %s — cancelled %d in-flight task(s).",
                ids, cancelled,
            )
        elif "goAway" in data:
            # Server will close soon (e.g. session time limit). The supervisor
            # reconnects when the socket actually closes.
            logger.warning("Gemini goAway: %s", data["goAway"])
        elif "usageMetadata" not in data:
            logger.debug("Unhandled Gemini message keys: %s", list(data.keys()))

    def _handle_server_content(self, sc: dict) -> None:
        # The top-level value itself can be a truthy non-dict on a corrupted
        # frame (string/list/number) — guard it like every inner container below,
        # so a malformed frame can never raise out and force a needless reconnect.
        if not isinstance(sc, dict):
            return
        # Barge-in: the user spoke over the model -> drop any queued AI audio.
        if sc.get("interrupted"):
            logger.debug("Model interrupted (barge-in).")
            if self._on_interrupt:
                self._on_interrupt()

        # Transcription of the model's own speech (outputAudioTranscription was
        # requested in setup). Same defensive posture as modelTurn below: a
        # malformed frame must never raise out of here.
        transcription = sc.get("outputTranscription")
        if isinstance(transcription, dict) and self._on_transcript:
            t_text = transcription.get("text")
            if isinstance(t_text, str) and t_text:
                try:
                    self._on_transcript(t_text)
                except Exception:  # noqa: BLE001
                    logger.exception("on_transcript callback raised")

        # Transcription of the TECHNICIAN's speech (inputAudioTranscription).
        in_transcription = sc.get("inputTranscription")
        if isinstance(in_transcription, dict) and self._on_input_transcript:
            in_text = in_transcription.get("text")
            if isinstance(in_text, str) and in_text:
                try:
                    self._on_input_transcript(in_text)
                except Exception:  # noqa: BLE001
                    logger.exception("on_input_transcript callback raised")

        # A malformed frame must NOT raise here — that would kill downstream()
        # and tear down the whole session. So every container is isinstance-
        # guarded before .get(): modelTurn, the parts list elements, and
        # inlineData can each be null OR a truthy non-dict (string/list).
        model_turn = sc.get("modelTurn")
        if not isinstance(model_turn, dict):
            model_turn = {}
        parts = model_turn.get("parts")
        for part in (parts if isinstance(parts, list) else []):
            if not isinstance(part, dict):
                continue
            inline = part.get("inlineData")
            if isinstance(inline, dict) and inline.get("data"):
                if str(inline.get("mimeType", "")).startswith("audio/"):
                    try:
                        self._on_audio_out(base64.b64decode(inline["data"]))
                    except Exception:  # noqa: BLE001
                        logger.exception("Failed to handle model audio chunk")
            elif part.get("text") and self._on_text:
                self._on_text(part["text"])

        if sc.get("turnComplete"):
            logger.debug("Model turn complete.")
            if self._on_turn_complete:
                try:
                    self._on_turn_complete()
                except Exception:  # noqa: BLE001
                    logger.exception("on_turn_complete callback raised")

    async def _handle_tool_call(self, tool_call: dict) -> None:
        calls = tool_call.get("functionCalls", []) or []
        if not calls:
            return
        # Bind this tool turn to the socket it arrived on. A RAG lookup can take
        # many seconds; if the session drops and reconnects mid-lookup, the new
        # session never issued these call ids, so sending the response there would
        # misroute it. Capture the ws now and refuse to send if it was replaced.
        ws = self._ws

        async def _run_one(call: dict) -> dict:
            # A non-dict element (the pre-spawn guard only checks the container)
            # must not raise out of gather and leave the frame with no
            # toolResponse — return a synthetic error so valid sibling calls in
            # the same frame still get answered.
            if not isinstance(call, dict):
                return {"name": "", "response": {"result": "Ignored a malformed tool call."}}
            name = call.get("name", "")
            args = call.get("args", {}) or {}
            call_id = call.get("id")
            logger.info("toolCall -> %s(%s)", name, args)
            try:
                answer = await self._tool_dispatch(name, args)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - never drop a tool turn
                logger.exception("Tool dispatch raised")
                answer = f"Tool '{name}' failed: {exc}"
            response = {"name": name, "response": {"result": answer}}
            if call_id is not None:
                response["id"] = call_id
            return response

        # Dispatch every call in this frame CONCURRENTLY. A frame often pairs a
        # slow query_technical_manual (RAG, multi-second) with an instant
        # show_model / highlight_model_part / annotate; running them sequentially
        # held the visual behind the lookup (the diagram event fires DURING
        # dispatch via the data channel), so a "let me check and show you" turn
        # left the screen blank for the whole lookup. gather preserves the call
        # order in the result, so the toolResponse ordering is unchanged; a
        # cancellation of this frame task still propagates CancelledError into
        # every child await (whole-frame cancel semantics are preserved).
        function_responses = list(await asyncio.gather(*(_run_one(c) for c in calls)))

        if ws is not self._ws or self._closed:
            logger.warning(
                "Discarding toolResponse for %d call(s): the Gemini session was "
                "replaced (reconnect) or closed while the lookup ran.",
                len(function_responses),
            )
            return
        try:
            # Pinned to the originating socket: _send re-checks `ws is self._ws`
            # INSIDE the send lock, so a reconnect that lands while we wait for
            # the lock can't misroute this stale response onto the new session.
            written = await self._send(
                {"toolResponse": {"functionResponses": function_responses}}, ws=ws
            )
            if written:
                logger.info("toolResponse sent for %d call(s).", len(function_responses))
            else:
                metrics.inc("gemini_toolresponse_dropped_total")
                logger.warning(
                    "toolResponse discarded: session replaced while awaiting the send lock."
                )
        except websockets.ConnectionClosed:
            logger.warning("Could not send toolResponse: websocket closed.")

    # -------------------------------------------------------------------- setup
    def _build_setup_message(self) -> dict:
        speech_config: dict = {
            "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": config.GEMINI_VOICE}}
        }
        # Opt-in language (BCP-47). Omitted entirely when unset, so the default
        # setup frame stays byte-identical to the verified behavior.
        if config.GEMINI_LANGUAGE_CODE:
            speech_config["languageCode"] = config.GEMINI_LANGUAGE_CODE
        setup: dict = {
            "model": _model_path(config.GEMINI_LIVE_MODEL),
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": speech_config,
            },
            "systemInstruction": {"parts": [{"text": config.SYSTEM_INSTRUCTION}]},
            "tools": [{"functionDeclarations": config.TOOL_DECLARATIONS}],
        }
        # Enable session resumption so a reconnect can continue the conversation
        # context. On reconnect we pass the latest handle; first connect sends {}.
        if config.GEMINI_SESSION_RESUMPTION:
            setup["sessionResumption"] = (
                {"handle": self._resume_handle} if self._resume_handle else {}
            )
        # Ask the server to transcribe the model's spoken audio (live captions).
        # Empty config object per BidiGenerateContentSetup.outputAudioTranscription.
        if config.GEMINI_OUTPUT_TRANSCRIPTION:
            setup["outputAudioTranscription"] = {}
        # And the technician's speech (two-sided session record).
        if config.GEMINI_INPUT_TRANSCRIPTION:
            setup["inputAudioTranscription"] = {}
        return {"setup": setup}

    async def send_text(self, text: str) -> None:
        """Send a typed user message as a complete client turn.

        The loud-environment fallback: the technician types instead of speaking.
        Sent as `clientContent` with turnComplete so the model answers exactly as
        it would a spoken utterance (camera context + tools still apply). Dropped
        with a log when the session isn't ready — the caller treats this as
        best-effort, mirroring how mic audio is dropped pre-setup.
        """
        if self._closed or self._dead or not self._ready.is_set() or self._ws is None:
            logger.info("send_text dropped — Gemini session not ready.")
            return
        try:
            await self._send(
                {
                    "clientContent": {
                        "turns": [{"role": "user", "parts": [{"text": text}]}],
                        "turnComplete": True,
                    }
                }
            )
        except websockets.ConnectionClosed:
            # The socket died between the guard and the write (drop race). This
            # runs in a fire-and-forget task — honor the documented contract
            # (drop WITH a log) instead of leaking an unretrieved task exception.
            logger.info("send_text dropped — Gemini connection closed mid-send.")
        except Exception:  # noqa: BLE001 - never blow up the dispatch task
            logger.exception("send_text failed")

    async def _send(self, message: dict, ws=None) -> bool:
        """Serialized write. Pass `ws` to PIN the write to a specific socket:
        if the session was replaced while waiting for the lock, the write is
        dropped instead of landing on the NEW session (which never issued it).
        Returns True only when the frame was actually written."""
        target = ws if ws is not None else self._ws
        if target is None:
            return False
        async with self._send_lock:  # serialize writes across coroutines
            if ws is not None and ws is not self._ws:
                return False  # session replaced while we held/awaited the lock
            await target.send(json.dumps(message))
            return True
