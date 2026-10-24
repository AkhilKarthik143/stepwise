# Stepwise AR + Voice QA Report

Date: 2026-10-23

## Executive verdict

The active Stepwise field console is demo-ready in mock/local mode. Its backend, frontend build, grounded text command path, AR coordinate math, anchor confirmation flow, safety rejection paths, and browser interaction path passed the executed checks below.

Live voice, live provider calls, physical phone camera testing, real-time tracking accuracy, and WebRTC audio loopback are not claimed as passing. They require credentials, missing optional Python dependencies, or physical hardware that was not available in this run.

## Scope and evidence posture

The active implementation is the Stepwise tree. The retained donor tree remains available for comparison and history. Tests exercised the active backend/frontend code rather than assuming that a build or unit suite proves camera or speech behavior.

Provider/device state observed from `/healthz`:

| Capability | Observed state | Verdict |
| --- | --- | --- |
| Local/mock agent | `agent_provider=mock`, `mock_mode=true` | Tested |
| DashScope realtime | `realtime_configured=false` | Not tested; no key |
| Anthropic Claude | SDK absent and key absent | Not tested; fallback only |
| Cartesia | SDK absent and key absent | Not tested; fallback only |
| Moss | SDK absent and credentials absent | Local fallback tested |
| Physical iOS/Android device | Not connected | Not tested |
| Browser camera | Permission/device unavailable in browser harness | UI fallback observed; physical camera not tested |

## Commands and results

| Command | Result |
| --- | --- |
| `cd stepwise/backend && ../../.venv/bin/python -m pytest -q` | **195 passed**, 1 Starlette/httpx deprecation warning |
| `npm test -- --run` from `stepwise/frontend` | **4 AR tests passed** |
| `npm run typecheck` from `stepwise/frontend` | **Passed** |
| `npm run build` from `stepwise/frontend` | **Passed**; Vite reports a large lazy ModelPanel chunk warning |
| `./.venv/bin/python -m pytest -q tests/ar tests/voice tests/integration` | **10 passed**, 1 Starlette/httpx deprecation warning |
| `python3 -m compileall -q stepwise/backend/app tests` | **Passed** |
| `npm test -- --run`, `npm run typecheck`, `npm run build` in `ar-donor/web` | **121 passed**, typecheck/build passed; donor build reports large chunks |
| `../.venv/bin/python -m pytest -q` in `ar-donor` | **Blocked during collection**: `ModuleNotFoundError: notebooklm` in `tests/test_flow.py` |
| `../.venv/bin/python scripts/test_webrtc_loopback.py` in `ar-donor` | **Blocked before test**: `ModuleNotFoundError: numpy` |

The project-level test command uses the active frontend’s Vitest configuration and the requested repo-level `tests/ar` suite. No live network provider was called.

## AR validation

Passed:

- `coverMap` and `coverInverse` were exercised for exact aspect ratio, horizontal crop, round trips, clamping, and unavailable video metadata.
- Backend boxes are clipped into `normalized_1000`, reject malformed/degenerate boxes, and reject unknown components.
- Camera anchors accept only `user_confirmed`, `aruco`, or `verified_detector` sources. A model guess is rejected.
- The WebSocket integration exercised unknown-anchor rejection and known-component confirmation.
- Browser acceptance exercised “Locate spindle” → pending anchor → tap confirmation → `CONFIRMED · USER TAP`.

Not tested:

- Physical rear-camera rotation/mirroring on iOS or Android.
- ArUco or detector accuracy; neither is active in the Stepwise path.
- Continuous pose tracking, target loss, reacquisition, or a prerecorded field video run.

The actual live UI showed the camera fallback state in the browser harness because no camera device/permission was available. The fallback remained usable and the file-input path was present.

## Voice and agent validation

Passed:

- The deterministic mock path used the real orchestrator/tool runner and emitted grounded catalog sources.
- Text WebSocket flow emitted user transcript, tool event, grounded assistant transcript, provider status, and final listening state.
- Provider adapters fail closed to mock/local behavior when credentials or optional SDKs are absent.
- Safety confirmation tests reject invalid anchors and preserve explicit confirmation semantics.

Defect fixed during this pass:

- `stepwise/backend/app/ws/gateway.py` sliced the user input when emitting assistant delta events. This caused the UI to briefly display the user’s question as assistant text, followed by an empty delta. It now slices `turn.text`, and the integration test asserts that the assistant deltas are non-empty and do not echo the prompt.

Not tested:

- Speech-to-text accuracy, microphone capture, echo cancellation, barge-in audio, generated voice quality, and live Claude/Cartesia output.
- Claude tool-use against Anthropic’s live API.
- Cartesia audio generation or browser PCM playback.

## Voice-to-AR and safety matrix

| Subsystem | Test evidence | Status |
| --- | --- | --- |
| Text intent → grounded tool | Mock WebSocket and browser quick actions | PASS in mock/local mode |
| Tool → AR pending target | “Locate spindle” browser path | PASS |
| Operator tap → confirmed anchor | Browser tap plus backend WebSocket test | PASS |
| Model-only AR claim | `model_guess` rejection test | PASS rejected |
| Safety checklist gate | Existing backend suite plus provider tests | PASS for tested local paths |
| Tracking loss/stale/reacquire | No active detector/tracker to exercise | NOT TESTED / unavailable |
| Live Claude tool loop | Credentials/SDK absent | BLOCKED |
| Live Cartesia voice | Credentials/SDK absent | BLOCKED |
| WebRTC audio loopback | Donor script blocked by missing `numpy` | BLOCKED |
| Phone camera and audio | No physical device session | NOT TESTED |

## Performance and accuracy

Ten TestClient mock text turns were measured from WebSocket send to final `listening` state:

- mean: **0.85 ms**
- p50: **0.82 ms**
- p95: **0.90 ms**
- success: **10/10**

These are local deterministic mock-path measurements only. They are not model, network, speech, camera, or device latency. No AR precision/recall or speech word-error rate was measured because there was no active detector, physical camera capture, or audio corpus in this run.

## Browser acceptance

Executed against `http://127.0.0.1:5173/` with the mock backend on `127.0.0.1:8000`:

1. Page loaded with `STEPWISE AR`, `CONNECTED`, `FIELD VIEW LIVE`, and `MOCK / LOCAL`.
2. “Identify machine” produced the grounded PL45LM response and opened machine evidence.
3. “Locate spindle” produced a pending confirmation affordance.
4. Tapping the affordance rendered the confirmed spindle box and `CONFIRMED · USER TAP`.
5. Browser logs contained only Vite connection/debug messages and the standard React DevTools notice; no runtime errors were observed.

## Required follow-up for a production-grade sign-off

Install the donor WebRTC test dependencies, provide isolated test credentials for each live provider, run the app over HTTPS on a physical iOS/Android device, capture a short approved camera/audio fixture, then measure end-to-end speech latency, audio output, camera overlay stability, and detector/tracker accuracy. Until that run exists, the honest release label is **mock/local demo validated; live AR + voice unvalidated**.
