# STEPWISE AR reuse audit

## Inputs

- `stepwise/` is the primary STEPWISE repository. Its catalogs, handlers, grounding rules, safety state machines, session state, WebSocket protocol, schematics, reports, tests, and CNC GLB remain authoritative.
- `ar-donor/` is the donor repository. Its camera lifecycle, object-fit: cover coordinate math, annotation overlay patterns, procedure tracker patterns, and 3D viewer patterns are adapted into STEPWISE's React 18 application.
- The duplicate AR ZIP was not used.

## Retained from STEPWISE

- `backend/app/data/` catalogs and telemetry.
- `backend/app/agents/tools/handlers.py` and `schemas.py` as the only tool execution/validation path.
- `SessionState`, `Orchestrator.process_tool_call`, grounding whitelists, LOTO/procedure state machines, reports, schematics, and the CNC GLB.
- Existing WebSocket transport and binary PCM framing as the browser transport contract.
- Existing STEPWISE tests and desktop panels.

## Ported/adapted from AR donor

- `coverMap` math and the `normalized_1000` coordinate convention.
- Camera lifecycle ideas: rear-facing camera, camera switch, permission/error handling, file/demo fallback, and cleanup on disconnect.
- Annotation concepts: persistent/pending/confirmed overlays, tracking status, expiry, history, and tap confirmation.
- Procedure tracker visual pattern and 3D viewer interaction model. The donor's React 19 package is not merged.

## Genuinely new

- Provider-independent agent runtime with Claude adapter and deterministic mock adapter.
- Cartesia capability/status adapter and local fallback posture.
- Moss knowledge-provider interface with local-document fallback.
- Structured `ar.annotation.*` WebSocket events, anchor confirmation validation, and the mobile-first STEPWISE field shell.
- Architecture/status/demo/test documentation for this integration.

## Retired/replaced

- Qwen/DashScope is retained only as an isolated legacy connector; Claude is the primary provider setting for the new agent runtime.
- Donor Gemini/NotebookLM orchestration is not merged into STEPWISE. Its source remains available for audit but is not placed behind the STEPWISE UI.
- Approximate model-guessed camera boxes are not treated as confirmed overlays. A voice request creates a pending target; a technician tap or a verified detector is required.

## Conflicts and dependencies

- STEPWISE uses React 18; donor uses React 19. Components were adapted to React 18 and donor package files were not merged.
- STEPWISE uses one WebSocket for browser control/audio. WebRTC was not introduced as a second live-media stack for the core flow.
- The Moss Python SDK is optional because credentials and a project index are not present in the supplied workspace. Local catalog/procedure fallback is explicit.

## License and attribution

- STEPWISE's Apache 2.0 notice remains in `stepwise/LICENSE`.
- The donor's MIT notice remains in `ar-donor/LICENSE`.
- Adapted code is identified in source comments and this audit. No inherited code is described as newly authored.
- The donor repository has hackathon-style pre-existing code and attribution requirements; the donor is used as an input/reference, not represented as original work.
