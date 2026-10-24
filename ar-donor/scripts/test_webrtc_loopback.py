"""
Local WebRTC negotiation loopback test (no browser, no live Gemini key needed).

It stubs GeminiBridge.start (so we don't dial the real Gemini API), then drives
the real /offer logic with an aiortc "browser" that publishes a silent audio
track + a synthetic video track. It asserts:
  * the backend returns a valid SDP answer,
  * the client receives the AI-voice audio track back,
  * the DTLS/ICE connection reaches "connected" (best-effort, time-boxed).

Run:
    python scripts/test_webrtc_loopback.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, ".")

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")  # start() is stubbed

import numpy as np  # noqa: E402
import av  # noqa: E402
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack  # noqa: E402
from aiortc.mediastreams import AudioStreamTrack  # noqa: E402

import services.gemini_bridge as gemini_bridge  # noqa: E402
import main  # noqa: E402


class GreenVideoTrack(VideoStreamTrack):
    """Emits a solid-green 320x240 frame stream (stand-in for the camera)."""

    async def recv(self):
        pts, time_base = await self.next_timestamp()
        img = np.zeros((240, 320, 3), dtype="uint8")
        img[:, :, 1] = 128  # green channel (BGR)
        frame = av.VideoFrame.from_ndarray(img, format="bgr24")
        frame.pts = pts
        frame.time_base = time_base
        return frame


async def _stub_start(self):
    """Pretend the Gemini session is ready without opening a websocket."""
    self._ready.set()


async def main_test() -> int:
    # Stub the Gemini dial-out at the bridge layer.
    gemini_bridge.GeminiBridge.start = _stub_start

    offerer = RTCPeerConnection()
    got_audio = asyncio.Event()

    @offerer.on("track")
    def on_track(track):  # noqa: ANN001
        print(f"  [client] received {track.kind} track from backend", flush=True)
        if track.kind == "audio":
            got_audio.set()

    offerer.addTrack(AudioStreamTrack())   # silent mic
    offerer.addTrack(GreenVideoTrack())    # synthetic camera

    await offerer.setLocalDescription(await offerer.createOffer())
    while offerer.iceGatheringState != "complete":
        await asyncio.sleep(0.05)

    class _FakeClient:
        host = "127.0.0.1"

    class FakeRequest:
        def __init__(self, data):
            self._data = data
            self._body = json.dumps(data).encode("utf-8")
            self.headers = {}            # hardening guards read .headers.get(...)
            self.client = _FakeClient()  # and ._client_ip reads .client.host

        async def stream(self):          # /offer reads the body via request.stream()
            yield self._body

        async def json(self):
            return self._data

    print("Posting offer to backend /offer logic…", flush=True)
    resp = await main.offer(
        FakeRequest({"sdp": offerer.localDescription.sdp, "type": "offer"})
    )
    answer = json.loads(bytes(resp.body))
    assert "sdp" in answer and answer["type"] == "answer", answer
    assert "m=audio" in answer["sdp"], "answer missing audio m-line"
    print("  [client] valid SDP answer received", flush=True)

    await offerer.setRemoteDescription(
        RTCSessionDescription(sdp=answer["sdp"], type=answer["type"])
    )
    await asyncio.wait_for(got_audio.wait(), timeout=5.0)
    print("  [client] AI-voice audio track confirmed", flush=True)

    for _ in range(160):  # up to ~8s
        if offerer.connectionState == "connected":
            break
        await asyncio.sleep(0.05)
    print(f"  connection state: {offerer.connectionState}", flush=True)

    passed = got_audio.is_set() and offerer.connectionState == "connected"
    print("\nWEBRTC LOOPBACK:", "PASS" if passed else "FAIL", flush=True)

    async def _safe_close():
        try:
            await offerer.close()
        except Exception:  # noqa: BLE001
            pass
        for session in list(main._sessions):
            try:
                await main._cleanup(session)
            except Exception:  # noqa: BLE001
                pass

    try:
        await asyncio.wait_for(_safe_close(), timeout=3.0)
    except asyncio.TimeoutError:
        pass
    return 0 if passed else 1


if __name__ == "__main__":
    code = asyncio.run(main_test())
    sys.stdout.flush()
    # aiortc/aioice leave background consent tasks alive; hard-exit cleanly.
    os._exit(code)
