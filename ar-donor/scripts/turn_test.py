#!/usr/bin/env python3
"""Check whether a set of TURN credentials actually yields a media relay.

A WebRTC session fails with "connection failed" / "PC state: failed" when ICE
can't find a path — almost always because TURN is missing, mis-credentialed, or
the relay is dead/rate-limited (the free public ones often are). This gathers
ICE candidates with the SAME library the server uses (aiortc) and reports how
many `relay` candidates the TURN server produced. relay > 0 = the credentials
work; relay == 0 = they don't (don't bother deploying them).

Usage:
    python scripts/turn_test.py "<turn-urls>" <username> <credential>

  <turn-urls>: one URL or a comma-separated list, e.g.
    "turn:xxx.metered.live:80,turn:xxx.metered.live:443,turns:xxx.metered.live:443?transport=tcp"

Exit code 0 if a relay candidate was gathered, 1 otherwise. aiortc only (a dep).
"""
from __future__ import annotations

import asyncio
import sys

from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection


async def _run(urls: list[str], username: str, credential: str) -> int:
    ice = [RTCIceServer(urls="stun:stun.l.google.com:19302")]
    ice.append(
        RTCIceServer(
            urls=urls if len(urls) > 1 else urls[0],
            username=username or None,
            credential=credential or None,
        )
    )
    pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice))
    pc.createDataChannel("probe")
    await pc.setLocalDescription(await pc.createOffer())  # gathers ICE to completion
    sdp = pc.localDescription.sdp
    host = sum("typ host" in ln for ln in sdp.splitlines())
    srflx = sum("typ srflx" in ln for ln in sdp.splitlines())
    relay = [ln.strip() for ln in sdp.splitlines() if "typ relay" in ln]
    await pc.close()

    print(f"host={host}  srflx(STUN)={srflx}  relay(TURN)={len(relay)}")
    for r in relay[:5]:
        print("   relay:", r[:100])
    if relay:
        print("OK - TURN works (relay candidate gathered). Safe to deploy these creds.")
        return 0
    print("FAIL - no relay candidate. These TURN credentials are not working.")
    return 1


def main() -> int:
    if len(sys.argv) < 4:
        print('usage: python scripts/turn_test.py "<turn-urls>" <username> <credential>')
        return 2
    urls = [u.strip() for u in sys.argv[1].split(",") if u.strip()]
    if not urls:
        print("no TURN urls given")
        return 2
    try:
        return asyncio.run(_run(urls, sys.argv[2], sys.argv[3]))
    except Exception as e:  # noqa: BLE001
        print("error during TURN test:", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
