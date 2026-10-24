"""
Mock integration tests for the AR Technician Assistant.

These run with NO network and NO live credentials. They verify the two pieces
the brief calls out explicitly:

  1. The Gemini `toolCall` interception loop in `GeminiBridge` produces a
     correctly-shaped `toolResponse` and invokes the dispatch handler.
  2. The NotebookLM retrieval loop (`fetch_technical_guidance`) parses an
     AskResult into a grounded, citation-bearing context block — exercised both
     in isolation and end-to-end through the tool-call interception path.

Plus focused unit checks for audio playout, barge-in, the setup frame, and the
realtime-input wire format.

Run:  pytest            (from the project root)
"""
from __future__ import annotations

import base64
import json

import pytest

import config
from services import knowledge, retrieval
from services.gemini_bridge import GeminiBridge
from services.metrics import metrics


# ===========================================================================
# Fakes for the notebooklm-py client (mirrors AskResult / ChatReference shape
# documented in docs/python-api.md).
# ===========================================================================
class _FakeRef:
    def __init__(self, citation_number, cited_text, source_id, title=None):
        self.citation_number = citation_number
        self.cited_text = cited_text
        self.source_id = source_id
        if title is not None:
            self.title = title


class _FakeAskResult:
    def __init__(self, answer, references):
        self.answer = answer
        self.references = references
        self.conversation_id = "conv-1"
        self.turn_number = 1
        self.is_follow_up = False
        self.raw_response = ""


class _FakeChat:
    def __init__(self, result):
        self._result = result
        self.calls: list[tuple[str, str]] = []

    async def ask(self, notebook_id, question, **kwargs):
        self.calls.append((notebook_id, question))
        return self._result


class _FakeClient:
    """Async context manager standing in for a connected NotebookLMClient."""

    def __init__(self, result):
        self.chat = _FakeChat(result)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeClientFactory:
    """Stands in for the `NotebookLMClient` class symbol in knowledge.py."""

    def __init__(self, result):
        self._result = result
        self.last: _FakeClient | None = None
        self.open_count = 0  # how many per-call clients were opened

    def from_storage(self, *args, **kwargs):
        # NOTE: NOT awaited — mirrors the canonical idiom the SDK uses.
        self.open_count += 1
        self.last = _FakeClient(self._result)
        return self.last


# ===========================================================================
# Bridge test harness with a fake websocket that captures sent frames.
# ===========================================================================
class _FakeWebSocket:
    def __init__(self):
        self.sent: list[dict] = []
        self.closed = False

    async def send(self, data):
        self.sent.append(json.loads(data))

    async def close(self):
        self.closed = True


def _make_bridge(dispatch=None):
    audio_out: list[bytes] = []
    interrupts: list[bool] = []
    texts: list[str] = []

    async def _default_dispatch(name, args):
        return "Torque: 25 N·m [1]"

    bridge = GeminiBridge(
        on_audio_out=audio_out.append,
        tool_dispatch=dispatch or _default_dispatch,
        on_interrupt=lambda: interrupts.append(True),
        on_text=texts.append,
    )
    bridge._ws = _FakeWebSocket()  # inject fake transport
    bridge._ready.set()            # pretend setupComplete already arrived
    return bridge, audio_out, interrupts, texts


# ===========================================================================
# 1. Tool-call interception
# ===========================================================================
async def test_tool_call_interception_sends_matching_response():
    seen = {}

    async def dispatch(name, args):
        seen["name"] = name
        seen["args"] = args
        return "Torque: 25 N·m, star pattern [1]"

    bridge, *_ = _make_bridge(dispatch)
    await bridge._handle_tool_call(
        {
            "functionCalls": [
                {"id": "call-1", "name": "query_technical_manual", "args": {"query": "torque?"}}
            ]
        }
    )

    assert len(bridge._ws.sent) == 1
    fr = bridge._ws.sent[0]["toolResponse"]["functionResponses"][0]
    assert fr["id"] == "call-1"
    assert fr["name"] == "query_technical_manual"
    assert "25" in fr["response"]["result"]
    # The dispatch handler received the model's exact arguments.
    assert seen == {"name": "query_technical_manual", "args": {"query": "torque?"}}


async def test_dispatch_routes_toolcall_as_background_task():
    bridge, *_ = _make_bridge()
    await bridge._dispatch(
        {
            "toolCall": {
                "functionCalls": [
                    {"id": "x9", "name": "query_technical_manual", "args": {"query": "q"}}
                ]
            }
        }
    )
    # _dispatch spawns the handler as a tracked background task; await it.
    assert bridge._inflight_tools, "tool call should have spawned a task"
    await _gather(bridge._inflight_tools)
    fr = bridge._ws.sent[0]["toolResponse"]["functionResponses"][0]
    assert fr["id"] == "x9"


async def test_tool_dispatch_failure_still_returns_response():
    async def boom(name, args):
        raise RuntimeError("kaboom")

    bridge, *_ = _make_bridge(boom)
    await bridge._handle_tool_call(
        {"functionCalls": [{"id": "c", "name": "query_technical_manual", "args": {}}]}
    )
    fr = bridge._ws.sent[0]["toolResponse"]["functionResponses"][0]
    assert "kaboom" in fr["response"]["result"]  # error surfaced, turn not dropped


async def test_frame_calls_dispatch_concurrently_preserving_order():
    """Calls in ONE toolCall frame run concurrently — a fast show_model behind a
    slow RAG lookup fires immediately instead of waiting for the lookup — while
    the toolResponse still bundles all calls IN ORDER."""
    import asyncio

    started_fast = asyncio.Event()
    release_slow = asyncio.Event()

    async def dispatch(name, args):
        if name == "query_technical_manual":  # the slow one (first in the frame)
            await release_slow.wait()
            return "manual answer"
        started_fast.set()  # the fast one (show_model) — runs while slow is blocked
        return "showed diagram"

    bridge, *_ = _make_bridge(dispatch)
    task = asyncio.create_task(
        bridge._handle_tool_call(
            {
                "functionCalls": [
                    {"id": "slow", "name": "query_technical_manual", "args": {}},
                    {"id": "fast", "name": "show_model", "args": {}},
                ]
            }
        )
    )
    # The fast call must complete even though the slow call (first in the frame)
    # is still blocked — proves concurrent dispatch.
    await asyncio.wait_for(started_fast.wait(), timeout=1.0)
    assert bridge._ws.sent == []  # the frame still waits for ALL calls before responding
    release_slow.set()
    await task
    fr = bridge._ws.sent[0]["toolResponse"]["functionResponses"]
    assert [r["id"] for r in fr] == ["slow", "fast"]  # order preserved
    assert fr[0]["response"]["result"] == "manual answer"
    assert fr[1]["response"]["result"] == "showed diagram"


async def test_frame_one_call_fails_others_still_answer():
    """One failing call in a multi-call frame must not drop the others' answers."""
    async def dispatch(name, args):
        if name == "boom":
            raise RuntimeError("kaboom")
        return "ok"

    bridge, *_ = _make_bridge(dispatch)
    await bridge._handle_tool_call(
        {
            "functionCalls": [
                {"id": "a", "name": "boom", "args": {}},
                {"id": "b", "name": "annotate_component", "args": {}},
            ]
        }
    )
    fr = bridge._ws.sent[0]["toolResponse"]["functionResponses"]
    assert [r["id"] for r in fr] == ["a", "b"]
    assert "kaboom" in fr[0]["response"]["result"]
    assert fr[1]["response"]["result"] == "ok"


# ===========================================================================
# 2. NotebookLM retrieval loop (isolated)
# ===========================================================================
async def test_fetch_technical_guidance_parses_answer_and_citations(monkeypatch):
    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "nb-1")
    monkeypatch.setattr(config, "NOTEBOOKLM_STORAGE", "")
    monkeypatch.setattr(config, "NOTEBOOKLM_PROFILE", "")
    monkeypatch.setattr(config, "NOTEBOOKLM_RESOLVE_CITATIONS", False)

    factory = _FakeClientFactory(
        _FakeAskResult(
            "Error E-45 means motor over-temperature; stop and cool 20 minutes [1].",
            [_FakeRef(1, "Motor over-temperature. Stop the pump.", "src-9")],
        )
    )
    monkeypatch.setattr(knowledge, "NotebookLMClient", factory)

    out = await knowledge.fetch_technical_guidance("What does E-45 mean?")

    assert "E-45" in out
    assert "motor over-temperature" in out.lower()
    assert "SOURCES" in out
    assert "Motor over-temperature" in out  # the cited_text is surfaced
    # The correct notebook id + query reached the SDK.
    assert factory.last.chat.calls == [("nb-1", "What does E-45 mean?")]


async def test_fetch_technical_guidance_handles_empty_query():
    out = await knowledge.fetch_technical_guidance("   ")
    assert out  # non-empty contract
    assert "no query" in out.lower()


async def test_fetch_technical_guidance_unconfigured_notebook(monkeypatch):
    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "")
    out = await knowledge.fetch_technical_guidance("anything")
    assert out and "not configured" in out.lower()


# ===========================================================================
# 3. End-to-end: toolCall interception drives the RAG retrieval loop
# ===========================================================================
async def test_toolcall_invokes_rag_and_returns_grounded_answer(monkeypatch):
    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "nb-77")
    monkeypatch.setattr(config, "NOTEBOOKLM_STORAGE", "")
    monkeypatch.setattr(config, "NOTEBOOKLM_PROFILE", "")
    monkeypatch.setattr(config, "NOTEBOOKLM_RESOLVE_CITATIONS", False)

    factory = _FakeClientFactory(
        _FakeAskResult(
            "The M8 head bolts torque to 25 N·m in a star pattern [1].",
            [_FakeRef(1, "Pump head bolts (M8): 25 N·m, star pattern.", "src-4")],
        )
    )
    monkeypatch.setattr(knowledge, "NotebookLMClient", factory)

    # This is the real wiring main.py uses: route the tool to the RAG service.
    async def dispatch(name, args):
        if name == config.QUERY_TOOL_NAME:
            return await knowledge.fetch_technical_guidance(args.get("query", ""))
        return f"Unknown tool '{name}'."

    bridge, *_ = _make_bridge(dispatch)
    await bridge._handle_tool_call(
        {
            "functionCalls": [
                {
                    "id": "t-1",
                    "name": "query_technical_manual",
                    "args": {"query": "Torque spec for the M8 head bolts?"},
                }
            ]
        }
    )

    result_text = bridge._ws.sent[0]["toolResponse"]["functionResponses"][0]["response"]["result"]
    assert "25" in result_text
    assert "star pattern" in result_text.lower()
    assert "SOURCES" in result_text
    assert factory.last.chat.calls == [("nb-77", "Torque spec for the M8 head bolts?")]


# ===========================================================================
# 4. Audio playout + barge-in + text
# ===========================================================================
async def test_server_audio_is_decoded_to_pcm():
    bridge, audio_out, _, _ = _make_bridge()
    pcm = bytes(range(32))
    b64 = base64.b64encode(pcm).decode("ascii")
    bridge._handle_server_content(
        {"modelTurn": {"parts": [{"inlineData": {"mimeType": "audio/pcm;rate=24000", "data": b64}}]}}
    )
    assert audio_out == [pcm]


async def test_barge_in_triggers_interrupt():
    bridge, _, interrupts, _ = _make_bridge()
    bridge._handle_server_content({"interrupted": True})
    assert interrupts == [True]


async def test_model_text_part_is_forwarded():
    bridge, _, _, texts = _make_bridge()
    bridge._handle_server_content({"modelTurn": {"parts": [{"text": "Loosen the bolt."}]}})
    assert texts == ["Loosen the bolt."]


# ===========================================================================
# 5. Setup frame + realtime-input wire format
# ===========================================================================
async def test_setup_frame_declares_tool_and_audio():
    bridge, *_ = _make_bridge()
    setup = bridge._build_setup_message()["setup"]
    assert setup["model"].startswith("models/")
    assert setup["generationConfig"]["responseModalities"] == ["AUDIO"]
    decl = setup["tools"][0]["functionDeclarations"][0]
    assert decl["name"] == "query_technical_manual"
    assert "query" in decl["parameters"]["properties"]
    assert decl["parameters"]["required"] == ["query"]


async def test_realtime_message_formats(monkeypatch):
    bridge, *_ = _make_bridge()

    # Typed-field mode (default).
    monkeypatch.setattr(config, "GEMINI_USE_MEDIA_CHUNKS", False)
    audio = bridge._audio_message("AAA")
    assert audio["realtimeInput"]["audio"]["data"] == "AAA"
    assert audio["realtimeInput"]["audio"]["mimeType"].startswith("audio/pcm;rate=")
    video = bridge._video_message("BBB")
    assert video["realtimeInput"]["video"]["mimeType"] == "image/jpeg"

    # Legacy mediaChunks mode.
    monkeypatch.setattr(config, "GEMINI_USE_MEDIA_CHUNKS", True)
    audio2 = bridge._audio_message("CCC")
    assert audio2["realtimeInput"]["mediaChunks"][0]["data"] == "CCC"
    video2 = bridge._video_message("DDD")
    assert video2["realtimeInput"]["mediaChunks"][0]["mimeType"] == "image/jpeg"


async def test_enqueue_drops_oldest_when_full():
    bridge, *_ = _make_bridge()
    # Fill beyond capacity; _enqueue must not raise and must stay bounded.
    for i in range(bridge._send_queue.maxsize + 50):
        bridge.enqueue_audio(bytes([i % 256]))
    assert bridge._send_queue.qsize() <= bridge._send_queue.maxsize


# ===========================================================================
# 6. Session-death propagation (Gemini socket dies -> transport teardown)
# ===========================================================================
async def _noop_dispatch(name, args):
    return "ok"


async def test_signal_dead_fires_on_session_end_once():
    ended = []
    bridge = GeminiBridge(
        on_audio_out=lambda b: None,
        tool_dispatch=_noop_dispatch,
        on_session_end=lambda: ended.append(True),
    )
    bridge._signal_dead()
    bridge._signal_dead()  # idempotent
    assert ended == [True]
    assert bridge._dead is True
    assert bridge._ready.is_set()  # unblocks a start() waiter


async def test_signal_dead_suppressed_after_caller_close():
    ended = []
    bridge = GeminiBridge(
        on_audio_out=lambda b: None,
        tool_dispatch=_noop_dispatch,
        on_session_end=lambda: ended.append(True),
    )
    bridge._closed = True  # caller-initiated close already happened
    bridge._signal_dead()
    assert ended == []  # do not fire session-end on a deliberate close


class _EndingWebSocket:
    """Async-iterable fake ws that yields given messages then ends the stream."""

    def __init__(self, messages):
        self._messages = list(messages)
        self.sent = []

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._messages:
            return self._messages.pop(0)
        raise StopAsyncIteration

    async def send(self, data):
        self.sent.append(json.loads(data))

    async def close(self):
        pass


async def test_downstream_natural_exit_does_not_signal_dead():
    # With reconnect, a downstream exit is NOT terminal — the supervisor decides
    # reconnect-vs-give-up, so on_session_end must NOT fire from the loop itself.
    ended = []
    bridge = GeminiBridge(
        on_audio_out=lambda b: None,
        tool_dispatch=_noop_dispatch,
        on_session_end=lambda: ended.append(True),
    )
    bridge._ws = _EndingWebSocket([json.dumps({"setupComplete": {}})])
    await bridge.downstream()  # processes setupComplete, then the stream ends
    assert bridge._ready.is_set()  # setupComplete was handled
    assert ended == []  # the supervisor, not the loop, owns session-end now


# ===========================================================================
# 7. Blank-answer fallback (never speak the AskResult repr)
# ===========================================================================
async def test_blank_answer_returns_fallback_not_repr(monkeypatch):
    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "nb")
    monkeypatch.setattr(config, "NOTEBOOKLM_STORAGE", "")
    monkeypatch.setattr(config, "NOTEBOOKLM_PROFILE", "")
    monkeypatch.setattr(config, "NOTEBOOKLM_RESOLVE_CITATIONS", False)
    factory = _FakeClientFactory(_FakeAskResult("   ", []))  # whitespace, no refs
    monkeypatch.setattr(knowledge, "NotebookLMClient", factory)

    out = await knowledge.fetch_technical_guidance("does the manual cover X?")
    assert "AskResult(" not in out          # no dataclass repr leaked
    assert "no answer" in out.lower()       # the dedicated fallback fired


# ===========================================================================
# 8. NotebookLM domain error -> tailored (not generic) message
# ===========================================================================
async def test_domain_error_returns_tailored_message(monkeypatch):
    from notebooklm import ChatError  # subclasses NotebookLMError, not RPCError

    class _RaisingChat:
        async def ask(self, notebook_id, question, **kwargs):
            raise ChatError("post-ask round-trip failed")

    class _RaisingClient:
        def __init__(self):
            self.chat = _RaisingChat()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class _RaisingFactory:
        def from_storage(self, *a, **k):
            return _RaisingClient()

    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "nb")
    monkeypatch.setattr(config, "NOTEBOOKLM_STORAGE", "")
    monkeypatch.setattr(config, "NOTEBOOKLM_PROFILE", "")
    monkeypatch.setattr(knowledge, "NotebookLMClient", _RaisingFactory())

    out = await knowledge.fetch_technical_guidance("q")
    assert out and "unreachable" in out.lower()  # tailored NotebookLMError clause


# ===========================================================================
# 9. /offer input validation (real endpoint via TestClient — sync tests)
# ===========================================================================
def _client():
    from fastapi.testclient import TestClient
    import main

    return TestClient(main.app)


def test_offer_rejects_non_json_body():
    resp = _client().post(
        "/offer", content=b"\xff not json", headers={"Content-Type": "application/json"}
    )
    assert resp.status_code == 400


def test_offer_rejects_non_object_json():
    resp = _client().post("/offer", json=5)  # valid JSON, but not an object
    assert resp.status_code == 400


def test_offer_rejects_missing_fields():
    resp = _client().post("/offer", json={})
    assert resp.status_code == 400


def test_offer_rejects_non_string_fields():
    resp = _client().post("/offer", json={"sdp": 123, "type": None})
    assert resp.status_code == 400


def test_offer_error_body_never_echoes_internals():
    # The 400 bodies must be generic — no exception text / no secrets.
    body = _client().post("/offer", json={}).text.lower()
    assert "traceback" not in body and "key=" not in body


# ===========================================================================
# 10. Malformed serverContent must NOT crash downstream / tear down the session
# ===========================================================================
async def test_handle_server_content_tolerates_malformed_parts():
    bridge, audio_out, _, texts = _make_bridge()
    # None of these well-formed-but-degenerate or malformed frames may raise
    # (a raise would propagate to downstream() and tear down the live session).
    bridge._handle_server_content({"modelTurn": {"parts": None}})          # parts null
    bridge._handle_server_content({"modelTurn": {"parts": "notalist"}})    # parts non-list
    bridge._handle_server_content({"modelTurn": "x"})                      # modelTurn non-dict
    bridge._handle_server_content({"modelTurn": ["a"]})                    # modelTurn list
    bridge._handle_server_content({"modelTurn": {"parts": [{"inlineData": "x"}]}})  # inlineData non-dict
    bridge._handle_server_content({})                                      # no modelTurn at all
    assert audio_out == []  # none of the above carried valid audio

    # a list with a null and a bare string mixed with a valid dict part.
    bridge._handle_server_content(
        {"modelTurn": {"parts": [None, "oops", {"text": "Loosen the bolt."}]}}
    )
    assert texts == ["Loosen the bolt."]   # valid part still processed


async def test_dispatch_tolerates_malformed_frame_values_no_reconnect():
    """A truthy NON-DICT frame value must not raise out of _dispatch — otherwise
    downstream() exits and the supervisor forces a needless reconnect."""
    bridge, *_ = _make_bridge()
    # serverContent value itself a non-dict (string/list/number).
    bridge._handle_server_content("garbage")  # entry-guard: no raise
    for bad in ("garbage", ["x"], 7):
        await bridge._dispatch({"serverContent": bad})
    # sessionResumptionUpdate value a truthy non-dict — must not raise or store.
    bridge._resume_handle = None
    for bad in ("garbage", ["x"], 7):
        await bridge._dispatch({"sessionResumptionUpdate": bad})
    assert bridge._resume_handle is None


async def test_toolcall_with_non_dict_element_still_answers_valid_calls():
    """A non-dict functionCalls element must not kill the tool task — the valid
    sibling call must still get a toolResponse (Gemini would otherwise stall)."""
    async def dispatch(name, args):
        return "ok"

    bridge, *_ = _make_bridge(dispatch)
    await bridge._handle_tool_call(
        {"functionCalls": [{"id": "good", "name": "query_technical_manual", "args": {}}, "notadict", None]}
    )
    fr = bridge._ws.sent[0]["toolResponse"]["functionResponses"]
    ids = [r.get("id") for r in fr]
    assert "good" in ids  # the valid call was answered
    assert any(r["response"]["result"] == "ok" for r in fr)
    # the malformed elements produced synthetic responses, never an exception
    assert len(fr) == 3


# ===========================================================================
# 11. v2 speed — L1 cache + warm-client fallback
# ===========================================================================
def _configure_nb(monkeypatch, factory, notebook="nb"):
    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", notebook)
    monkeypatch.setattr(config, "NOTEBOOKLM_STORAGE", "")
    monkeypatch.setattr(config, "NOTEBOOKLM_PROFILE", "")
    monkeypatch.setattr(config, "NOTEBOOKLM_RESOLVE_CITATIONS", False)
    monkeypatch.setattr(knowledge, "NotebookLMClient", factory)
    monkeypatch.setattr(knowledge, "_warm_client", None)  # default: per-call path
    knowledge.clear_cache()


async def test_l1_cache_serves_repeat_query(monkeypatch):
    factory = _FakeClientFactory(
        _FakeAskResult("The torque is 25 N·m [1].", [_FakeRef(1, "25 N·m", "s1")])
    )
    _configure_nb(monkeypatch, factory)
    a = await knowledge.fetch_technical_guidance("M8 torque?")
    b = await knowledge.fetch_technical_guidance("   m8   TORQUE? ")  # normalizes equal
    assert a == b
    assert factory.open_count == 1  # 2nd call served from cache; no new client opened


async def test_l1_cache_does_not_cache_blank_answer(monkeypatch):
    factory = _FakeClientFactory(_FakeAskResult("   ", []))  # blank -> NO_ANSWER fallback
    _configure_nb(monkeypatch, factory)
    await knowledge.fetch_technical_guidance("unknown thing?")
    await knowledge.fetch_technical_guidance("unknown thing?")
    assert factory.open_count == 2  # non-answers are not cached -> re-fetched


async def test_clear_cache_forces_refetch(monkeypatch):
    factory = _FakeClientFactory(_FakeAskResult("Answer [1].", [_FakeRef(1, "x", "s1")]))
    _configure_nb(monkeypatch, factory)
    await knowledge.fetch_technical_guidance("q1?")
    knowledge.clear_cache()
    await knowledge.fetch_technical_guidance("q1?")
    assert factory.open_count == 2


async def test_warm_client_used_when_present(monkeypatch):
    result = _FakeAskResult("Warm answer [1].", [_FakeRef(1, "x", "s1")])
    factory = _FakeClientFactory(result)
    _configure_nb(monkeypatch, factory)
    # Inject a warm singleton; the query must use it and NOT open a per-call client.
    monkeypatch.setattr(knowledge, "_warm_client", _FakeClient(result))
    out = await knowledge.fetch_technical_guidance("warm path?")
    assert "Warm answer" in out
    assert factory.open_count == 0  # per-call client never opened


async def test_concurrent_lookups_bounded_by_semaphore(monkeypatch):
    """A frame's concurrent query_technical_manual calls cannot fan out more live
    NotebookLM round-trips than NOTEBOOKLM_MAX_CONCURRENT_LOOKUPS at once."""
    import asyncio

    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "nb")
    monkeypatch.setattr(config, "NOTEBOOKLM_LOCAL_FAST_PATH", False)
    monkeypatch.setattr(config, "NOTEBOOKLM_MAX_CONCURRENT_LOOKUPS", 2)
    knowledge.clear_cache()
    monkeypatch.setattr(knowledge, "_lookup_sem", None)  # rebuild with the test cap

    in_flight = 0
    peak = 0
    gate = asyncio.Event()

    async def fake_run(query):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        try:
            await gate.wait()
            return "Answer [1]."
        finally:
            in_flight -= 1

    monkeypatch.setattr(knowledge, "_run", fake_run)
    tasks = [
        asyncio.create_task(knowledge.fetch_technical_guidance(f"distinct query {i}?"))
        for i in range(5)
    ]
    await asyncio.sleep(0.05)  # let them pile up at the semaphore
    assert peak == 2  # exactly the cap is in flight; the other 3 wait
    gate.set()
    await asyncio.gather(*tasks)
    assert peak == 2  # never exceeded the cap across the whole drain


# ===========================================================================
# 12. Step 3 — annotate_component tool + data-channel dispatch
# ===========================================================================
class _FakeDataChannel:
    def __init__(self, ready_state="open"):
        self.readyState = ready_state
        self.label = "events"
        self.sent: list[dict] = []

    def send(self, data):
        self.sent.append(json.loads(data))


def _new_peer_session():
    import main
    from aiortc import RTCPeerConnection

    pc = RTCPeerConnection()
    return main.PeerSession(pc), pc


def test_tool_declarations_include_query_and_annotate():
    names = [d["name"] for d in config.TOOL_DECLARATIONS]
    assert "query_technical_manual" in names
    assert "annotate_component" in names


async def test_setup_advertises_both_tools():
    bridge, *_ = _make_bridge()
    decls = bridge._build_setup_message()["setup"]["tools"][0]["functionDeclarations"]
    names = [d["name"] for d in decls]
    assert "query_technical_manual" in names and "annotate_component" in names


async def test_annotate_dispatch_sends_over_data_channel():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool(
            "annotate_component",
            {"label": "M8 head bolt", "detail": "25 N·m", "box": [100, 200, 300, 400]},
        )
        assert "M8 head bolt" in ack
        assert len(dc.sent) == 1
        ev = dc.sent[0]
        assert ev["type"] == "annotate"
        assert ev["label"] == "M8 head bolt"
        assert ev["detail"] == "25 N·m"
        assert ev["box"] == [100.0, 200.0, 300.0, 400.0]
    finally:
        await pc.close()


async def test_annotate_without_open_channel_acks_gracefully():
    session, pc = _new_peer_session()
    try:
        # No data channel attached -> must not raise, must still ack the model.
        ack = await session._dispatch_tool(
            "annotate_component", {"label": "pressure gauge", "box": [10, 10, 50, 50]}
        )
        assert "pressure gauge" in ack
    finally:
        await pc.close()


async def test_annotate_malformed_box_is_rejected():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool(
            "annotate_component", {"label": "bolt", "box": [1, 2, 3]}  # only 3 numbers
        )
        assert "malformed" in ack.lower() or "missing" in ack.lower()
        assert dc.sent == []  # nothing pushed to the client
    finally:
        await pc.close()


async def test_closed_channel_drops_event_without_error():
    session, pc = _new_peer_session()
    try:
        session.attach_data_channel(_FakeDataChannel(ready_state="connecting"))
        ack = await session._dispatch_tool(
            "annotate_component", {"label": "lever", "box": [0, 0, 100, 100]}
        )
        assert "lever" in ack  # graceful ack even though the channel isn't open
    finally:
        await pc.close()


# ===========================================================================
# 12b. Richer annotate (shape/level/step) + clear_annotations tool
# ===========================================================================
async def test_annotate_forwards_shape_level_step():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool(
            "annotate_component",
            {"label": "E-45 light", "box": [10, 10, 50, 50],
             "shape": "point", "level": "danger", "step": 2},
        )
        ev = dc.sent[0]
        assert ev["shape"] == "point" and ev["level"] == "danger" and ev["step"] == 2
        assert "step 2" in ack
    finally:
        await pc.close()


async def test_annotate_sanitizes_unknown_shape_level_and_zero_step():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "annotate_component",
            {"label": "x", "box": [0, 0, 10, 10],
             "shape": "triangle", "level": "purple", "step": 0},
        )
        ev = dc.sent[0]
        assert ev["shape"] == "box"   # unknown shape -> default
        assert ev["level"] == "info"  # unknown level -> default
        assert "step" not in ev       # 0 is not a valid step -> omitted
    finally:
        await pc.close()


async def test_annotate_step_coercions():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        for raw, expected in [(3.0, 3), ("4", 4), (-1, None), (True, None), (2, 2)]:
            dc.sent.clear()
            await session._dispatch_tool(
                "annotate_component", {"label": "x", "box": [0, 0, 1, 1], "step": raw}
            )
            assert dc.sent[0].get("step") == expected, (raw, dc.sent[0].get("step"))
    finally:
        await pc.close()


async def test_clear_annotations_one_then_all():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack1 = await session._dispatch_tool("clear_annotations", {"label": "bolt"})
        assert dc.sent[0] == {"type": "annotate_clear", "label": "bolt"}
        assert "bolt" in ack1
        dc.sent.clear()
        ack2 = await session._dispatch_tool("clear_annotations", {})
        assert dc.sent[0] == {"type": "annotate_clear", "label": None}
        assert "all" in ack2.lower()
    finally:
        await pc.close()


async def test_query_tool_brackets_lookup_activity_events(monkeypatch):
    """The manual lookup emits activity lookup -> idle around the RAG call."""
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)

        async def fake_fetch(query):
            return "Torque: 25 N·m [1]"

        monkeypatch.setattr(knowledge, "fetch_technical_guidance", fake_fetch)
        out = await session._dispatch_tool("query_technical_manual", {"query": "torque?"})
        assert "25" in out
        states = [e["state"] for e in dc.sent if e.get("type") == "activity"]
        assert states == ["lookup", "idle"]
    finally:
        await pc.close()


async def test_query_tool_clears_activity_even_on_exception(monkeypatch):
    """A raising lookup must STILL emit the idle event (finally path)."""
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)

        async def boom(query):
            raise RuntimeError("lookup exploded")

        monkeypatch.setattr(knowledge, "fetch_technical_guidance", boom)
        with pytest.raises(RuntimeError):
            await session._dispatch_tool("query_technical_manual", {"query": "q"})
        states = [e["state"] for e in dc.sent if e.get("type") == "activity"]
        assert states == ["lookup", "idle"]  # idle still sent despite the raise
    finally:
        await pc.close()


async def test_take_snapshot_dispatch_sends_event_and_acks():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool("take_snapshot", {})
        assert dc.sent == [{"type": "snapshot"}]
        # Honest wording: the server claims a save REQUEST, not a verified save.
        assert "photo" in ack.lower() and "save" in ack.lower()
    finally:
        await pc.close()


async def test_take_snapshot_without_channel_acks_gracefully():
    session, pc = _new_peer_session()
    try:
        ack = await session._dispatch_tool("take_snapshot", {})
        assert "snap button" in ack.lower()  # fallback guidance, no raise
    finally:
        await pc.close()


def test_tool_declarations_include_take_snapshot():
    names = [d["name"] for d in config.TOOL_DECLARATIONS]
    assert "take_snapshot" in names


def test_tool_declarations_include_clear_and_new_fields():
    names = [d["name"] for d in config.TOOL_DECLARATIONS]
    assert "clear_annotations" in names
    annotate = next(d for d in config.TOOL_DECLARATIONS if d["name"] == "annotate_component")
    props = annotate["parameters"]["properties"]
    assert {"shape", "level", "step"} <= set(props)
    assert props["shape"]["enum"] == ["box", "point", "arrow"]
    assert props["level"]["enum"] == ["info", "warn", "danger"]


# ===========================================================================
# 12c. Live captions — outputAudioTranscription + transcript forwarding
# ===========================================================================
async def test_setup_includes_output_transcription(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_OUTPUT_TRANSCRIPTION", True)
    bridge, *_ = _make_bridge()
    setup = bridge._build_setup_message()["setup"]
    assert setup["outputAudioTranscription"] == {}
    monkeypatch.setattr(config, "GEMINI_OUTPUT_TRANSCRIPTION", False)
    assert "outputAudioTranscription" not in bridge._build_setup_message()["setup"]


async def test_output_transcription_fires_callback():
    got: list[str] = []
    done: list[bool] = []
    bridge = GeminiBridge(
        on_audio_out=lambda b: None,
        tool_dispatch=_noop_dispatch,
        on_transcript=got.append,
        on_turn_complete=lambda: done.append(True),
    )
    bridge._handle_server_content({"outputTranscription": {"text": "Torque is 25 "}})
    bridge._handle_server_content({"outputTranscription": {"text": "newton metres."}})
    bridge._handle_server_content({"turnComplete": True})
    assert got == ["Torque is 25 ", "newton metres."]
    assert done == [True]


async def test_output_transcription_tolerates_malformed():
    got: list[str] = []
    bridge = GeminiBridge(
        on_audio_out=lambda b: None,
        tool_dispatch=_noop_dispatch,
        on_transcript=got.append,
    )
    # None of these may raise (a raise would kill downstream() -> session).
    bridge._handle_server_content({"outputTranscription": None})
    bridge._handle_server_content({"outputTranscription": "not-a-dict"})
    bridge._handle_server_content({"outputTranscription": {"text": None}})
    bridge._handle_server_content({"outputTranscription": {"text": 42}})
    bridge._handle_server_content({"outputTranscription": {}})
    assert got == []


async def test_transcript_events_forwarded_over_data_channel():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        session._on_transcript("Loosen the M8 bolt. ")
        session._on_turn_complete()
        assert dc.sent[0] == {
            "type": "transcript",
            "role": "assistant",
            "text": "Loosen the M8 bolt. ",
        }
        assert dc.sent[1] == {"type": "transcript_done"}
    finally:
        await pc.close()


# ===========================================================================
# 12d. Typed text input — send_text frame + inbound data-channel validation
# ===========================================================================
class _FakeEventChannel(_FakeDataChannel):
    """Fake data channel that also supports aiortc's .on('message') registration."""

    def __init__(self, ready_state="open"):
        super().__init__(ready_state)
        self.handlers: dict = {}

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn

        return deco


async def test_send_text_frame_format():
    bridge, *_ = _make_bridge()  # _ready already set, fake ws injected
    await bridge.send_text("What torque for the M8 bolts?")
    assert bridge._ws.sent == [
        {
            "clientContent": {
                "turns": [
                    {"role": "user", "parts": [{"text": "What torque for the M8 bolts?"}]}
                ],
                "turnComplete": True,
            }
        }
    ]


async def test_send_text_dropped_when_not_ready():
    bridge, *_ = _make_bridge()
    bridge._ready.clear()  # session not ready -> must drop, not raise
    await bridge.send_text("hello")
    assert bridge._ws.sent == []


async def test_user_text_dispatches_to_bridge(monkeypatch):
    import asyncio

    session, pc = _new_peer_session()
    try:
        dc = _FakeEventChannel()
        session.attach_data_channel(dc)
        assert "message" in dc.handlers  # inbound handler registered

        sent: list[str] = []

        async def fake_send_text(text):
            sent.append(text)

        monkeypatch.setattr(session.bridge, "send_text", fake_send_text)
        dc.handlers["message"](json.dumps({"type": "user_text", "text": "  check the seal  "}))
        await asyncio.sleep(0)  # let the dispatched task run
        assert sent == ["check the seal"]  # validated + stripped
    finally:
        await pc.close()


async def test_user_text_rejects_malformed_and_oversized(monkeypatch):
    import asyncio

    session, pc = _new_peer_session()
    try:
        dc = _FakeEventChannel()
        session.attach_data_channel(dc)
        sent: list[str] = []

        async def fake_send_text(text):
            sent.append(text)

        monkeypatch.setattr(session.bridge, "send_text", fake_send_text)
        h = dc.handlers["message"]
        h(b"binary-frame")                                    # not a str
        h("not json at all")                                  # invalid JSON
        h(json.dumps(["user_text", "x"]))                     # not an object
        h(json.dumps({"type": "other", "text": "x"}))         # unknown type
        h(json.dumps({"type": "user_text", "text": 42}))      # non-string text
        h(json.dumps({"type": "user_text", "text": "   "}))   # blank
        h(json.dumps({"type": "user_text", "text": "x" * 3000}))  # over the cap
        h("y" * 20000)                                        # oversized raw frame
        await asyncio.sleep(0)
        assert sent == []  # every malformed frame silently dropped
    finally:
        await pc.close()


# ===========================================================================
# 12e. Video encode — single-pass downscale correctness (sync, unit-testable)
# ===========================================================================
def _jpeg_size(buf: bytes) -> tuple[int, int]:
    """Decode JPEG bytes -> (width, height) using cv2 (no PIL dependency)."""
    import numpy as np
    import cv2

    img = cv2.imdecode(np.frombuffer(buf, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert img is not None, "produced JPEG did not decode"
    h, w = img.shape[:2]
    return w, h


def test_frame_to_jpeg_downscales_large_frame():
    import av
    import numpy as np
    from services.webrtc_tracks import frame_to_jpeg

    img = np.zeros((720, 1280, 3), dtype="uint8")
    img[:, :, 1] = 200  # green-ish so the JPEG isn't degenerate
    frame = av.VideoFrame.from_ndarray(img, format="bgr24")
    out = frame_to_jpeg(frame, max_width=768, quality=70)
    assert out and out[:2] == b"\xff\xd8"  # JPEG SOI marker
    w, h = _jpeg_size(out)
    assert w == 768
    assert h == 432  # 720 * (768/1280) — aspect preserved


def test_frame_to_jpeg_never_upscales_small_frame():
    import av
    import numpy as np
    from services.webrtc_tracks import frame_to_jpeg

    img = np.full((240, 320, 3), 128, dtype="uint8")
    frame = av.VideoFrame.from_ndarray(img, format="bgr24")
    out = frame_to_jpeg(frame, max_width=768, quality=70)
    assert out is not None
    w, h = _jpeg_size(out)
    assert (w, h) == (320, 240)  # untouched — no upscale


def test_frame_to_jpeg_yuv_frame_single_pass():
    import av
    import numpy as np
    from services.webrtc_tracks import frame_to_jpeg

    # Real camera frames arrive as YUV — exercise reformat()'s combined
    # colorspace+scale path with one.
    img = np.zeros((480, 960, 3), dtype="uint8")
    img[:, :, 2] = 180
    frame = av.VideoFrame.from_ndarray(img, format="bgr24").reformat(format="yuv420p")
    out = frame_to_jpeg(frame, max_width=480, quality=70)
    assert out is not None
    w, h = _jpeg_size(out)
    assert w == 480 and h == 240


# ===========================================================================
# 12f. Reconnect correctness + hygiene (wave-2 #1)
# ===========================================================================
class _ClosableWebSocket(_FakeWebSocket):
    def __init__(self):
        super().__init__()
        self.close_calls = 0

    async def close(self):
        self.close_calls += 1
        self.closed = True


async def test_retire_socket_clears_ready_and_closes_ws():
    bridge, *_ = _make_bridge()
    ws = _ClosableWebSocket()
    bridge._ws = ws
    bridge._ready.set()
    await bridge._retire_socket()
    assert not bridge._ready.is_set()  # send_text guard now fails closed
    assert bridge._ws is None          # no stale socket for guards to pass on
    assert ws.close_calls == 1         # old socket + ping task actually closed
    await bridge._retire_socket()      # idempotent
    assert ws.close_calls == 1


async def test_send_text_survives_connection_closed(monkeypatch):
    from websockets.exceptions import ConnectionClosedOK

    class _DyingWebSocket(_FakeWebSocket):
        async def send(self, data):
            raise ConnectionClosedOK(None, None)

    bridge, *_ = _make_bridge()
    bridge._ws = _DyingWebSocket()
    # Must NOT raise out of the fire-and-forget dispatch path.
    await bridge.send_text("hello")


async def test_connect_flushes_stale_queue(monkeypatch):
    import services.gemini_bridge as gb

    monkeypatch.setattr(config, "GEMINI_API_KEY", "k")
    bridge, *_ = _make_bridge()
    bridge.enqueue_audio(b"stale-1")
    bridge.enqueue_audio(b"stale-2")
    bridge.enqueue_video(b"stale-jpeg")
    assert bridge._send_queue.qsize() == 3

    fresh = _FakeWebSocket()

    async def fake_connect(uri, **kwargs):
        return fresh

    monkeypatch.setattr(gb.websockets, "connect", fake_connect)
    await bridge._connect()
    assert bridge._send_queue.qsize() == 0          # stale media never replays
    assert "setup" in fresh.sent[0]                 # setup still goes out


async def test_send_pinned_to_replaced_socket_is_dropped():
    bridge, *_ = _make_bridge()
    old_ws = _FakeWebSocket()
    new_ws = _FakeWebSocket()
    bridge._ws = new_ws  # session was replaced while the caller held old_ws
    await bridge._send({"toolResponse": {}}, ws=old_ws)
    assert old_ws.sent == [] and new_ws.sent == []  # neither socket written


# ===========================================================================
# 12g. toolCallCancellation actually cancels the in-flight lookup (wave-2 #2)
# ===========================================================================
async def test_tool_call_cancellation_cancels_inflight():
    import asyncio

    started = asyncio.Event()
    blocker = asyncio.Event()

    async def slow_dispatch(name, args):
        started.set()
        await blocker.wait()  # simulates a long NotebookLM lookup
        return "too late"

    bridge, *_ = _make_bridge(slow_dispatch)
    await bridge._dispatch(
        {"toolCall": {"functionCalls": [
            {"id": "c-9", "name": "query_technical_manual", "args": {"query": "q"}}
        ]}}
    )
    await started.wait()  # the lookup is genuinely in flight
    assert "c-9" in bridge._inflight_by_id

    await bridge._dispatch({"toolCallCancellation": {"ids": ["c-9"]}})
    await _gather(bridge._inflight_tools)  # cancelled task settles
    assert bridge._ws.sent == []           # no toolResponse for a revoked id
    assert "c-9" not in bridge._inflight_by_id  # registry cleaned by done-callback


async def test_tool_call_cancellation_unknown_id_is_noop():
    bridge, *_ = _make_bridge()
    # Must not raise, must not touch anything.
    await bridge._dispatch({"toolCallCancellation": {"ids": ["never-issued"]}})
    await bridge._dispatch({"toolCallCancellation": {"ids": None}})
    await bridge._dispatch({"toolCallCancellation": "malformed"})


async def test_uncancelled_tool_call_still_responds():
    bridge, *_ = _make_bridge()
    await bridge._dispatch(
        {"toolCall": {"functionCalls": [
            {"id": "keep", "name": "query_technical_manual", "args": {"query": "q"}}
        ]}}
    )
    await _gather(bridge._inflight_tools)
    fr = bridge._ws.sent[0]["toolResponse"]["functionResponses"][0]
    assert fr["id"] == "keep"              # normal path unaffected
    assert bridge._inflight_by_id == {}    # registry cleaned after completion


# ===========================================================================
# 12h. Confirmed-defect pair: frame cap from config + activity refcount
# ===========================================================================
async def test_client_frame_cap_tracks_config(monkeypatch):
    import asyncio

    session, pc = _new_peer_session()
    try:
        assert session._MAX_CLIENT_FRAME == 6 * config.USER_TEXT_MAX_CHARS + 1024
        dc = _FakeEventChannel()
        session.attach_data_channel(dc)
        sent: list[str] = []

        async def fake_send_text(text):
            sent.append(text)

        monkeypatch.setattr(session.bridge, "send_text", fake_send_text)
        # A near-cap valid message passes (it would have been silently dropped
        # by the old hardcoded 9216-char frame cap).
        big = "x" * 1900
        dc.handlers["message"](json.dumps({"type": "user_text", "text": big}))
        await asyncio.sleep(0)
        assert sent == [big]
    finally:
        await pc.close()


async def test_overlapping_lookups_keep_indicator_until_last(monkeypatch):
    import asyncio

    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        release_a = asyncio.Event()
        release_b = asyncio.Event()
        gates = [release_a, release_b]

        async def staged_fetch(query):
            gate = gates.pop(0)
            await gate.wait()
            return "answer"

        monkeypatch.setattr(knowledge, "fetch_technical_guidance", staged_fetch)
        task_a = asyncio.create_task(
            session._dispatch_tool("query_technical_manual", {"query": "a"})
        )
        await asyncio.sleep(0)
        task_b = asyncio.create_task(
            session._dispatch_tool("query_technical_manual", {"query": "b"})
        )
        await asyncio.sleep(0)
        release_a.set()           # lookup A finishes while B is still running
        await task_a
        states = [e["state"] for e in dc.sent if e.get("type") == "activity"]
        assert states == ["lookup"]  # NO premature idle while B is in flight
        release_b.set()
        await task_b
        states = [e["state"] for e in dc.sent if e.get("type") == "activity"]
        assert states == ["lookup", "idle"]  # idle exactly once, at the true end
    finally:
        await pc.close()


# ===========================================================================
# 12i. inputAudioTranscription — the technician's side of the record
# ===========================================================================
async def test_setup_includes_input_transcription(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_INPUT_TRANSCRIPTION", True)
    bridge, *_ = _make_bridge()
    assert bridge._build_setup_message()["setup"]["inputAudioTranscription"] == {}
    monkeypatch.setattr(config, "GEMINI_INPUT_TRANSCRIPTION", False)
    assert "inputAudioTranscription" not in bridge._build_setup_message()["setup"]


async def test_input_transcription_fires_callback_and_tolerates_malformed():
    got: list[str] = []
    bridge = GeminiBridge(
        on_audio_out=lambda b: None,
        tool_dispatch=_noop_dispatch,
        on_input_transcript=got.append,
    )
    bridge._handle_server_content({"inputTranscription": {"text": "check the M8 "}})
    bridge._handle_server_content({"inputTranscription": {"text": "torque"}})
    # malformed variants must not raise
    bridge._handle_server_content({"inputTranscription": None})
    bridge._handle_server_content({"inputTranscription": "str"})
    bridge._handle_server_content({"inputTranscription": {"text": 7}})
    assert got == ["check the M8 ", "torque"]


async def test_input_transcript_forwarded_as_user_role():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        session._on_input_transcript("is this the right valve")
        assert dc.sent[0] == {
            "type": "transcript",
            "role": "user",
            "text": "is this the right valve",
        }
    finally:
        await pc.close()


# ===========================================================================
# 12j. GeminiAudioTrack playout path — the AI's voice (wave-2 #7)
# ===========================================================================
def _pcm24k(num_samples: int, value: int = 1000) -> bytes:
    """num_samples of constant-value 24 kHz mono PCM16."""
    import numpy as np

    return np.full(num_samples, value, dtype="<i2").tobytes()


def test_push_resamples_24k_to_48k():
    from services.webrtc_tracks import GeminiAudioTrack

    track = GeminiAudioTrack()
    track.push_pcm24k(_pcm24k(4800))  # 200ms at 24 kHz
    # 24k -> 48k doubles the sample count: expect ~9600 samples = ~19200 bytes
    # (PyAV's resampler may hold a few samples of internal state — 10% slack).
    expected = 4800 * 2 * 2
    assert abs(len(track._buffer) - expected) <= expected * 0.1


async def test_recv_frame_shape_and_pts_progression():
    import fractions
    from services.webrtc_tracks import (
        GeminiAudioTrack, SAMPLES_PER_FRAME, OUTPUT_RATE,
    )

    track = GeminiAudioTrack()
    track.push_pcm24k(_pcm24k(2400))  # 100ms of audio
    f1 = await track.recv()
    f2 = await track.recv()
    assert f1.sample_rate == OUTPUT_RATE
    assert f1.samples == SAMPLES_PER_FRAME            # exactly 20ms per frame
    assert f1.time_base == fractions.Fraction(1, OUTPUT_RATE)
    assert f1.pts == 0
    assert f2.pts == SAMPLES_PER_FRAME                # contiguous pts, no gaps


async def test_recv_emits_silence_when_buffer_empty():
    import numpy as np
    from services.webrtc_tracks import GeminiAudioTrack, SAMPLES_PER_FRAME

    track = GeminiAudioTrack()
    frame = await track.recv()                        # nothing pushed
    arr = frame.to_ndarray()
    assert arr.shape[-1] == SAMPLES_PER_FRAME
    assert not arr.any()                              # pure silence, no raise


async def test_partial_buffer_padded_with_silence():
    import numpy as np
    from services.webrtc_tracks import GeminiAudioTrack, SAMPLES_PER_FRAME

    track = GeminiAudioTrack()
    track._buffer += _pcm24k(100, value=500)          # inject 100 48k-samples directly
    frame = await track.recv()
    arr = frame.to_ndarray().ravel()
    assert arr.shape[0] == SAMPLES_PER_FRAME
    assert arr[:100].all() and not arr[100:].any()    # data first, silence after
    assert len(track._buffer) == 0


def test_buffer_cap_drops_oldest_keeps_newest():
    from services.webrtc_tracks import GeminiAudioTrack, MAX_BUFFER_BYTES

    track = GeminiAudioTrack()
    track.push_pcm24k(_pcm24k(24000 * 11, value=1000))  # ~11s -> ~22s at 48k... half the cap
    track.push_pcm24k(_pcm24k(24000 * 11, value=2000))  # overflow the 20s cap
    assert len(track._buffer) <= MAX_BUFFER_BYTES        # bounded
    # The cap drops the OLDEST audio: the tail must be the newest (value 2000).
    tail = int.from_bytes(bytes(track._buffer[-2:]), "little", signed=True)
    assert tail == 2000


async def test_clear_supports_barge_in():
    from services.webrtc_tracks import GeminiAudioTrack

    track = GeminiAudioTrack()
    track.push_pcm24k(_pcm24k(4800, value=3000))
    track.clear()                                     # user spoke over the model
    frame = await track.recv()
    assert not frame.to_ndarray().any()               # queued speech is GONE


async def test_clear_resets_resampler_no_carryover():
    """After a barge-in clear(), the interrupted (loud) turn must NOT bleed into
    the resampled output of the next turn. The resampler keeps internal filter
    state across calls, so clear() must rebuild it — otherwise the first chunk of
    the next reply carries an audible click from the interrupted turn."""
    import numpy as np
    from services.webrtc_tracks import GeminiAudioTrack

    track = GeminiAudioTrack()
    track.push_pcm24k(_pcm24k(4800, value=3000))      # a LOUD turn
    track.clear()                                     # barge-in: drop it + reset resampler
    assert len(track._buffer) == 0
    track.push_pcm24k(_pcm24k(4800, value=0))         # the next turn is SILENT
    # The newly-resampled silent turn must be (near) pure silence — no high-
    # amplitude tail from the interrupted turn. On the unfixed code this carried
    # samples up to ~3402; with the resampler reset it is ~0.
    tail = np.frombuffer(bytes(track._buffer), dtype="<i2")
    assert tail.size > 0
    assert int(np.max(np.abs(tail))) <= 1             # no carryover click


async def test_recv_paces_at_real_time():
    import time as _time
    from services.webrtc_tracks import GeminiAudioTrack

    track = GeminiAudioTrack()
    await track.recv()                                # anchors the clock
    t0 = _time.monotonic()
    await track.recv()                                # must wait ~20ms
    elapsed = _time.monotonic() - t0
    assert elapsed >= 0.010                           # paced, not a burst
    assert elapsed < 0.5                              # and not stalled


async def test_recv_reanchors_after_stall_instead_of_bursting():
    import time as _time
    from services.webrtc_tracks import GeminiAudioTrack

    track = GeminiAudioTrack()
    await track.recv()
    track._next_time = _time.monotonic() - 1.0        # simulate a 1s event-loop stall
    await track.recv()                                # returns immediately...
    # ...and re-anchors near "now" instead of scheduling a catch-up burst.
    assert track._next_time is not None
    assert abs(track._next_time - _time.monotonic()) < 0.25


async def test_recv_raises_after_stop():
    from aiortc.mediastreams import MediaStreamError
    from services.webrtc_tracks import GeminiAudioTrack

    track = GeminiAudioTrack()
    track.stop()
    with pytest.raises(MediaStreamError):
        await track.recv()


# ===========================================================================
# 12k. Session lifecycle bounds — idle + max-duration reaper (wave-2 #8)
# ===========================================================================
async def _run_reaper_once(session, monkeypatch):
    import asyncio

    monkeypatch.setattr(type(session), "_REAPER_INTERVAL", 0.01)
    task = asyncio.create_task(session._reaper())
    for _ in range(50):  # give it a few intervals to fire
        await asyncio.sleep(0.02)
        if task.done():
            break
    if not task.done():
        task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    # let the spawned _cleanup task settle
    await asyncio.sleep(0.05)


async def test_reaper_ends_idle_session(monkeypatch):
    import time as _time

    monkeypatch.setattr(config, "SESSION_IDLE_SECONDS", 0.05)
    monkeypatch.setattr(config, "SESSION_MAX_SECONDS", 0)
    session, pc = _new_peer_session()
    dc = _FakeDataChannel()
    session.attach_data_channel(dc)
    session._last_media = _time.monotonic() - 10  # silent for "10s"
    await _run_reaper_once(session, monkeypatch)
    ended = [e for e in dc.sent if e.get("type") == "status" and e.get("state") == "ended"]
    assert ended and ended[0]["reason"] == "idle"
    assert session._closed  # actually cleaned up, slot released


async def test_reaper_ends_overlong_session(monkeypatch):
    import time as _time

    monkeypatch.setattr(config, "SESSION_IDLE_SECONDS", 0)
    monkeypatch.setattr(config, "SESSION_MAX_SECONDS", 0.05)
    session, pc = _new_peer_session()
    dc = _FakeDataChannel()
    session.attach_data_channel(dc)
    session._started = _time.monotonic() - 100
    await _run_reaper_once(session, monkeypatch)
    ended = [e for e in dc.sent if e.get("type") == "status" and e.get("state") == "ended"]
    assert ended and ended[0]["reason"] == "max_duration"
    assert session._closed


async def test_reaper_spares_active_session(monkeypatch):
    import time as _time

    monkeypatch.setattr(config, "SESSION_IDLE_SECONDS", 60.0)
    monkeypatch.setattr(config, "SESSION_MAX_SECONDS", 3600.0)
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        session._last_media = _time.monotonic()  # media flowing right now
        import asyncio

        monkeypatch.setattr(type(session), "_REAPER_INTERVAL", 0.01)
        task = asyncio.create_task(session._reaper())
        await asyncio.sleep(0.1)  # several intervals pass...
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert not session._closed                 # ...and the session survives
        assert all(e.get("state") != "ended" for e in dc.sent)
    finally:
        await pc.close()


# ===========================================================================
# 12l. Wave-2 sweep fixes — regression pins
# ===========================================================================
async def test_malformed_toolcall_frame_is_ignored():
    bridge, *_ = _make_bridge()
    # None of these may spawn a task that would die with AttributeError.
    await bridge._dispatch({"toolCall": None})
    await bridge._dispatch({"toolCall": "junk"})
    await bridge._dispatch({"toolCall": {}})
    await bridge._dispatch({"toolCall": {"functionCalls": []}})
    assert bridge._inflight_tools == set()
    assert bridge._ws.sent == []


async def test_send_reports_pin_drop():
    bridge, *_ = _make_bridge()
    old_ws = _FakeWebSocket()
    bridge._ws = _FakeWebSocket()  # session replaced
    assert await bridge._send({"x": 1}, ws=old_ws) is False  # truthfully dropped
    assert await bridge._send({"x": 1}) is True              # current socket OK


async def test_typed_text_counts_as_session_activity(monkeypatch):
    import asyncio
    import time as _time

    session, pc = _new_peer_session()
    try:
        dc = _FakeEventChannel()
        session.attach_data_channel(dc)

        async def fake_send_text(text):
            pass

        monkeypatch.setattr(session.bridge, "send_text", fake_send_text)
        session._last_media = _time.monotonic() - 1000  # would be idle-reaped
        dc.handlers["message"](json.dumps({"type": "user_text", "text": "still here"}))
        await asyncio.sleep(0)
        assert _time.monotonic() - session._last_media < 5  # refreshed by typing
    finally:
        await pc.close()


# ===========================================================================
# 12m. Language selection + knowledge failure-tier matrix (wave-4 #3 + #4)
# ===========================================================================
async def test_setup_language_code_opt_in(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_LANGUAGE_CODE", "")
    bridge, *_ = _make_bridge()
    sc = bridge._build_setup_message()["setup"]["generationConfig"]["speechConfig"]
    assert "languageCode" not in sc  # default: byte-identical to verified frame
    monkeypatch.setattr(config, "GEMINI_LANGUAGE_CODE", "de-DE")
    sc = bridge._build_setup_message()["setup"]["generationConfig"]["speechConfig"]
    assert sc["languageCode"] == "de-DE"
    assert sc["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"]  # voice intact


def _tier_cases():
    import notebooklm as nb

    return [
        ("ratelimit", lambda: nb.RateLimitError("slow down"), "rate-limited"),
        ("notfound", lambda: nb.NotebookNotFoundError("gone"), "could not be found"),
        ("auth", lambda: nb.AuthError("expired"), "authenticate"),
        ("storage", lambda: FileNotFoundError("no storage_state"), "no stored session"),
        ("rpc", lambda: nb.RPCError("boom"), "had an error"),
        ("domain", lambda: nb.ChatError("post-ask failed"), "unreachable"),
        ("generic", lambda: ValueError("odd"), "lookup failed"),
    ]


@pytest.mark.parametrize("tier,exc_factory,phrase", _tier_cases())
async def test_failure_tier_returns_tailored_message(monkeypatch, tier, exc_factory, phrase):
    class _RaisingChat:
        async def ask(self, notebook_id, question, **kwargs):
            raise exc_factory()

    class _RaisingClient:
        def __init__(self):
            self.chat = _RaisingChat()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class _Factory:
        def from_storage(self, *a, **k):
            return _RaisingClient()

    _configure_nb(monkeypatch, _Factory())
    out = await knowledge.fetch_technical_guidance("q")
    assert out and phrase in out.lower(), (tier, out)


async def test_failure_falls_back_to_local_index_when_ready(monkeypatch):
    import notebooklm as nb

    class _RaisingChat:
        async def ask(self, notebook_id, question, **kwargs):
            raise nb.RateLimitError("throttled")

    class _RaisingClient:
        def __init__(self):
            self.chat = _RaisingChat()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class _Factory:
        def from_storage(self, *a, **k):
            return _RaisingClient()

    _configure_nb(monkeypatch, _Factory())
    monkeypatch.setattr(config, "NOTEBOOKLM_LOCAL_FALLBACK", True)
    # Build the L3 index directly — the live lookup failing must yield verbatim
    # manual passages instead of the apology.
    knowledge._bm25.build(
        [("s1", "Manual", "The M8 head bolts torque to 25 newton metres in a star pattern.")],
        max_chunks=100,
    )
    out = await knowledge.fetch_technical_guidance("M8 head bolt torque")
    assert "DIRECT EXCERPTS" in out
    assert "25 newton metres" in out


# ===========================================================================
# 12n. Runtime notebook switching (wave-5 #1)
# ===========================================================================
class _FakeNB:
    def __init__(self, nb_id, title):
        self.id = nb_id
        self.title = title


class _FakeNotebooksClient:
    """Warm-client stand-in exposing .notebooks.list()."""

    def __init__(self, entries):
        class _API:
            async def list(_self):
                return entries

        self.notebooks = _API()


def test_notebooks_endpoint_lists_and_marks_active(monkeypatch):
    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "nb-2")
    monkeypatch.setattr(
        knowledge,
        "_warm_client",
        _FakeNotebooksClient([_FakeNB("nb-1", "Pump XR-200"), _FakeNB("nb-2", "Press B")]),
    )
    body = _client().get("/notebooks").json()
    assert body["active"] == "nb-2"
    flags = {n["id"]: n["active"] for n in body["notebooks"]}
    assert flags == {"nb-1": False, "nb-2": True}


def test_notebooks_endpoint_auth_gated(monkeypatch):
    monkeypatch.setattr(config, "API_AUTH_TOKEN", "secret")
    assert _client().get("/notebooks").status_code == 401


def test_switch_refused_while_sessions_active(monkeypatch):
    import main

    main._sessions.add(object())  # any live session blocks the swap
    try:
        resp = _client().post("/notebooks/switch", json={"id": "nb-9"})
        assert resp.status_code == 409
    finally:
        main._sessions.clear()


def test_switch_validates_body():
    c = _client()
    assert c.post("/notebooks/switch", json={}).status_code == 400
    assert c.post("/notebooks/switch", json={"id": 7}).status_code == 400
    assert c.post("/notebooks/switch", json={"id": "   "}).status_code == 400


async def test_switch_updates_active_and_resets_caches(monkeypatch):
    factory = _FakeClientFactory(
        _FakeAskResult("Answer one [1].", [_FakeRef(1, "x", "s1")])
    )
    _configure_nb(monkeypatch, factory, notebook="nb-old")
    await knowledge.fetch_technical_guidance("same question?")
    assert factory.open_count == 1
    await knowledge.switch_notebook("nb-new")
    assert config.ACTIVE_NOTEBOOK_ID == "nb-new"
    # The L1 cache was reset AND the new notebook id is what gets queried.
    await knowledge.fetch_technical_guidance("same question?")
    assert factory.open_count == 2  # cache miss -> re-fetched
    assert factory.last.chat.calls[-1][0] == "nb-new"


# ===========================================================================
# 12o. PWA installability — manifest + icons served (wave-5 #2)
# ===========================================================================
def test_pwa_manifest_served_and_valid():
    c = _client()
    resp = c.get("/static/manifest.webmanifest")
    assert resp.status_code == 200
    m = json.loads(resp.content)
    assert m["display"] == "standalone"
    assert m["start_url"] == "/" and m["scope"] == "/"
    sizes = {i["sizes"] for i in m["icons"]}
    assert {"192x192", "512x512"} <= sizes
    for icon in m["icons"]:
        r = c.get(icon["src"])
        assert r.status_code == 200, icon["src"]
        assert r.content[:8] == b"\x89PNG\r\n\x1a\n"  # real PNGs, not placeholders


def test_index_links_manifest():
    html = _client().get("/").text
    assert 'rel="manifest"' in html
    assert "/static/manifest.webmanifest" in html
    assert 'name="theme-color"' in html


# ===========================================================================
# 12p. Session log ids + graceful shutdown drain (wave-5 #4+#5)
# ===========================================================================
async def test_sessions_get_unique_ids_and_scoped_loggers():
    s1, pc1 = _new_peer_session()
    s2, pc2 = _new_peer_session()
    try:
        assert s1.sid != s2.sid                      # ids unique
        # Adapter (not getChild — children are retained forever by the logging
        # module): every message gets the greppable [s<id>] prefix.
        msg1, _ = s1._log.process("hello", {})
        msg2, _ = s2._log.process("hello", {})
        assert f"[s{s1.sid}]" in msg1
        assert f"[s{s2.sid}]" in msg2 and msg1 != msg2
    finally:
        await pc1.close()
        await pc2.close()


def test_offer_rejected_while_shutting_down(monkeypatch):
    import main

    monkeypatch.setattr(main, "_shutting_down", True)
    resp = _client().post("/offer", json={"sdp": "x", "type": "offer"})
    assert resp.status_code == 503


def test_ready_reports_shutdown(monkeypatch):
    import main

    monkeypatch.setattr(config, "GEMINI_API_KEY", "k")
    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "nb")
    monkeypatch.setattr(main, "_shutting_down", True)
    resp = _client().get("/ready")
    assert resp.status_code == 503
    assert any("shutting down" in p.lower() for p in resp.json()["problems"])


# ===========================================================================
# 12q. Permanent AI loss notifies the client before teardown (wave-6 #1)
# ===========================================================================
async def test_gemini_session_end_sends_ai_lost_then_cleans_up():
    import asyncio

    session, pc = _new_peer_session()
    dc = _FakeDataChannel()
    session.attach_data_channel(dc)
    session._on_gemini_session_end()
    # The explanation reaches the client BEFORE teardown (flush window).
    ended = [e for e in dc.sent if e.get("type") == "status" and e.get("state") == "ended"]
    assert ended and ended[0]["reason"] == "ai_lost"
    await asyncio.sleep(0.3)  # the delayed cleanup task runs
    assert session._closed


# ===========================================================================
# 13. Production hardening — auth, rate limit, session cap, body size, ops
# ===========================================================================
def test_ready_endpoint(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "k")
    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "nb")
    resp = _client().get("/ready")
    assert resp.status_code == 200
    assert resp.json()["ready"] is True


def test_ready_endpoint_503_when_unconfigured(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "")
    resp = _client().get("/ready")
    assert resp.status_code == 503
    assert resp.json()["ready"] is False


def test_ice_config_includes_stun():
    body = _client().get("/ice-config").json()
    urls = " ".join(str(s.get("urls", "")) for s in body["iceServers"])
    assert "stun:" in urls


def test_ice_config_includes_turn_when_set(monkeypatch):
    monkeypatch.setattr(config, "TURN_URL", "turn:turn.example.com:3478")
    monkeypatch.setattr(config, "TURN_USERNAME", "u")
    monkeypatch.setattr(config, "TURN_CREDENTIAL", "p")
    servers = _client().get("/ice-config").json()["iceServers"]
    turn = [s for s in servers if "turn:" in str(s.get("urls", ""))]
    assert turn and turn[0]["username"] == "u" and turn[0]["credential"] == "p"


def test_ice_config_multi_transport_turn(monkeypatch):
    # A comma-separated TURN_URL (UDP + TCP + TLS) must surface as one server
    # whose `urls` is the full list, so the browser can fall back to TLS:443.
    monkeypatch.setattr(
        config,
        "TURN_URL",
        "turn:h:80,turn:h:443,turns:h:443?transport=tcp",
    )
    monkeypatch.setattr(config, "TURN_USERNAME", "u")
    monkeypatch.setattr(config, "TURN_CREDENTIAL", "p")
    servers = _client().get("/ice-config").json()["iceServers"]
    turn = [s for s in servers if "turn" in str(s.get("urls", ""))]
    assert turn, "no TURN server emitted"
    urls = turn[0]["urls"]
    assert isinstance(urls, list) and len(urls) == 3
    assert any(u.startswith("turns:") for u in urls)  # TLS:443 fallback present
    assert turn[0]["username"] == "u" and turn[0]["credential"] == "p"


def test_ice_config_requires_auth_when_token_set(monkeypatch):
    # TURN credentials must NOT be harvestable by unauthenticated callers.
    monkeypatch.setattr(config, "API_AUTH_TOKEN", "secret")
    monkeypatch.setattr(config, "TURN_URL", "turn:turn.example.com:3478")
    monkeypatch.setattr(config, "TURN_USERNAME", "u")
    monkeypatch.setattr(config, "TURN_CREDENTIAL", "p")
    c = _client()
    assert c.get("/ice-config").status_code == 401  # no key -> no credentials
    ok = c.get("/ice-config", headers={"X-API-Key": "secret"})
    assert ok.status_code == 200
    turn = [s for s in ok.json()["iceServers"] if "turn:" in str(s.get("urls", ""))]
    assert turn and turn[0]["credential"] == "p"  # authed caller still gets TURN


def test_materialize_notebook_storage_writes_injected_cookies(monkeypatch, tmp_path):
    # Headless NotebookLM auth: the exported storage_state JSON in an env var is
    # written to disk so the client can use it without a browser.
    dest = tmp_path / "nb" / "storage_state.json"
    monkeypatch.setattr(config, "NOTEBOOKLM_STORAGE", str(dest))
    monkeypatch.setenv("NOTEBOOKLM_STORAGE_STATE_JSON", '{"cookies":[],"origins":[]}')
    out = config._materialize_notebook_storage()
    assert out == str(dest)
    assert dest.read_text(encoding="utf-8") == '{"cookies":[],"origins":[]}'


def test_materialize_notebook_storage_noop_without_env(monkeypatch):
    monkeypatch.delenv("NOTEBOOKLM_STORAGE_STATE_JSON", raising=False)
    assert config._materialize_notebook_storage() == ""


def test_session_cap_returns_429(monkeypatch):
    monkeypatch.setattr(config, "MAX_SESSIONS", 0)
    # Valid-shaped body so it passes validation and reaches the (relocated,
    # TOCTOU-safe) capacity gate, which returns 429 before creating the pc.
    resp = _client().post("/offer", json={"sdp": "x", "type": "offer"})
    assert resp.status_code == 429


def test_rate_limit_returns_429(monkeypatch):
    import main

    monkeypatch.setattr(config, "RATE_LIMIT_PER_MIN", 1)
    main._rate_buckets.clear()
    c = _client()
    c.post("/offer", json={})  # 1st: under the limit (then 400 on the empty body)
    second = c.post("/offer", json={})  # 2nd: rate-limited
    assert second.status_code == 429
    main._rate_buckets.clear()


def test_auth_required_when_token_set(monkeypatch):
    monkeypatch.setattr(config, "API_AUTH_TOKEN", "secret")
    c = _client()
    assert c.post("/offer", json={}).status_code == 401  # no token -> rejected
    # correct token passes auth (then 400 on the empty body — NOT 401).
    assert c.post("/offer", json={}, headers={"X-API-Key": "secret"}).status_code == 400


def test_body_too_large_returns_413(monkeypatch):
    monkeypatch.setattr(config, "MAX_OFFER_BYTES", 10)
    resp = _client().post("/offer", json={"sdp": "xxxxxxxxxxxxxxxx"})
    assert resp.status_code == 413


# ===========================================================================
# 14. Gemini reconnect + session resumption
# ===========================================================================
async def test_setup_enables_session_resumption(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_SESSION_RESUMPTION", True)
    bridge, *_ = _make_bridge()
    setup = bridge._build_setup_message()["setup"]
    assert setup.get("sessionResumption") == {}  # empty on first connect


async def test_session_resumption_handle_captured_and_reused(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_SESSION_RESUMPTION", True)
    bridge, *_ = _make_bridge()
    await bridge._dispatch({"sessionResumptionUpdate": {"resumable": True, "newHandle": "H123"}})
    assert bridge._resume_handle == "H123"
    setup = bridge._build_setup_message()["setup"]
    assert setup["sessionResumption"] == {"handle": "H123"}  # reused on reconnect


async def test_reconnected_fires_only_on_second_setupcomplete():
    fired = []
    bridge = GeminiBridge(
        on_audio_out=lambda b: None,
        tool_dispatch=_noop_dispatch,
        on_reconnected=lambda: fired.append(True),
    )
    await bridge._dispatch({"setupComplete": {}})  # first connect -> not a reconnect
    assert fired == []
    await bridge._dispatch({"setupComplete": {}})  # second -> reconnect
    assert fired == [True]


async def test_goaway_does_not_raise():
    bridge, *_ = _make_bridge()
    # goAway is informational; the supervisor reconnects on actual socket close.
    await bridge._dispatch({"goAway": {"timeLeft": "5s"}})  # must not raise


async def test_supervisor_gives_up_after_max_reconnects(monkeypatch):
    # Drive the real _supervise loop with a _connect that always fails, and
    # assert it exhausts the retry budget exactly once -> on_session_end + _dead,
    # firing on_reconnecting per retry.
    monkeypatch.setattr(config, "GEMINI_RECONNECT", True)
    monkeypatch.setattr(config, "GEMINI_MAX_RECONNECTS", 2)
    monkeypatch.setattr(config, "GEMINI_RECONNECT_BACKOFF", 0.0)
    ended: list = []
    reconnecting: list = []
    bridge = GeminiBridge(
        on_audio_out=lambda b: None,
        tool_dispatch=_noop_dispatch,
        on_session_end=lambda: ended.append(True),
        on_reconnecting=lambda: reconnecting.append(True),
    )

    async def _always_fail():
        raise RuntimeError("connect failed")

    monkeypatch.setattr(bridge, "_connect", _always_fail)
    await bridge._supervise()
    assert ended == [True]            # gave up exactly once
    assert bridge._dead is True
    assert len(reconnecting) == 2     # attempts 1 and 2 retried; attempt 3 > max -> give up


async def test_toolresponse_discarded_after_ws_replaced():
    # If the session is replaced (reconnect) while a tool lookup is in flight, the
    # stale toolResponse (old call_id) must NOT be sent onto the new socket.
    old_ws = _FakeWebSocket()
    new_ws = _FakeWebSocket()

    async def swap_then_answer(name, args):
        # Simulate a reconnect happening during the RAG lookup.
        bridge._ws = new_ws
        return "answer"

    bridge = GeminiBridge(on_audio_out=lambda b: None, tool_dispatch=swap_then_answer)
    bridge._ws = old_ws
    await bridge._handle_tool_call(
        {"functionCalls": [{"id": "c1", "name": "query_technical_manual", "args": {"query": "q"}}]}
    )
    assert old_ws.sent == []  # old socket gone
    assert new_ws.sent == []  # and NOT misrouted to the new session


# ===========================================================================
# 15. Warm-client lifecycle (Step 1 speed) + annotate finite-box guard
# ===========================================================================
class _RecordingCtx:
    def __init__(self, events, fail=False):
        self._events = events
        self._fail = fail

    async def __aenter__(self):
        if self._fail:
            raise RuntimeError("auth failed")
        self._events.append("enter")
        return "WARM_CLIENT"

    async def __aexit__(self, *exc):
        self._events.append("exit")
        return False


def _configure_warm(monkeypatch):
    monkeypatch.setattr(config, "NOTEBOOKLM_WARM_CLIENT", True)
    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "nb")
    monkeypatch.setattr(config, "NOTEBOOKLM_PREWARM", False)  # no prewarm task / network
    monkeypatch.setattr(config, "NOTEBOOKLM_STORAGE", "")
    monkeypatch.setattr(config, "NOTEBOOKLM_PROFILE", "")
    monkeypatch.setattr(knowledge, "_warm_client", None)
    monkeypatch.setattr(knowledge, "_warm_ctx", None)


async def test_warm_client_startup_then_shutdown(monkeypatch):
    events: list = []

    class _Factory:
        def from_storage(self, *a, **k):
            return _RecordingCtx(events)

    _configure_warm(monkeypatch)
    monkeypatch.setattr(knowledge, "NotebookLMClient", _Factory())

    await knowledge.startup()
    assert knowledge._warm_client == "WARM_CLIENT"
    assert events == ["enter"]
    await knowledge.shutdown()
    assert events == ["enter", "exit"]
    assert knowledge._warm_client is None and knowledge._warm_ctx is None


async def test_warm_client_startup_failure_falls_back_to_per_call(monkeypatch):
    class _Factory:
        def from_storage(self, *a, **k):
            return _RecordingCtx([], fail=True)

    _configure_warm(monkeypatch)
    monkeypatch.setattr(knowledge, "NotebookLMClient", _Factory())

    await knowledge.startup()  # __aenter__ raises -> must NOT propagate
    assert knowledge._warm_client is None  # fell back to per-call clients
    await knowledge.shutdown()  # idempotent, no raise


async def test_annotate_rejects_non_finite_box():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool(
            "annotate_component", {"label": "gauge", "box": [float("nan"), 0, 100, 100]}
        )
        assert "malformed" in ack.lower()
        assert dc.sent == []  # never serialized invalid JSON to the client
    finally:
        await pc.close()


# ===========================================================================
# 16. v2 Speed L2/L3 — retrieval primitives
# ===========================================================================
def test_tokenize_keeps_technical_tokens_drops_stopwords():
    toks = retrieval.tokenize("What is the torque spec for the M8 head bolts on the XR-200?")
    assert "m8" in toks and "xr" in toks and "200" in toks  # codes/numbers survive
    assert "the" not in toks and "is" not in toks            # stopwords dropped
    assert "a" not in toks                                   # single alpha dropped


def test_tokenize_handles_non_ascii_manuals():
    # Cyrillic, accented Latin, and CJK must survive (localized service manuals).
    assert retrieval.tokenize("момент затяжки") == ["момент", "затяжки"]
    assert "für" in retrieval.tokenize("Drehmoment für M8")
    assert "dynamométrique" in retrieval.tokenize("clé dynamométrique à 25 Nm")
    # a non-ASCII source now indexes to a searchable chunk (was 0 before the fix)
    idx = retrieval.Bm25Index()
    n = idx.build([("s", "t", "момент затяжки болта 25")], max_chunks=100)
    assert n >= 1 and idx.ready
    assert idx.search("момент болта", k=1)


def test_bm25_round_robin_covers_all_sources_under_cap():
    # A big first source must not starve a later one when the cap bites.
    big = " ".join(f"alpha{i}" for i in range(2000))
    idx = retrieval.Bm25Index()
    idx.build([("A", "Big", big), ("B", "Small", "unique_zeta_term torque value")], max_chunks=4)
    assert idx.size == 4
    hits = idx.search("unique_zeta_term", k=1)
    assert hits and "unique_zeta_term" in hits[0][1].text  # source B still searchable


def test_cosine_identical_and_orthogonal():
    a = retrieval._counts(retrieval.tokenize("M8 head bolt torque spec"))
    assert retrieval.cosine(a, a) == pytest.approx(1.0)
    b = retrieval._counts(retrieval.tokenize("error code reset procedure"))
    assert retrieval.cosine(a, b) == 0.0  # no shared tokens


def test_chunk_text_overlaps_and_covers():
    words = " ".join(f"w{i}" for i in range(500))
    chunks = retrieval.chunk_text(words, max_words=180, overlap=40)
    assert len(chunks) >= 3
    assert chunks[0].split()[0] == "w0"
    assert chunks[-1].split()[-1] == "w499"   # last word is covered
    # consecutive chunks overlap (step = max_words - overlap = 140)
    assert chunks[1].split()[0] == "w140"


def test_bm25_ranks_relevant_chunk_first():
    idx = retrieval.Bm25Index()
    idx.build(
        [
            ("s1", "Manual", "The M8 head bolts on the XR-200 pump torque to 25 N m star pattern."),
            ("s2", "Manual", "Error code E-45 means low oil pressure; reset by holding 5 seconds."),
        ],
        max_chunks=2000,
    )
    assert idx.ready and idx.size >= 2
    hits = idx.search("how do I clear error code E-45", k=2)
    assert hits and "E-45" in hits[0][1].text          # the oil-pressure chunk wins
    assert hits[0][0] > 0.0


def test_similarity_cache_hits_paraphrase_misses_other():
    sc = retrieval.SimilarityCache(maxsize=8, ttl=300, threshold=0.82)
    sc.put("what is the torque spec for the M8 head bolts", "TORQUE-ANSWER")
    assert sc.get("the torque spec for the M8 head bolts, what is it") == "TORQUE-ANSWER"
    assert sc.get("how do I clear error code E-45") is None   # different question
    sc.clear()
    assert sc.get("the torque spec for the M8 head bolts, what is it") is None


def test_similarity_cache_disabled_when_maxsize_zero():
    sc = retrieval.SimilarityCache(maxsize=0, ttl=300, threshold=0.8)
    sc.put("q", "a")
    assert not sc.enabled and sc.get("q") is None


# ===========================================================================
# 17. v2 Speed L2/L3 — tiered lookup wiring in fetch_technical_guidance
# ===========================================================================
async def test_l2_similarity_serves_paraphrase_without_refetch(monkeypatch):
    factory = _FakeClientFactory(
        _FakeAskResult("The M8 head bolts torque to 25 N·m [1].", [_FakeRef(1, "25 N·m", "s1")])
    )
    _configure_nb(monkeypatch, factory)
    a = await knowledge.fetch_technical_guidance("What is the torque spec for the M8 head bolts?")
    # A strong paraphrase of the SAME question is served from L2 (no new client).
    b = await knowledge.fetch_technical_guidance("the M8 head bolts torque spec, what is it?")
    assert a == b
    assert factory.open_count == 1  # second query never reached NotebookLM


async def test_l3_fast_path_answers_locally_when_confident(monkeypatch):
    factory = _FakeClientFactory(_FakeAskResult("unused", []))
    _configure_nb(monkeypatch, factory)
    monkeypatch.setattr(config, "NOTEBOOKLM_LOCAL_FAST_PATH", True)
    monkeypatch.setattr(config, "NOTEBOOKLM_LOCAL_FAST_PATH_MIN_SCORE", 0.1)
    knowledge._bm25.build(
        [("s1", "Service Manual", "The M8 head bolts on the XR-200 pump torque to 25 N m.")],
        max_chunks=2000,
    )
    out = await knowledge.fetch_technical_guidance("M8 head bolt torque on the XR-200")
    assert "DIRECT EXCERPTS" in out and "25 N" in out
    assert factory.open_count == 0  # NotebookLM was skipped entirely


async def test_l3_local_fallback_on_rpc_error(monkeypatch):
    factory = _FakeClientFactory(_FakeAskResult("unused", []))
    _configure_nb(monkeypatch, factory)
    monkeypatch.setattr(config, "NOTEBOOKLM_LOCAL_FALLBACK", True)
    knowledge._bm25.build(
        [("s1", "Service Manual", "The M8 head bolts on the XR-200 pump torque to 25 N m.")],
        max_chunks=2000,
    )

    async def boom(_q):
        raise knowledge.RPCError("backend down")

    monkeypatch.setattr(knowledge, "_run", boom)
    out = await knowledge.fetch_technical_guidance("torque for the M8 head bolts")
    assert "DIRECT EXCERPTS" in out and "25 N" in out  # grounded passage, not an apology


async def test_error_without_local_index_returns_apology(monkeypatch):
    factory = _FakeClientFactory(_FakeAskResult("unused", []))
    _configure_nb(monkeypatch, factory)  # clear_cache() leaves the L3 index empty
    monkeypatch.setattr(config, "NOTEBOOKLM_LOCAL_FALLBACK", True)

    async def boom(_q):
        raise knowledge.RPCError("backend down")

    monkeypatch.setattr(knowledge, "_run", boom)
    out = await knowledge.fetch_technical_guidance("torque for the M8 head bolts")
    assert "DIRECT EXCERPTS" not in out
    assert "error" in out.lower() or "cannot" in out.lower()  # graceful apology


async def test_build_local_index_from_warm_client(monkeypatch):
    class _Sources:
        async def list(self, notebook_id, **kw):
            return [
                type("S", (), {"id": "s1", "title": "Manual A"})(),
                type("S", (), {"id": "s2", "title": "Manual B"})(),
            ]

        async def get_fulltext(self, notebook_id, source_id, **kw):
            text = {
                "s1": "The M8 head bolts torque to 25 N m on the XR-200 pump.",
                "s2": "Error E-45 means low oil pressure; reset by holding 5 seconds.",
            }[source_id]
            return type("FT", (), {"source_id": source_id, "title": "T", "content": text})()

    class _WarmClient:
        sources = _Sources()

    monkeypatch.setattr(config, "NOTEBOOKLM_LOCAL_INDEX", True)
    monkeypatch.setattr(config, "ACTIVE_NOTEBOOK_ID", "nb")
    monkeypatch.setattr(knowledge, "_warm_client", _WarmClient())
    knowledge._index_built = False
    knowledge._bm25.clear()

    await knowledge.build_local_index()
    assert knowledge._bm25.ready and knowledge._index_built
    hits = knowledge._bm25.search("E-45 oil pressure", k=1)
    assert hits and "E-45" in hits[0][1].text


# ===========================================================================
# 18. Observability — metrics wiring + /metrics endpoint
# ===========================================================================
def test_metrics_endpoint_exposes_prometheus_text():
    body = _client().get("/metrics")
    assert body.status_code == 200
    assert "text/plain" in body.headers["content-type"]
    assert "sessions_active" in body.text  # the read-time gauge is always present


def test_metrics_counts_offer_rejections(monkeypatch):
    monkeypatch.setattr(config, "MAX_SESSIONS", 0)
    c = _client()
    c.post("/offer", json={"sdp": "x", "type": "offer"})  # -> 429 at_capacity
    text = c.get("/metrics").text
    assert 'offer_rejected_total{reason="at_capacity"}' in text
    assert "offer_requests_total" in text


async def test_query_tool_increments_toolcall_metric(monkeypatch):
    factory = _FakeClientFactory(_FakeAskResult("Answer [1].", [_FakeRef(1, "x", "s1")]))
    _configure_nb(monkeypatch, factory)
    session, pc = _new_peer_session()
    try:
        await session._dispatch_tool("query_technical_manual", {"query": "M8 torque?"})
        assert metrics.snapshot()["counters"].get('toolcalls_total{tool="query"}') == 1
        # the lookup also recorded an L4 outcome + latency timer
        assert metrics.snapshot()["counters"].get('nb_query_result_total{tier="l4"}') == 1
    finally:
        await pc.close()


# ===========================================================================
# 19. show_model / clear_model — AI-composed 3D/2D explanatory diagrams
# ===========================================================================
def test_tool_declarations_include_show_and_clear_model():
    names = [d["name"] for d in config.TOOL_DECLARATIONS]
    assert "show_model" in names and "clear_model" in names
    show = next(d for d in config.TOOL_DECLARATIONS if d["name"] == "show_model")
    props = show["parameters"]["properties"]
    assert props["mode"]["enum"] == list(config.MODEL_MODES)
    assert show["parameters"]["required"] == ["mode", "title", "parts"]
    # parts is an array of objects with a shape field.
    assert props["parts"]["type"] == "ARRAY"
    assert "shape" in props["parts"]["items"]["properties"]


async def test_setup_advertises_model_tools():
    bridge, *_ = _make_bridge()
    decls = bridge._build_setup_message()["setup"]["tools"][0]["functionDeclarations"]
    names = [d["name"] for d in decls]
    assert "show_model" in names and "clear_model" in names


async def test_show_model_3d_dispatch_sends_sanitized_event():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool(
            "show_model",
            {
                "mode": "3d",
                "title": "T" * 200,  # over the 80-char cap
                "caption": "How the pump head stacks up",
                "parts": [
                    {"shape": "box", "position": [0, 0, 0], "size": [1, 1, 1],
                     "color": "metal", "label": "housing"},
                    {"shape": "arrow", "position": [0, float("inf"), 0],  # inf -> default
                     "color": "neon", "label": "flow"},                   # bad color -> info
                    {"shape": "bogus"},   # invalid shape -> dropped
                    "junk",                # non-dict -> dropped
                ],
            },
        )
        assert len(dc.sent) == 1
        ev = dc.sent[0]
        assert ev["type"] == "model"
        assert ev["mode"] == "3d"
        assert len(ev["title"]) == 80                 # clamped
        assert len(ev["parts"]) == 2                  # two bad parts dropped
        box, arrow = ev["parts"]
        assert box["shape"] == "box" and box["color"] == "metal"
        assert arrow["shape"] == "arrow"
        assert arrow["color"] == "info"               # 'neon' rejected
        assert arrow["position"] == [0.0, 0.0, 0.0]   # inf coerced to default
        assert all(len(p["position"]) == 3 for p in ev["parts"])  # 3D = 3-vectors
        assert "3D" in ack and "T" * 10 in ack
    finally:
        await pc.close()


async def test_show_model_part_note_sanitized_and_only_emitted_when_present():
    """A part `note` is trimmed + length-capped, and only emitted when non-empty
    (so old-style parts stay byte-identical and the event carries no noise)."""
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {
                "mode": "3d",
                "title": "Pump",
                "parts": [
                    {"shape": "box", "label": "housing", "note": "  cast aluminium body  "},
                    {"shape": "cylinder", "label": "shaft", "note": "X" * 300},  # over cap
                    {"shape": "sphere", "label": "ball", "note": "   "},          # blank -> dropped
                    {"shape": "cone", "label": "tip"},                            # absent stays absent
                ],
            },
        )
        housing, shaft, ball, tip = dc.sent[0]["parts"]
        assert housing["note"] == "cast aluminium body"        # trimmed
        assert len(shaft["note"]) == config.MODEL_NOTE_MAX      # clamped to MODEL_NOTE_MAX
        assert "note" not in ball                               # whitespace-only -> dropped
        assert "note" not in tip                                # no key -> stays absent
    finally:
        await pc.close()


async def test_show_model_note_non_string_coerced_or_dropped():
    """A non-string note never crashes: a number stringifies, None/blank drop out."""
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {
                "mode": "2d",
                "title": "x",
                "parts": [
                    {"shape": "rect", "label": "a", "note": 123},
                    {"shape": "rect", "label": "b", "note": None},
                ],
            },
        )
        a, b = dc.sent[0]["parts"]
        assert a["note"] == "123"        # str() coercion, non-empty -> kept
        assert "note" not in b           # None -> "" -> dropped
    finally:
        await pc.close()


def test_show_model_description_demands_detail():
    """Guard the composition guidance: show_model must keep pushing for detailed,
    labelled, exploded, colour-disciplined diagrams (it must not silently regress
    to the thin original), and each part must declare the `note` property."""
    show = next(d for d in config.TOOL_DECLARATIONS if d["name"] == "show_model")
    desc = show["description"].lower()
    for token in ("label", "note", "proportion", "explod", "colour", "step"):
        assert token in desc, f"show_model guidance lost '{token}'"
    props = show["parameters"]["properties"]["parts"]["items"]["properties"]
    assert "note" in props, "the `note` part-property is no longer declared"
    assert "dashed" in props, "the `dashed` part-property is no longer declared"
    assert "material" in props, "the `material` part-property is no longer declared"
    assert "opacity" in props, "the `opacity` part-property is no longer declared"
    assert "animate" in props, "the `animate` part-property is no longer declared"
    assert "spec" in props, "the `spec` part-property is no longer declared"
    assert "warning" in props, "the `warning` part-property is no longer declared"


def test_system_instruction_has_rich_diagram_exemplar():
    """The system prompt must keep a concrete worked example that teaches the
    model to COMBINE the rich diagram vocabulary (few-shot beats enumeration) —
    a regression guard so the guidance can't quietly fall back to bare boxes."""
    si = config.SYSTEM_INSTRUCTION.lower()
    for token in (
        "material", "opacity", "explod", "swing", "pivot",
        "spec", "warning", "dimension", "dashed", "note",
    ):
        assert token in si, f"system instruction lost the diagram-exemplar token '{token}'"


def test_show_model_declares_assetid():
    show = next(d for d in config.TOOL_DECLARATIONS if d["name"] == "show_model")
    assert "assetId" in show["parameters"]["properties"]


def test_show_model_asset_hint_lists_configured_models(monkeypatch):
    """The assetId help lists configured models so the AI can pick one; with an
    empty catalog (default) it omits the 'Available' list."""
    monkeypatch.setattr(config, "MODEL_ASSETS", {"pumpx": {"url": "/a/p.glb", "title": "Pump X"}})
    hint = config._show_model_asset_hint()
    assert "pumpx" in hint and "Pump X" in hint and "Available" in hint
    monkeypatch.setattr(config, "MODEL_ASSETS", {})
    assert "Available" not in config._show_model_asset_hint()


def test_sample_glb_is_a_valid_glb():
    """The bundled sample model is a structurally-valid binary glTF (used as the
    working MODEL_ASSETS_JSON example and validated end-to-end in a browser)."""
    import struct
    from pathlib import Path

    p = Path(__file__).resolve().parent.parent / "web" / "public" / "sample-assets" / "box.glb"
    blob = p.read_bytes()
    magic, version, total = struct.unpack("<III", blob[:12])
    assert magic == 0x46546C67, "not a glTF (bad magic)"
    assert version == 2, "expected glTF 2.0"
    assert total == len(blob), "GLB header length mismatch"
    json_len, json_type = struct.unpack("<II", blob[12:20])
    assert json_type == 0x4E4F534A, "first chunk must be JSON"
    assert b'"version":"2.0"' in blob[20 : 20 + json_len]


def test_load_model_assets_drops_malformed(monkeypatch):
    """The catalog loader keeps only well-formed entries (string key, dict value,
    STRING non-empty url) and degrades malformed JSON / empty env to {}."""
    monkeypatch.setenv(
        "MODEL_ASSETS_JSON",
        '{"ok":{"url":"/a.glb","title":"A"},"badurl":{"url":true},"nodict":"x","nourl":{"title":"t"}}',
    )
    assert config._load_model_assets() == {"ok": {"url": "/a.glb", "title": "A"}}
    monkeypatch.setenv("MODEL_ASSETS_JSON", "not json at all")
    assert config._load_model_assets() == {}
    monkeypatch.delenv("MODEL_ASSETS_JSON", raising=False)
    assert config._load_model_assets() == {}


async def test_show_model_assetid_resolved_from_catalog(monkeypatch):
    """A configured assetId (3D) resolves to {url,title}; an unknown id, an empty
    catalog, and 2D mode all omit `asset` so the diagram falls back to primitives."""
    monkeypatch.setattr(config, "MODEL_ASSETS", {"pumpx": {"url": "/assets/pumpx.glb", "title": "Pump X"}})
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model", {"mode": "3d", "title": "t", "parts": [{"shape": "box"}], "assetId": "pumpx"}
        )
        assert dc.sent[-1]["asset"] == {"url": "/assets/pumpx.glb", "title": "Pump X"}
        await session._dispatch_tool(
            "show_model", {"mode": "3d", "title": "t", "parts": [{"shape": "box"}], "assetId": "nope"}
        )
        assert "asset" not in dc.sent[-1]                       # unknown id dropped
        await session._dispatch_tool(
            "show_model", {"mode": "2d", "title": "t", "parts": [{"shape": "rect"}], "assetId": "pumpx"}
        )
        assert "asset" not in dc.sent[-1]                       # 2D ignores assetId
    finally:
        await pc.close()


async def test_show_model_2d_dimension_shape_and_dashed_flag():
    """The 2D `dimension` shape is accepted; `dashed` is emitted only when truthy
    (a real bool or the string 'true'), and otherwise stays absent."""
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {
                "mode": "2d",
                "title": "Clearance",
                "parts": [
                    {"shape": "dimension", "position": [10, 10], "size": [40, 0], "label": "25 mm"},
                    {"shape": "rect", "label": "cover", "dashed": True},
                    {"shape": "rect", "label": "frame", "dashed": "true"},
                    {"shape": "rect", "label": "solid"},                    # no dashed key
                    {"shape": "rect", "label": "notdash", "dashed": "yes"},  # garbage -> not dashed
                ],
            },
        )
        dim, cover, frame, solid, notdash = dc.sent[0]["parts"]
        assert dim["shape"] == "dimension"
        assert len(dim["position"]) == 2 and len(dim["size"]) == 2  # 2D vectors
        assert cover["dashed"] is True
        assert frame["dashed"] is True          # "true" accepted
        assert "dashed" not in solid            # absent stays absent
        assert "dashed" not in notdash          # "yes" rejected
    finally:
        await pc.close()


async def test_show_model_3d_rejects_dimension_shape():
    """`dimension` is 2D-only — in 3D mode it's an unknown shape and dropped."""
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {"mode": "3d", "title": "x", "parts": [{"shape": "dimension"}, {"shape": "box"}]},
        )
        parts = dc.sent[0]["parts"]
        assert len(parts) == 1 and parts[0]["shape"] == "box"  # only the box survives
    finally:
        await pc.close()


async def test_show_model_3d_material_and_opacity():
    """3D `material` forwarded only for a known preset; `opacity` clamped to
    [MIN, 1) and emitted only when actually see-through."""
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {
                "mode": "3d",
                "title": "Pump",
                "parts": [
                    {"shape": "box", "label": "housing", "material": "glass", "opacity": 0.3},
                    {"shape": "cylinder", "label": "shaft", "material": "metal"},
                    {"shape": "sphere", "label": "bad", "material": "unobtanium"},  # invalid -> dropped
                    {"shape": "cone", "label": "tip", "opacity": 5},                # >1 -> solid, omitted
                    {"shape": "box", "label": "tiny", "opacity": 0.0001},           # < MIN -> clamped up
                    {"shape": "box", "label": "solid"},                             # neither
                ],
            },
        )
        housing, shaft, bad, tip, tiny, solid = dc.sent[0]["parts"]
        assert housing["material"] == "glass" and housing["opacity"] == 0.3
        assert shaft["material"] == "metal" and "opacity" not in shaft
        assert "material" not in bad                          # invalid preset dropped
        assert "opacity" not in tip                           # >1 -> solid, omitted
        assert tiny["opacity"] == config.MODEL_OPACITY_MIN    # clamped up to the floor
        assert "material" not in solid and "opacity" not in solid
    finally:
        await pc.close()


async def test_show_model_3d_animate_sanitized():
    """A part `animate` is forwarded only with a known type; axis defaults to 'y';
    speed is clamped; an unknown type drops the whole descriptor."""
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {
                "mode": "3d",
                "title": "Scissors",
                "parts": [
                    {"shape": "box", "label": "blade",
                     "animate": {"type": "swing", "axis": "z", "amount": 35, "speed": 1.5,
                                 "pivot": [0, -1, 0]}},
                    {"shape": "box", "label": "fast",
                     "animate": {"type": "spin", "speed": 99}},      # speed clamped to MAX
                    {"shape": "box", "label": "weird",
                     "animate": {"type": "wobble"}},                 # unknown type -> dropped
                    {"shape": "box", "label": "badaxis",
                     "animate": {"type": "slide", "axis": "q"}},     # bad axis -> default y
                    {"shape": "box", "label": "pulsepiv",
                     "animate": {"type": "pulse", "amount": 0.3, "pivot": [1, 0, 0]}},  # pivot dropped
                    {"shape": "box", "label": "still"},              # no animate
                ],
            },
        )
        blade, fast, weird, badaxis, pulsepiv, still = dc.sent[0]["parts"]
        assert blade["animate"] == {
            "type": "swing", "axis": "z", "amount": 35.0, "speed": 1.5, "pivot": [0.0, -1.0, 0.0],
        }
        assert fast["animate"]["type"] == "spin"
        assert fast["animate"]["speed"] == config.MODEL_ANIM_SPEED_MAX  # clamped
        assert "animate" not in weird                  # unknown type -> no descriptor
        assert badaxis["animate"]["axis"] == "y"       # bad axis -> default
        # pivot is rotation-only: a pulse keeps amount but drops the pivot.
        assert pulsepiv["animate"]["amount"] == 0.3
        assert "pivot" not in pulsepiv["animate"]
        assert "animate" not in still
    finally:
        await pc.close()


async def test_show_model_part_spec_and_warning():
    """A part `spec` becomes a capped list of clean {label,value} rows (rows with
    a blank label/value or non-dict items dropped; label/value clamped); a
    `warning` is trimmed + capped. Both emitted only when present."""
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {
                "mode": "3d",
                "title": "Pump",
                "parts": [
                    {"shape": "box", "label": "bolt", "warning": "  Hot surface  ",
                     "spec": [
                         {"label": "Torque", "value": "25 Nm"},
                         {"label": "  ", "value": "x"},          # blank label -> dropped
                         {"label": "Size", "value": ""},          # blank value -> dropped
                         "junk",                                   # non-dict -> dropped
                         {"label": "L" * 99, "value": "V" * 99},   # clamped
                     ]},
                    {"shape": "box", "label": "plain"},           # neither
                ],
            },
        )
        bolt, plain = dc.sent[0]["parts"]
        assert bolt["warning"] == "Hot surface"                   # trimmed
        assert [r["label"] for r in bolt["spec"]] == ["Torque", "L" * config.MODEL_SPEC_LABEL_MAX]
        assert len(bolt["spec"]) == 2                             # two bad rows dropped
        assert len(bolt["spec"][1]["value"]) == config.MODEL_SPEC_VALUE_MAX  # clamped
        assert "spec" not in plain and "warning" not in plain
    finally:
        await pc.close()


async def test_show_model_2d_uses_two_vectors():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {
                "mode": "2d",
                "title": "Wiring",
                "parts": [
                    {"shape": "rect", "position": [10, 20], "size": [30, 15], "label": "relay"},
                    {"shape": "arrow", "position": [0, 0], "size": [40, 0], "color": "danger"},
                    {"shape": "box", "position": [1, 1]},  # 3D-only shape -> dropped in 2D
                ],
            },
        )
        ev = dc.sent[0]
        assert ev["mode"] == "2d"
        assert len(ev["parts"]) == 2                  # the 'box' is invalid in 2D
        assert all(len(p["position"]) == 2 for p in ev["parts"])
        assert all(len(p["rotation"]) == 1 for p in ev["parts"])
    finally:
        await pc.close()


async def test_show_model_empty_parts_acks_without_event():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool(
            "show_model", {"mode": "3d", "title": "Nope", "parts": [{"shape": "bogus"}]}
        )
        assert dc.sent == []                          # nothing pushed to the client
        assert "no valid shapes" in ack.lower()
    finally:
        await pc.close()


async def test_show_model_bad_mode_defaults_to_3d():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {"mode": "hologram", "title": "x", "parts": [{"shape": "sphere"}]},
        )
        assert dc.sent[0]["mode"] == "3d"             # unknown mode -> 3d
    finally:
        await pc.close()


async def test_show_model_caps_parts_at_max():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        many = [{"shape": "box"} for _ in range(config.MODEL_MAX_PARTS + 25)]
        await session._dispatch_tool("show_model", {"mode": "3d", "title": "big", "parts": many})
        assert len(dc.sent[0]["parts"]) == config.MODEL_MAX_PARTS
    finally:
        await pc.close()


async def test_show_model_without_channel_acks_gracefully():
    session, pc = _new_peer_session()
    try:
        ack = await session._dispatch_tool(
            "show_model", {"mode": "3d", "title": "x", "parts": [{"shape": "box"}]}
        )
        assert "voice" in ack.lower()                 # fallback guidance, no raise
    finally:
        await pc.close()


async def test_clear_model_dispatch_sends_event_and_acks():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool("clear_model", {})
        assert dc.sent == [{"type": "model_clear"}]
        assert "hid" in ack.lower()
    finally:
        await pc.close()


async def test_show_model_increments_toolcall_and_shown_metrics():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        before = metrics.snapshot()["counters"].get('models_shown_total{mode="3d"}', 0)
        await session._dispatch_tool(
            "show_model", {"mode": "3d", "title": "x", "parts": [{"shape": "box"}]}
        )
        after = metrics.snapshot()["counters"].get('models_shown_total{mode="3d"}', 0)
        assert after == before + 1
        assert metrics.snapshot()["counters"].get('toolcalls_total{tool="show_model"}', 0) >= 1
    finally:
        await pc.close()


# ---- AR-anchored diagram (show_model 2d `anchor`) --------------------------
def test_show_model_declaration_includes_anchor():
    show = next(d for d in config.TOOL_DECLARATIONS if d["name"] == "show_model")
    props = show["parameters"]["properties"]
    assert "anchor" in props
    assert props["anchor"]["properties"]["box"]["items"]["type"] == "NUMBER"


async def test_show_model_2d_anchor_forwarded():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool(
            "show_model",
            {"mode": "2d", "title": "Wiring", "parts": [{"shape": "rect"}],
             "anchor": {"box": [100, 200, 400, 600]}},
        )
        assert dc.sent[0]["anchor"] == {"box": [100.0, 200.0, 400.0, 600.0]}
        assert "pinned" in ack.lower()
    finally:
        await pc.close()


async def test_show_model_anchor_dropped_when_3d():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {"mode": "3d", "title": "x", "parts": [{"shape": "box"}],
             "anchor": {"box": [100, 200, 400, 600]}},
        )
        assert "anchor" not in dc.sent[0]  # 3D is never anchored
    finally:
        await pc.close()


async def test_show_model_anchor_sanitizes_bad_box():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        for bad in (
            {"box": [float("inf"), 0, 100, 100]},   # non-finite
            {"box": [1, 2, 3]},                       # wrong length
            {"box": "nope"},                          # non-list
            {"box": [400, 600, 100, 200]},            # inverted (ymax<ymin, xmax<xmin)
            {"box": [-50, 1200, 2000, -10]},          # clamps to degenerate -> dropped
            "notadict",
        ):
            dc.sent.clear()
            await session._dispatch_tool(
                "show_model",
                {"mode": "2d", "title": "x", "parts": [{"shape": "rect"}], "anchor": bad},
            )
            assert "anchor" not in dc.sent[0]  # dropped, but the diagram still sends
            assert dc.sent[0]["type"] == "model"
    finally:
        await pc.close()


# ===========================================================================
# 20. highlight_model_part — emphasize parts of the already-shown diagram
# ===========================================================================
def test_tool_declarations_include_highlight_model():
    names = [d["name"] for d in config.TOOL_DECLARATIONS]
    assert "highlight_model_part" in names
    hl = next(d for d in config.TOOL_DECLARATIONS if d["name"] == "highlight_model_part")
    assert hl["parameters"]["required"] == ["labels"]
    labels = hl["parameters"]["properties"]["labels"]
    assert labels["type"] == "ARRAY"
    assert labels["items"]["type"] == "STRING"


async def test_setup_advertises_highlight_tool():
    bridge, *_ = _make_bridge()
    decls = bridge._build_setup_message()["setup"]["tools"][0]["functionDeclarations"]
    assert "highlight_model_part" in [d["name"] for d in decls]


async def test_highlight_model_dispatch_sends_sanitized_event():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool(
            "highlight_model_part",
            {"labels": ["  Gasket  ", 42, "", "M8 bolt", "gasket"]},  # trim, drop non-str/empty, de-dup
        )
        assert dc.sent == [{"type": "model_emphasis", "labels": ["Gasket", "M8 bolt"]}]
        assert "Emphasized 2" in ack
    finally:
        await pc.close()


async def test_highlight_model_empty_list_clears():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        ack = await session._dispatch_tool("highlight_model_part", {"labels": []})
        assert dc.sent == [{"type": "model_emphasis", "labels": []}]
        assert "cleared" in ack.lower()
    finally:
        await pc.close()


async def test_highlight_model_non_list_labels_clears_gracefully():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool("highlight_model_part", {"labels": "gasket"})
        await session._dispatch_tool("highlight_model_part", {})  # missing entirely
        assert dc.sent == [
            {"type": "model_emphasis", "labels": []},
            {"type": "model_emphasis", "labels": []},
        ]
    finally:
        await pc.close()


async def test_highlight_model_caps_labels_at_max():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        many = [f"p{i}" for i in range(config.MODEL_MAX_PARTS + 25)]
        await session._dispatch_tool("highlight_model_part", {"labels": many})
        assert len(dc.sent[0]["labels"]) == config.MODEL_MAX_PARTS
    finally:
        await pc.close()


async def test_highlight_model_without_channel_acks_gracefully():
    session, pc = _new_peer_session()
    try:
        ack = await session._dispatch_tool("highlight_model_part", {"labels": ["x"]})
        assert "no display channel" in ack.lower()  # graceful, no raise
    finally:
        await pc.close()


async def test_highlight_model_increments_metrics():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        before = metrics.snapshot()["counters"].get("models_emphasized_total", 0)
        await session._dispatch_tool("highlight_model_part", {"labels": ["a"]})
        after = metrics.snapshot()["counters"].get("models_emphasized_total", 0)
        assert after == before + 1
        assert metrics.snapshot()["counters"].get('toolcalls_total{tool="highlight_model"}', 0) >= 1
    finally:
        await pc.close()


# ---- step-by-step playback (set_diagram_step + per-part step) --------------
def test_tool_declarations_include_set_diagram_step():
    names = [d["name"] for d in config.TOOL_DECLARATIONS]
    assert "set_diagram_step" in names
    decl = next(d for d in config.TOOL_DECLARATIONS if d["name"] == "set_diagram_step")
    assert decl["parameters"]["required"] == ["step"]
    show = next(d for d in config.TOOL_DECLARATIONS if d["name"] == "show_model")
    assert "step" in show["parameters"]["properties"]["parts"]["items"]["properties"]


async def test_show_model_sanitizes_part_step():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        await session._dispatch_tool(
            "show_model",
            {
                "mode": "3d",
                "title": "Assembly",
                "parts": [
                    {"shape": "box", "label": "base"},            # no step
                    {"shape": "box", "label": "a", "step": 1},    # valid
                    {"shape": "box", "label": "b", "step": 2.0},  # float -> 2
                    {"shape": "box", "label": "c", "step": 0},    # 0 -> omit
                    {"shape": "box", "label": "d", "step": "x"},  # garbage -> omit
                ],
            },
        )
        parts = dc.sent[0]["parts"]
        steps = {p["label"]: p.get("step") for p in parts}
        assert steps == {"base": None, "a": 1, "b": 2, "c": None, "d": None}
    finally:
        await pc.close()


async def test_set_diagram_step_dispatch_sends_clamped_event():
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)
        before = metrics.snapshot()["counters"].get("model_steps_total", 0)
        ack = await session._dispatch_tool("set_diagram_step", {"step": 2})
        assert dc.sent == [{"type": "model_step", "step": 2}]
        assert "step 2" in ack.lower()
        # 0 = show all; garbage/over-cap clamp to bounds.
        dc.sent.clear()
        await session._dispatch_tool("set_diagram_step", {"step": 0})
        assert dc.sent == [{"type": "model_step", "step": 0}]
        dc.sent.clear()
        await session._dispatch_tool("set_diagram_step", {"step": "nope"})
        assert dc.sent == [{"type": "model_step", "step": 0}]
        dc.sent.clear()
        await session._dispatch_tool("set_diagram_step", {"step": 9999})
        assert dc.sent[0]["step"] == config.MODEL_MAX_PARTS  # clamped
        after = metrics.snapshot()["counters"].get("model_steps_total", 0)
        assert after >= before + 4
    finally:
        await pc.close()


async def test_set_diagram_step_without_channel_acks_gracefully():
    session, pc = _new_peer_session()
    try:
        ack = await session._dispatch_tool("set_diagram_step", {"step": 1})
        assert "no display channel" in ack.lower()  # no raise
    finally:
        await pc.close()


# ===========================================================================
# 21. Manual provenance — source titles surfaced to the technician
# ===========================================================================
def test_extract_source_titles_from_references():
    result = _FakeAskResult(
        "M8 head bolts torque to 25 N·m [1].",
        [
            _FakeRef(1, "snippet a", "s1", title="Pump Service Manual"),
            _FakeRef(2, "snippet b", "s2", title="  Pump Service Manual  "),  # dup (trim)
            _FakeRef(3, "snippet c", "s3", title="Wiring Guide"),
            _FakeRef(4, "snippet d", "s4"),  # no title -> skipped
        ],
    )
    titles = knowledge.extract_source_titles(result)
    assert titles == ["Pump Service Manual", "Wiring Guide"]  # deduped, blanks dropped


def test_extract_source_titles_tolerates_garbage():
    assert knowledge.extract_source_titles(None) == []
    assert knowledge.extract_source_titles(_FakeAskResult("ans", [])) == []
    assert knowledge.extract_source_titles(_FakeAskResult("ans", "notalist")) == []


async def test_last_source_titles_tracks_query(monkeypatch):
    factory = _FakeClientFactory(
        _FakeAskResult(
            "Torque is 25 N·m [1].",
            [_FakeRef(1, "25 N·m", "s1", title="XR-200 Manual")],
        )
    )
    _configure_nb(monkeypatch, factory)
    assert knowledge.last_source_titles("M8 torque?") == []  # nothing queried yet
    await knowledge.fetch_technical_guidance("M8 torque?")
    assert knowledge.last_source_titles("M8 torque?") == ["XR-200 Manual"]
    # Normalized key: a paraphrase of casing/space resolves to the same titles.
    assert knowledge.last_source_titles("  m8   TORQUE? ") == ["XR-200 Manual"]
    knowledge.clear_cache()
    assert knowledge.last_source_titles("M8 torque?") == []  # cleared with the caches


async def test_fetch_string_contract_unchanged_with_titles(monkeypatch):
    """Populating the title side-cache must NOT change the answer string."""
    factory = _FakeClientFactory(
        _FakeAskResult(
            "Error E-45 means motor over-temperature [1].",
            [_FakeRef(1, "Motor over-temperature.", "s9", title="Fault Codes")],
        )
    )
    _configure_nb(monkeypatch, factory)
    out = await knowledge.fetch_technical_guidance("What does E-45 mean?")
    assert "E-45" in out and "motor over-temperature" in out.lower() and "SOURCES" in out


def test_sanitize_source_titles_bounds_and_dedupes():
    import main

    san = main.PeerSession._sanitize_source_titles  # staticmethod — no instance needed
    assert san("notalist") == []
    assert san([1, None, {"x": 1}]) == []  # non-strings dropped
    assert san(["  Manual A  ", "manual a", "B"]) == ["Manual A", "B"]  # trim + dedupe
    assert san(["a", "b", "c", "d", "e"]) == ["a", "b", "c"]  # cap at 3
    assert len(san(["x" * 200])[0]) == 80  # truncate to 80


async def test_query_dispatch_emits_sources_event(monkeypatch):
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)

        async def fake_fetch(query):
            return "Torque: 25 N·m [1]"

        monkeypatch.setattr(knowledge, "fetch_technical_guidance", fake_fetch)
        monkeypatch.setattr(knowledge, "last_source_titles", lambda q: ["Pump Service Manual"])
        out = await session._dispatch_tool("query_technical_manual", {"query": "torque?"})
        assert "25" in out
        sources = [e for e in dc.sent if e.get("type") == "sources"]
        assert sources == [{"type": "sources", "titles": ["Pump Service Manual"]}]
        # The activity bracket is unchanged.
        states = [e["state"] for e in dc.sent if e.get("type") == "activity"]
        assert states == ["lookup", "idle"]
    finally:
        await pc.close()


async def test_query_dispatch_no_titles_no_sources_event(monkeypatch):
    session, pc = _new_peer_session()
    try:
        dc = _FakeDataChannel()
        session.attach_data_channel(dc)

        async def fake_fetch(query):
            return "No grounded answer."

        monkeypatch.setattr(knowledge, "fetch_technical_guidance", fake_fetch)
        monkeypatch.setattr(knowledge, "last_source_titles", lambda q: [])
        await session._dispatch_tool("query_technical_manual", {"query": "q"})
        assert [e for e in dc.sent if e.get("type") == "sources"] == []  # no event
    finally:
        await pc.close()


async def test_provenance_cleared_on_reask_without_grounding(monkeypatch):
    """A re-ask that loses grounding must NOT keep the prior answer's titles."""
    factory = _FakeClientFactory(
        _FakeAskResult("Torque is 25 N·m [1].", [_FakeRef(1, "x", "s1", title="Manual A")])
    )
    _configure_nb(monkeypatch, factory)
    await knowledge.fetch_technical_guidance("M8 torque?")
    assert knowledge.last_source_titles("M8 torque?") == ["Manual A"]
    # Force L4 again (answer caches cleared, titles cache deliberately NOT), this
    # time with NO citations -> the stale 'Manual A' must be popped.
    knowledge._cache.clear()
    knowledge._sim_cache.clear()
    factory._result = _FakeAskResult("Just chatting, no manual citation.", [])
    out = await knowledge.fetch_technical_guidance("M8 torque?")
    assert "chatting" in out
    assert knowledge.last_source_titles("M8 torque?") == []  # not stale


async def test_provenance_expires_with_ttl(monkeypatch):
    """A title entry can't outlive the answer it described (same TTL)."""
    import asyncio

    factory = _FakeClientFactory(
        _FakeAskResult("ans [1].", [_FakeRef(1, "x", "s1", title="Manual A")])
    )
    _configure_nb(monkeypatch, factory)
    monkeypatch.setattr(config, "NOTEBOOKLM_CACHE_TTL_SECONDS", 0.05)
    await knowledge.fetch_technical_guidance("q?")
    assert knowledge.last_source_titles("q?") == ["Manual A"]
    await asyncio.sleep(0.08)
    assert knowledge.last_source_titles("q?") == []  # expired -> absent


async def test_provenance_cleared_on_degraded_fallback(monkeypatch):
    """A degraded apology answer (lookup failed) must clear stale provenance."""
    factory = _FakeClientFactory(
        _FakeAskResult("ans [1].", [_FakeRef(1, "x", "s1", title="Manual A")])
    )
    _configure_nb(monkeypatch, factory)
    await knowledge.fetch_technical_guidance("q?")
    assert knowledge.last_source_titles("q?") == ["Manual A"]
    # Re-ask: L4 fails and no local fallback index -> a pure apology.
    knowledge._cache.clear()
    knowledge._sim_cache.clear()
    monkeypatch.setattr(config, "NOTEBOOKLM_LOCAL_FALLBACK", False)

    async def boom(query):
        raise RuntimeError("manual down")

    monkeypatch.setattr(knowledge, "_run", boom)
    out = await knowledge.fetch_technical_guidance("q?")
    assert out  # non-empty apology
    assert knowledge.last_source_titles("q?") == []  # stale 'Manual A' cleared


# ===========================================================================
# 22. TLS resolution — turnkey HTTPS for LAN / iPad
# ===========================================================================
def test_resolve_ssl_autodetects_certs_dir(tmp_path, monkeypatch):
    """A generated certs/ just works (no SSL_* env wiring) — turnkey LAN HTTPS."""
    import main

    monkeypatch.setattr(config, "SSL_CERTFILE", "")
    monkeypatch.setattr(config, "SSL_KEYFILE", "")
    (tmp_path / "cert.pem").write_text("x")
    (tmp_path / "key.pem").write_text("y")
    monkeypatch.setattr(main, "_DEFAULT_CERT_DIR", tmp_path)
    assert main._resolve_ssl() == (str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"))


def test_resolve_ssl_env_takes_precedence(tmp_path, monkeypatch):
    import main

    envcert = tmp_path / "e.pem"
    envcert.write_text("x")
    envkey = tmp_path / "k.pem"
    envkey.write_text("y")
    (tmp_path / "cert.pem").write_text("a")  # default dir also populated
    (tmp_path / "key.pem").write_text("b")
    monkeypatch.setattr(config, "SSL_CERTFILE", str(envcert))
    monkeypatch.setattr(config, "SSL_KEYFILE", str(envkey))
    monkeypatch.setattr(main, "_DEFAULT_CERT_DIR", tmp_path)
    assert main._resolve_ssl() == (str(envcert), str(envkey))  # env wins


def test_resolve_ssl_none_when_absent(tmp_path, monkeypatch):
    import main

    monkeypatch.setattr(config, "SSL_CERTFILE", "")
    monkeypatch.setattr(config, "SSL_KEYFILE", "")
    monkeypatch.setattr(main, "_DEFAULT_CERT_DIR", tmp_path / "nope")
    assert main._resolve_ssl() == (None, None)  # plain HTTP (localhost only)


# ---------------------------------------------------------------------------
async def _gather(tasks):
    import asyncio

    await asyncio.gather(*list(tasks), return_exceptions=True)
