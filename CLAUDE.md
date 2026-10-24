# BuildSight

Hands-free build copilot. Give it any picture-based instructions; it watches you build through an overhead phone camera, tells you what to do next, and catches mistakes by comparing each finished step with the manual's own picture.

Built at Cal Hacks 13.0 (Oct 23-25, 2026). Submit by Sun Oct 25, 8:30 AM PT (hard deadline 9:00). All work must happen during the hackathon. The team plan (demo script, props, prize targeting, timeline) lives in the "BuildSight: Cal Hacks 13.0 Project Plan" doc.

Demo: a LEGO set partway built, a staged mistake it catches ("that piece is rotated"), then a voice switch to an IKEA piece to prove it works on anything.

## Repo layout

```
stepwise/                 the app (folder name predates the rename)
  backend/                FastAPI
    app/build/            BuildSight: models, catalog, vision (Claude), guide, metrics
    app/data/builds/      one folder per ingested manual (build.json + steps/ + pages/)
    scripts/              ingest_manual.py, check_steps.py (risk test)
    app/agents, grounding, realtime, ws ...   inherited CNC console code (legacy)
  frontend/               React 18 + Vite + TypeScript, phone web app
docs/, ar-donor/          inherited docs and reference code
```

## Stack

| Piece | Tool | Where |
|---|---|---|
| Phone web app | React 18 + Vite + TypeScript, plain CSS (`bs-` classes in `index.css`) | `frontend/src/App.tsx`, `components/BuildCamera.tsx`, `StepPanel.tsx` |
| Dashboard | Second screen at `#dashboard`, polls `GET /api/metrics` | `frontend/src/Dashboard.tsx` |
| Backend | Python 3.12, FastAPI, one WebSocket `/ws` | `backend/app/main.py`, `app/ws/gateway.py` |
| Step check, part match, questions | Claude Sonnet 5.5 (`claude-sonnet-5-5`), structured outputs, effort `low` | `app/build/vision.py` |
| Reading manuals into steps | Claude Opus 5.5 (`claude-opus-5-5`), run once per manual | `scripts/ingest_manual.py` |
| Voice | Cartesia Sonic TTS + Ink STT (turn detection). Browser speech APIs when no key | `app/realtime/cartesia.py`, `frontend/src/audio/browserSpeech.ts` |
| Hosting | Docker image (frontend built in) behind HTTPS. Plan: Azure Container Apps | `backend/Dockerfile` |

All Claude calls go through `anthropic` (Python SDK, `client.beta.messages.parse` with pydantic models) and send `fallbacks="default"` with beta `server-side-fallback-2026-07-01`. Optional SDKs (`anthropic`, `cartesia`, `pymupdf`, `pillow`) are in `requirements-optional.txt`.

## How it works

1. Ingest (before the demo): `ingest_manual.py` renders PDF pages, Opus returns one record per step (parts, action, watch_for, crop box), the step pictures are cropped to `steps/NN.png`. A person reviews `build.json`, fixes crops (`--recrop`) and sets `approved: true`.
2. Live: the browser keeps a recent frame on the server. When hands leave the frame and the scene is still for 1.5 s (`BuildCamera.tsx`), it sends `{"type":"control","action":"check"}`. Sonnet compares the camera frame with the manual picture for this step and the previous one.
3. `BuildGuide` (`app/build/guide.py`) owns the flow:
   - "next", "repeat", "back", "what's next", "what step am I on", "switch to the stool", "that's fine" are matched in code, no model call
   - a passing check says "Good" and advances
   - an issue sets the step to failed: "next" is refused until a later check passes or the builder says "that's fine" (logged as an override)
   - confidence below 0.7 asks for a closer look instead of judging
   - "is this the right one?" goes to part matching. Anything else is a question answered only from the manual's steps
4. Every reply is spoken (Cartesia or browser) and shown as text. Build status and metrics go to the browser as `control` messages `build` and `metrics_update`.

## Rules

- Never invent sizes, part numbers or steps. Answers come from the ingested manual only.
- Never draw or generate a manual picture. Show the real cropped step image, or none.
- A failed check blocks "next". Only a passing check or an explicit, logged "that's fine" clears it.
- Below 0.7 confidence, ask for a closer look. Never guess.
- Keep spoken replies to one instruction, about 20 words, parts named by color and size.
- All API keys stay in `backend/.env`. The frontend only talks to `/ws` and `/api/*`.
- Every provider degrades without its key: commands keep working, checks and questions say the Claude key is missing, voice falls back to the browser.

## Routes

`GET /api/config` · `GET /api/builds` · `POST /api/builds/reload` · `GET /api/builds/{id}/steps/NN.png` · `GET /api/metrics` · `GET /api/tts?text=` · `WS /ws`

## Running locally

```bash
cd stepwise/backend
python3 -m venv .venv && source .venv/bin/activate
python3 -m pip install -r requirements.txt -r requirements-optional.txt
cp ../.env.example .env            # ANTHROPIC_API_KEY, CARTESIA_API_KEY, CARTESIA_VOICE_ID
cd ../frontend && npm ci && npm run build && cd ../backend
uvicorn app.main:app --host 0.0.0.0 --port 8000     # serves the built app at http://localhost:8000
```

Phones only open the camera on `https://`. For a phone on the same network, put an HTTPS tunnel in front, e.g. `cloudflared tunnel --url http://localhost:8000`, and open the https URL it prints. The dashboard is the same URL plus `#dashboard`.

Risk test (the plan's first gate, 13 of 15): `python scripts/check_steps.py --build app/data/builds/<id> --photos <folder of 09_ok_1.jpg, 09_bad_rotated.jpg ...>`.

Before you commit: `cd stepwise/backend && pytest -q`, `PYTHONPATH=stepwise/backend pytest -q tests` (from the repo root), `cd stepwise/frontend && npm run build`.

## Legacy

The CNC console (`#console`), Qwen realtime session, Alibaba deploy files and the CNC procedure catalog come from the earlier STEPWISE project. They still run and their tests still pass, but nothing new is built on them. With no build on disk, text turns fall through to that console's agent.

## Reference repos (credit in README and Devpost)

- AR Technician Assistant (github.com/omer-izhaki/-ar-technician-assistant), MIT. Lives in `ar-donor/`. Camera and overlay patterns, session summary idea.
- FieldVision (github.com/SunnyYadav16/field-vision), MIT. Mic streaming worklet, session report idea.
- AI_MaintenanceAgent (github.com/dogaece-koca/AI_MaintenanceAgent), MIT. Manual-grounded answers, "didn't work" escalation.
- FORGE (github.com/kaushikchaturvedula/FORGE), Apache 2.0. Ideas only: verbal confirmation gating.
- RepairMate (github.com/omkar-core/RepairMate). Ideas only: photo to step-by-step instructions.

## Docs

- Claude API: https://docs.claude.com
- Cartesia: https://docs.cartesia.ai/llms.txt
- FastAPI: https://fastapi.tiangolo.com
