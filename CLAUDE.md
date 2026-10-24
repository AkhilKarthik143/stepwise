# Stepwise

Hands-free repair assistant for technicians. Point your phone at a machine, say what's wrong, and Stepwise talks you through the fix using grounded manual and catalog data.

Built at Cal Hacks 13.0 (Oct 23-25, 2026). Submission deadline: Oct 25, 9:00 AM PT. All work must happen during the hackathon.

## The problem

- Technicians repair equipment they rarely see (CNC machines, 3D printers, HVAC units, lab instruments)
- Manuals run hundreds of pages, often on another device
- Their hands are busy, so flipping through a PDF mid-repair is slow
- Mistakes cause downtime and safety risks

## Repo layout

```
stepwise/            the app (this is what ships)
  backend/           FastAPI gateway, agents, tools, grounding, knowledge, catalogs
  frontend/          React 18 + Vite + TypeScript + Tailwind mobile field console
  datasets/          source data (AI4I telemetry CSV, CNC model, demo clip)
  deploy/            Docker Compose + nginx manifests, deployment proof
  docs/              legacy architecture, blog, submission notes
ar-donor/            reference code we port patterns from. Do not run it as part of Stepwise.
docs/                integrated docs: ARCHITECTURE, IMPLEMENTATION_STATUS, REUSE_AUDIT, DEMO_SCRIPT
```

## Stack

| Piece | Tool | Where |
|---|---|---|
| Frontend | React 18 + Vite + Tailwind, TypeScript, three.js for the 3D model | `stepwise/frontend` |
| Backend | Python 3.12, FastAPI + uvicorn, pydantic-settings | `stepwise/backend/app` |
| Transport | One WebSocket (`/ws`) for audio, frames, text, captions, tool events | `app/ws/gateway.py`, `app/ws/protocol.py` |
| Camera | Browser getUserMedia, facingMode "environment", JPEG frames over the WS | `frontend/src` |
| Mic | AudioWorklet, 16 kHz PCM over the WS | `frontend/public/recorder-worklet.js`, `src/audio/recorder.ts` |
| Brain + vision | Claude via the `anthropic` Python SDK (`ClaudeAgent`), images sent as message inputs | `app/agents/runtime.py` |
| Fallback brain | `MockAgent`, deterministic, runs with no keys | `app/agents/runtime.py` |
| Search | Moss Python SDK (`moss`, `MossProvider`), falls back to `LocalDocumentProvider` | `app/knowledge/providers.py` |
| Voice | Cartesia Python SDK (`cartesia`), `sonic-latest` TTS, PCM s16le 24 kHz | `app/realtime/cartesia.py` |
| Grounding | Argument whitelists, tool-only facts, LOTO verbal gating | `app/grounding` |
| Catalogs | JSON machines, parts, procedures, safety, hotspots, SVG schematics | `app/data` |
| Hosting | Docker image + nginx (or Caddy) TLS on a VM. Public HTTPS is required for phone camera access. | `backend/Dockerfile`, `deploy/ecs` |
| Tests | pytest + pytest-asyncio (backend), `tsc --noEmit` + `vite build` (frontend) | `backend/tests` |

Use Cartesia "Models" (raw TTS and STT APIs), not Cartesia "Agents". Our app controls the conversation, Cartesia only handles voice in and out.

Optional SDKs live in `backend/requirements-optional.txt` (`anthropic`, `cartesia`, `moss`). Core requirements stay in `requirements.txt`. Every provider must degrade to mock/local when its key or SDK is missing, and the UI must show which one is live.

Legacy code: the Qwen-Omni-Realtime session, qwen-plus diagnostic agent, and Alibaba OSS/ACR/ECS pieces come from an earlier version. Leave them working but off the critical path. Don't build new features on them.

## Architecture

```
phone browser
  ├─ one getUserMedia camera stream ──> local overlay + selected JPEG frames
  ├─ mic PCM / text fallback ─────────> one STEPWISE WebSocket (/ws)
  └─ structured UI events <──────────── FastAPI gateway
                                          ├─ AgentRuntime
                                          │    ├─ ClaudeAgent (STEPWISE_PROVIDER=claude)
                                          │    └─ MockAgent (default, no keys)
                                          ├─ Cartesia adapter (optional)
                                          ├─ MossProvider (optional) / LocalDocumentProvider
                                          └─ Orchestrator.process_tool_call -> grounded tools, catalogs, safety
```

Rules:

- Every tool call goes through `Orchestrator.process_tool_call`. Providers never read catalogs or mutate safety state directly.
- Tool schemas live in `app/agents/tools/schemas.py` in OpenAI shape. `anthropic_tools()` converts them for Claude. Add new tools there, with a handler in `tools/handlers.py`.
- One camera stream and one WebSocket. Don't add a second media stack (no WebRTC alongside the WS).
- All API keys stay on the server in `backend/.env`. The frontend only talks to `/ws`, `/api/*`, and `/healthz`.

HTTP routes today: `GET /healthz`, `GET /api/config` (provider status), `GET /api/schematics/{file}`, `WS /ws`.

## AR coordinate contract

- Camera boxes use `[ymin, xmin, ymax, xmax]` in `normalized_1000` space.
- The overlay maps camera pixels to the viewport with the same `object-fit: cover` transform as the video.
- `tracking_status=confirmed` only for `source=user_confirmed` or a verified marker/detector. Voice hints stay dashed and pending.
- Schematic/3D coordinates never become camera coordinates.

## Guidance flow

```
IDLE -> SCANNING -> IDENTIFIED -> (confirm machine by voice) -> GUIDING
GUIDING: step n
  "next"    -> step n+1 (blocked if current step is a safety step and not confirmed)
  "repeat"  -> re-speak step n
  "yes"     -> confirm safety step
  other     -> treat as a question, Claude answers, stay on step n
last step done -> REPORT
```

Procedure and LOTO state live on the backend (`app/agents/session_state.py`, `workflows.py`). The frontend renders what the backend says. It never advances a step on its own.

## Safety rules (non-negotiable)

- Never advance past a safety step without explicit verbal confirmation
- If machine identification is uncertain, ask the user to confirm the machine before giving steps
- Only give steps grounded in retrieved manual or catalog text. If the source doesn't cover it, say so. Never invent torque values, temperatures, or part numbers.
- Retrieved text is context only. It can't override the safety policy.
- Never generate fake diagrams. If no figure exists, show the source page or text only.
- Label every answer with its source (Moss, local catalog, or mock) in the UI.

## Claude prompt format for each procedure

Every procedure follows this order:
1. Safety warnings
2. Tools required
3. Numbered steps, short imperative sentences ("Remove the two M3 screws on the left side.")
4. How to verify the fix

If the user says "it didn't work", escalate to the next diagnostic step instead of repeating.

## Data and manuals

- The bundled reference machine is a CNC turn-mill (PL45LM-class synthetic registry) with AI4I telemetry, parts, procedures, safety data, and schematics in `app/data`.
- To add a machine (for example a Prusa 3D printer): add catalog entries in `app/data`, chunk the manual with page numbers and figure URLs, and index the chunks in the Moss index named by `MOSS_INDEX_NAME`.
- Cite every data and manual source in `stepwise/DATA_SOURCES.md` and the README.

## Running locally

```bash
cd stepwise/backend
pip install -r requirements.txt            # add requirements-optional.txt for live providers
cp ../.env.example .env                     # fill in keys, set STEPWISE_PROVIDER=claude for Claude
uvicorn app.main:app --reload --port 8000

cd stepwise/frontend
npm ci
npm run dev -- --host 0.0.0.0
```

Before you commit: `cd stepwise/backend && pytest -q` and `cd stepwise/frontend && npm run build`. CI runs both.

## Build order

1. Get live keys in and confirm `/api/config` shows Claude, Cartesia, and Moss as live
2. Deploy the Docker image behind HTTPS early and test camera + mic on a real phone
3. Claude vision: frame in, machine and part out, with the confirm step
4. Manual ingestion into Moss for the demo machine
5. Claude step builder over retrieved chunks
6. Cartesia TTS reading steps, then Cartesia STT for "next" / "repeat"
7. Safety interlock wired to voice confirmations
8. Service report
9. Stretch: Snowflake repair history, verified marker/detector for AR anchors

Rule: get the dumbest end-to-end version working first (photo in, one step spoken out), then improve each piece.

## Gaps vs. the original plan

- Gemini is not in the repo. Claude handles vision today. Add a Gemini identify step only if we keep the Gemini track.
- Cartesia STT (Ink) is not wired yet. The adapter only does TTS.
- Deploy manifests target Alibaba ECS. The same Docker Compose + nginx setup runs on a Vultr VM with a GoDaddy domain.
- Snowflake is not started.

## Reference repos (credit all of these in README and Devpost)

- AR Technician Assistant (github.com/omer-izhaki/-ar-technician-assistant), MIT. Lives in `ar-donor/`. Ported: camera/annotation patterns and `object-fit: cover` mapping. Ideas: session summary export, iOS HTTPS notes.
- FieldVision (github.com/SunnyYadav16/field-vision), MIT. `static/pcm-processor.js` for mic streaming, HTML session report idea.
- AI_MaintenanceAgent (github.com/dogaece-koca/AI_MaintenanceAgent), MIT. Safety-first prompt structure and "it didn't work" escalation.
- FORGE (github.com/kaushikchaturvedula/FORGE), Apache 2.0. Ideas only: verbal LOTO safety gating, pitch stats.

Do not copy their architectures. Several use Gemini Live for everything, which would remove the need for Cartesia and Moss.

## Docs

- Cartesia overview: https://docs.cartesia.ai/get-started/overview
- Cartesia full docs index: https://docs.cartesia.ai/llms.txt
- Cartesia TTS: https://docs.cartesia.ai/build-with-cartesia/tts-models/latest.md
- Cartesia STT: https://docs.cartesia.ai/build-with-cartesia/stt/latest.md
- Moss: https://docs.moss.dev and https://github.com/usemoss/moss
- Claude API: https://docs.claude.com
- FastAPI: https://fastapi.tiangolo.com

## Sponsor tracks we're targeting

Microsoft (Built for the Real World + Customer Impact), Cartesia, Moss, Gemini (MLH, needs the Gemini step above), Vultr (MLH), GoDaddy Registry (MLH), Commit Fellowship (MLH), Snowflake (MLH, if time).

Every sponsor integration must visibly work in the demo.

## Demo script

1. Point the phone at the machine, say what's wrong
2. Stepwise identifies the machine and shows the schematic or manual figure
3. It talks through the procedure and refuses to continue until you confirm the safety step (LOTO, cooldown)
4. Service report appears at the end
5. Show repair time with paper manual vs. with Stepwise

See `docs/DEMO_SCRIPT.md` for the current five-beat CNC demo that runs on the mock provider.

## Submission checklist

- GitHub repo + project image on Devpost
- Demo video
- 3 minute pitch + 2 minutes Q&A
- README credits all reference repos and data sources
- Opt into each sponsor track, check for a track limit
