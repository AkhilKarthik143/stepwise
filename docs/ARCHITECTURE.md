# STEPWISE AR architecture

## Design read

- Artifact: mobile field copilot with an expandable desktop evidence console.
- Audience: industrial maintenance technicians who need glanceable, source-backed guidance while looking at a machine.
- Visual language: dark instrument panel, safety amber, electric cyan, and green confirmation states.
- Mode: extension/preserve of the STEPWISE console; the camera becomes the primary mobile surface.
- Dials: visual variance 5/10, motion 3/10, information density 7/10, asset dependence 8/10, brand fidelity 9/10.

## Decisions

- Color: `#071018` / `#0d1821` surfaces, `#e8f1f5` text, cyan `#65d9ff` for active field guidance, green `#39e58c` for confirmed state, amber `#f6bf55` for safety, red `#ff6d6d` for hazards.
- Typography: system sans for readable field text; monospace only for IDs, timestamps, and machine values.
- Spacing: 4px base, with 8/12/16/24px rhythm.
- Radius: 12px cards, 999px status pills, 4px controls.
- Motion: short opacity/scale transitions; no motion is required for comprehension and reduced-motion is respected.

## Runtime topology

```text
phone browser
  ├─ one getUserMedia camera stream ──> local overlay + selected JPEG frames
  ├─ mic PCM / text fallback ─────────> one STEPWISE WebSocket
  └─ structured UI events <──────────── FastAPI gateway
                                          ├─ ClaudeAgent (primary, optional key)
                                          ├─ MockAgent (deterministic fallback)
                                          ├─ Cartesia adapter (optional audio provider)
                                          ├─ MossProvider (optional) / LocalProvider
                                          └─ Orchestrator -> existing grounded tools/catalogs/safety
```

## Provider strategy

`AgentRuntime` owns conversation history, image inputs, streaming boundaries, and tool-loop policy. `ClaudeAgent` maps STEPWISE's existing OpenAI-shaped tool definitions to Anthropic Messages API tools and sends every call through `Orchestrator.process_tool_call`. `MockAgent` uses the same orchestrator and is the tested demo path when credentials are absent.

Cartesia is a separate audio transport concern. The browser/WebSocket contract stays unchanged so current PCM playback, interruption, captions, and reconnect behavior remain intact. When Cartesia credentials are absent, the text fallback remains fully usable and the status explicitly says `mock/local`.

## AR coordinate contract

- Camera-image boxes use `[ymin, xmin, ymax, xmax]` in `normalized_1000` space, matching the donor.
- The overlay maps source-camera pixels to the video viewport using the same `object-fit: cover` transform as the video element.
- `tracking_status=confirmed` is reserved for `source=user_confirmed` or a verified marker/detector. Pending voice hints are visibly dashed and never presented as located facts.
- Schematic/3D coordinates never become camera coordinates.

## Safety

STEPWISE remains inspection/advisory-only. The orchestrator validates all tool arguments. LOTO and safety checklist advancement remain sequential and confirmation-gated. Untrusted retrieval text is context only and cannot override the existing safety policy. Machine identity and source labels remain visible in the UI.

## Why no second live-media stack

The supplied STEPWISE app already has a working WebSocket audio/control path and reconnect/resync logic. Adding donor WebRTC alongside it would create competing camera/audio lifecycles. The integrated core uses one camera stream and one WebSocket; WebRTC remains documented donor material for a future phone-to-laptop pairing phase.
