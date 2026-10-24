"""
Full cognitive-loop live test — NO browser, NO WebRTC.

Drives the REAL production code:
  * services.gemini_bridge.GeminiBridge  (real connect, setup-with-tools,
    downstream() parsing, toolCall interception, toolResponse send, audio out)
  * services.knowledge.fetch_technical_guidance  (real NotebookLM RAG)

The only test-specific substitution is the INPUT: instead of streaming mic
audio, we inject a text user-turn via clientContent. Everything downstream of
that — the model deciding to call query_technical_manual, the bridge dispatching
to NotebookLM, the toolResponse, and the spoken (audio) answer — is the exact
path a real session exercises.

PASS criteria:
  1. setupComplete (the model accepted setup WITH the tool declaration),
  2. the model emitted a toolCall for query_technical_manual,
  3. NotebookLM returned a grounded answer (forwarded as toolResponse),
  4. the model produced audio (PCM) after the toolResponse.

Run:  python scripts/test_live_loop.py
"""
from __future__ import annotations

import asyncio
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, ".")

import config  # noqa: E402
from services import knowledge  # noqa: E402
from services.gemini_bridge import GeminiBridge  # noqa: E402

QUESTION = (
    "I'm servicing the XR-200 pump. What is the exact torque specification for "
    "the M8 pump head bolts, and the tightening pattern? Check the manual."
)


async def main() -> int:
    tool_calls: list[dict] = []
    audio = {"chunks": 0, "bytes": 0}
    tool_done = asyncio.Event()
    audio_seen = asyncio.Event()

    async def tool_dispatch(name: str, args: dict) -> str:
        print(f"  [2] toolCall received  -> {name}({args})", flush=True)
        answer = await knowledge.fetch_technical_guidance(args.get("query", ""))
        tool_calls.append({"name": name, "args": args, "answer": answer})
        print(f"  [3] NotebookLM answered -> {answer[:180]}...", flush=True)
        tool_done.set()
        return answer  # the bridge sends this back to Gemini as toolResponse

    def on_audio(pcm: bytes) -> None:
        audio["chunks"] += 1
        audio["bytes"] += len(pcm)
        if not audio_seen.is_set():
            audio_seen.set()

    bridge = GeminiBridge(
        on_audio_out=on_audio,
        tool_dispatch=tool_dispatch,
        on_interrupt=lambda: None,
        on_text=lambda t: print(f"  [model text] {t.strip()}", flush=True),
    )

    print(f"Model: {config.GEMINI_LIVE_MODEL} @ {config.GEMINI_API_VERSION}")
    print("  [1] connecting + sending setup (with query_technical_manual tool)…", flush=True)
    try:
        await bridge.start()
    except Exception as exc:  # noqa: BLE001
        print(f"  !! setup failed: {type(exc).__name__}: {exc}")
        await bridge.close()
        return 1
    print("  [1] setupComplete OK — model accepted the tool declaration.", flush=True)

    # Inject the question as a complete text turn (clientContent + turnComplete).
    await bridge._send(
        {
            "clientContent": {
                "turns": [{"role": "user", "parts": [{"text": QUESTION}]}],
                "turnComplete": True,
            }
        }
    )
    print(f"  [>] sent question: {QUESTION}", flush=True)

    # Wait for the tool call to complete (NotebookLM round-trip included).
    try:
        await asyncio.wait_for(tool_done.wait(), timeout=120.0)
    except asyncio.TimeoutError:
        print("  !! no toolCall within 120s (model may have answered without the tool)")

    # Wait for the spoken (audio) answer that follows the toolResponse.
    try:
        await asyncio.wait_for(audio_seen.wait(), timeout=45.0)
        await asyncio.sleep(4.0)  # collect a little more of the utterance
    except asyncio.TimeoutError:
        print("  !! no audio received within 45s after toolResponse")

    print(f"  [4] model audio: {audio['chunks']} chunks, {audio['bytes']} bytes "
          f"(~{audio['bytes'] / 2 / config.GEMINI_OUTPUT_SAMPLE_RATE:.1f}s of 24kHz PCM)", flush=True)

    await bridge.close()

    called_tool = any(tc["name"] == config.QUERY_TOOL_NAME for tc in tool_calls)
    grounded = any("25" in (tc["answer"] or "") for tc in tool_calls)  # 25 N·m from the manual
    spoke = audio["bytes"] > 0
    ok = called_tool and grounded and spoke

    print("\n=== FULL COGNITIVE LOOP ===")
    print(f"  setupComplete (tools accepted) : OK")
    print(f"  toolCall query_technical_manual: {'OK' if called_tool else 'MISSING'}")
    print(f"  NotebookLM grounded answer     : {'OK (found 25 N·m)' if grounded else 'NOT GROUNDED'}")
    print(f"  model spoke (audio out)        : {'OK' if spoke else 'MISSING'}")
    print(f"\n  RESULT: {'PASS' if ok else 'PARTIAL'}", flush=True)
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
