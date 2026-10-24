# STEPWISE AR implementation status

Updated: 2026-10-23

## Works in this workspace

- STEPWISE catalogs, grounded tool handlers, grounding validation, LOTO/procedure state, reports, schematics, CNC model, and existing desktop panels are retained.
- Mobile-first field shell with camera centerpiece, text fallback, captions/transcript, status labels, expandable evidence panels, and safe pending/confirmed annotations.
- Tap-confirm anchor flow using `normalized_1000` boxes and object-fit cover mapping.
- Deterministic mock agent uses the same STEPWISE orchestrator and tool handlers for the five-step demo.
- Claude and Moss adapters are isolated and optional; missing credentials degrade to local/mock behavior.

## Mocked/local

- MockAgent is used when `STEPWISE_PROVIDER=mock` or the Claude key is missing.
- Local knowledge fallback is used when Moss credentials/index are unavailable.
- Cartesia audio is capability-labeled and falls back to the existing text/PCM path; no live Cartesia credentials were supplied for this run.

## Incomplete / not validated

- Live Claude network calls were not made because `ANTHROPIC_API_KEY` is not present.
- Live Cartesia STT/TTS was not made because `CARTESIA_API_KEY` is not present.
- Moss cloud retrieval was not made because project credentials/index are not present.
- Physical phone HTTPS/camera permission testing was not run in this desktop workspace; the browser-served field surface and WebSocket anchor round-trip were validated locally.
- Phone-to-laptop pairing is deferred until the core single-device flow is stable.
- ArUco detection is not implemented in this phase; tap confirmation is the primary validated anchor method. A future verified marker/detector can emit the same `normalized_1000` event contract.

## Original vs new

- Original: STEPWISE data, safety, tools, WebSocket, desktop panels, schematics, model, and tests.
- Ported: donor coordinate mapping/camera/annotation patterns, adapted to React 18.
- New: provider adapters, mock demo runtime, structured annotation events, mobile shell, knowledge-provider interface, and integration docs/tests.
