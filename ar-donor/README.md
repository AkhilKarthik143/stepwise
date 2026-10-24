# 🔧 AR Technician Assistant

> A real-time, **hallucination-resistant** AR assistant for field technicians — live voice + AR guidance that stays grounded in the real service manual instead of guessing.

![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-async-009688?logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![WebRTC](https://img.shields.io/badge/WebRTC-aiortc-333333?logo=webrtc&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini-Multimodal%20Live-8E75B2?logo=googlegemini&logoColor=white)
![WebXR](https://img.shields.io/badge/WebXR-three.js-000000?logo=three.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Caddy%20HTTPS-2496ED?logo=docker&logoColor=white)
![Tests](https://img.shields.io/badge/tests-389%20passing-16794c)
![License](https://img.shields.io/badge/license-MIT-blue)

A full-stack, real-time multimodal AI system: a technician's camera + mic stream over **WebRTC** to a Python backend that relays them to **Gemini's Multimodal Live API** for spoken, hands-free guidance — with **tool-calling into a service-manual knowledge base** so every exact value (torque specs, error codes, procedures) is grounded, not hallucinated. It ships live AR annotations, a 3D/2D solution viewer, a typed-chat lane with image understanding, desktop screen-share, and a **multi-tenant, per-company "Solution Memory"** that captures each solved case so teams stop losing knowledge when people leave.

**Highlights:** end-to-end WebRTC signaling · concurrent AI tool dispatch with strict output sanitization · lazy-loaded 3D boundary (three/R3F/XR) kept off the eager path · multi-tenant signed-token auth with physical per-tenant data isolation · Dockerized one-command deploy behind automatic-HTTPS Caddy · ~389 automated tests (pytest + vitest) and an adversarial-review process.

**Built by [Omer Izhaki](https://github.com/omer-izhaki).** Stack: Python · FastAPI · aiortc · React 19 · TypeScript · Vite · three.js / react-three-fiber · Gemini · Docker · AWS EC2 · Vercel.

---

The technician wears AR glasses (e.g. **Meta Quest 3**) running a **WebXR**
browser app. Their camera + microphone stream to a Python backend over
**WebRTC**. The backend relays that multimodal stream to **Gemini's Multimodal
Live API**, which guides the technician out loud in real time. When Gemini needs
an exact value — a torque spec, an error-code procedure, a schematic detail — it
**calls a tool** that queries a **NotebookLM** notebook, so the spoken answer is
grounded in the real service manual instead of being guessed.

Beyond voice + manual lookups, the client app ships:

- **AR annotations** — when the assistant references a physical part it calls
  `annotate_component` to draw a glowing highlight in the technician's view:
  shapes (`box`/`point`/`arrow`), severity levels (`info`/`warn`/`danger`), and
  numbered procedure-step badges — plus `clear_annotations` to remove one or
  all. A right-edge "Marks" history rail keeps recent highlights for
  tap-to-recall.
- **Live captions + two-sided transcript** — both the assistant's speech and the
  technician's own speech are transcribed (verify the AI heard "M8", not "N8").
- **Typed text input** — a loud-environment fallback; messages ride the WebRTC
  data channel straight into the Gemini session.
- **Mic mute + level meter** — mute toggle (`m` hotkey), a live mic level meter,
  and a "no mic signal" warning when an unmuted mic stays silent.
- **Session summary export** — ending a session opens a summary (duration,
  turns, marked components, full conversation) with copy / download-as-.txt.

```
 ┌─────────────────────────┐        WebRTC (audio+video)        ┌────────────────────────────┐
 │  AR Glasses / Browser   │  ───────────────────────────────▶ │   FastAPI + aiortc backend  │
 │  WebXR + React 19 + r3f │  ◀───────────────────────────────  │                            │
 │  getUserMedia + RTCPeer │     WebRTC (AI voice, 48kHz PCM)    │  ┌──────────────────────┐  │
 └─────────────────────────┘                                    │  │  GeminiBridge         │  │
                                                                 │  │  (WebSocket, BidiGen) │  │
                                                                 │  └───────────┬──────────┘  │
                                                                 │              │ toolCall    │
                                                                 │              ▼             │
                                                                 │  ┌──────────────────────┐  │
                                                                 │  │  knowledge.py (RAG)   │  │
                                                                 │  │  notebooklm-py        │  │
                                                                 │  └───────────┬──────────┘  │
                                                                 └──────────────┼─────────────┘
              wss://generativelanguage.googleapis.com            ┌──────────────┼─────────────┐
              .../BidiGenerateContent  ◀────────────────────────▶│ Gemini Live  │ NotebookLM  │
                                                                 └────────────────────────────┘
```

---

## Project layout

```
ar-technician-assistant/
├── main.py                  FastAPI + aiortc /offer + PeerSession media pumps
├── config.py                Central .env-driven settings + system prompt + tool schema
├── requirements.txt
├── pytest.ini / conftest.py Test config (asyncio_mode=auto; project on sys.path)
├── IMPROVEMENTS.md          Autonomous improvement-loop charter + iteration log
├── .env.example             Copy to .env and fill in
├── services/
│   ├── knowledge.py         NotebookLM RAG tool — tiered lookup (L1/L2/L3/L4)
│   ├── retrieval.py         Pure-Python L2 similarity cache + L3 BM25 local index
│   ├── metrics.py           In-process counters/gauges/timers -> /metrics (Prometheus)
│   ├── gemini_bridge.py     Gemini Live protocol — upstream()/downstream() loops
│   └── webrtc_tracks.py     aiortc media: AI-voice track + audio/video conversion
├── web/                     React 19 + Vite + r3f/xr/uikit frontend (v2 source)
│   ├── README.md            Frontend guide — dev server, build, deploy
│   ├── src/App.tsx          App shell — lazy Scene, camera bg, 2D HUD, overlay
│   ├── src/components/      Scene (r3f Canvas + XR), WorldMarkers (6DoF), Hud2D,
│   │                        AnnotationOverlay (2D highlights), AnnotationHistory
│   │                        (recall rail), CaptionBar (live captions + transcript),
│   │                        SessionSummaryModal (export), CameraBackground
│   ├── src/lib/             useWebRTC hook + capability tiers + useWakeLock
│   ├── legacy/              Preserved v1 vanilla frontend (reference only)
│   └── deploy.sh            Build (vite) and copy dist/ -> ../static/
├── static/                  Built React app served by FastAPI ("/" + "/static/*")
├── tests/
│   └── test_flow.py         Mock tests (113): toolCalls (query/annotate/clear),
│                            RAG tiers, transcription, reconnect/cancellation,
│                            audio playout, session reaper, hardening
├── scripts/
│   ├── make_cert.sh / .ps1  Generate a self-signed TLS cert
│   ├── bootstrap_notebook.py  Create a dummy NotebookLM manual for testing
│   ├── probe_gemini.py        Gemini Live pre-flight (auth/model/API-version)
│   ├── test_notebook.py       Smoke-test the RAG tool from the CLI
│   ├── test_live_loop.py      Full cognitive-loop live test (no browser)
│   └── test_webrtc_loopback.py  Local WebRTC negotiation test (no browser/key)
└── certs/                   cert.pem / key.pem land here
```

The transport + media-processing layer (`main.py`'s `PeerSession`,
`webrtc_tracks.py`) is deliberately separate from the Gemini WebSocket logic
(`gemini_bridge.py`, with its `upstream()`/`downstream()` loops) and the RAG
tool (`knowledge.py`). Each can be tested in isolation.

The frontend has its own guide — [`web/README.md`](web/README.md) — covering the
Vite dev server (`cd web && npm install && npm run dev`) and the build/deploy
script (`bash web/deploy.sh`, which copies the built app into `static/`).
Ongoing development is governed by [`IMPROVEMENTS.md`](IMPROVEMENTS.md): a
charter for an autonomous improvement loop with a ranked backlog, per-iteration
verification gates (full pytest, typecheck, build/deploy, serve + loopback
checks), and an iteration log.

---

## Prerequisites

- **Python 3.10–3.12** (tested on 3.11).
- A **Gemini API key** — https://aistudio.google.com/apikey
- A **Google account with NotebookLM** access — https://notebooklm.google.com
- For headset use: the AR device and the server on the **same network**, plus
  **HTTPS** (WebXR + camera/mic require a secure context off `localhost`).

---

## Step 1 — Install

```bash
cd ar-technician-assistant

# Create and activate a virtual environment
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# Windows (git bash) / macOS / Linux:
source .venv/Scripts/activate      # ...or .venv/bin/activate on macOS/Linux

pip install -r requirements.txt
```

This installs `fastapi`, `uvicorn`, `aiortc` (+ `av`), `opencv-python`,
`websockets`, `google-genai`, `notebooklm-py[cookies]`, and `python-dotenv`,
plus `pytest` / `pytest-asyncio` for the test suite.

---

## Step 2 — Authenticate NotebookLM and create a notebook

`notebooklm-py` drives your real NotebookLM session. Per the bundled `SKILL.md`
there are two auth paths:

```bash
# (A) Primary — interactive OAuth (opens a browser; needs the [browser] extra):
notebooklm login

# (B) Headless / the brief's path — import cookies from a logged-in browser
#     (needs the [cookies] extra; rookiepy does NOT build on Python 3.13+):
notebooklm login --browser-cookies chrome
#     variants:  --browser-cookies 'chrome::Profile 1'   |   firefox::Work

# Verify auth — use --test so it makes a real network call (bare --json only
# proves the cookie file parses). Require "status": ok AND checks.token_fetch:true
notebooklm auth check --test --json
```

Credentials are stored under `NOTEBOOKLM_HOME` (default `~/.notebooklm`) as
`storage_state.json`. If cookies later go stale, refresh in place with
`notebooklm auth refresh` rather than a full re-login.

Now either point the app at an **existing** notebook (find its id with
`notebooklm list`) **or** create a ready-made dummy manual for testing:

```bash
python scripts/bootstrap_notebook.py
# -> prints:  ACTIVE_NOTEBOOK_ID=<id>   (seeds a fake "XR-200" service manual)
```

---

## Step 3 — Configure `.env`

```bash
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Edit `.env`:

```ini
GEMINI_API_KEY=AIza...your-key...
GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001
ACTIVE_NOTEBOOK_ID=<the id from Step 2>
# NOTEBOOKLM_HOME=  (leave blank to use ~/.notebooklm)
```

Quick RAG sanity check (no AR needed):

```bash
python scripts/test_notebook.py "What is the torque spec for the M8 head bolts?"
```

You should get a grounded answer with a `SOURCES:` block.

---

## Step 4 — TLS / HTTPS (required for headset use)

Modern browsers only expose WebXR (`immersive-ar`) and `getUserMedia` over a
**secure context**. `http://localhost` counts as secure (great for desktop
testing), but accessing the server from the headset over LAN (`https://<ip>`)
needs a certificate.

Find your machine's LAN IP, then generate a cert that includes it:

```bash
# git bash / macOS / Linux
bash scripts/make_cert.sh 192.168.1.42

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts\make_cert.ps1 -LanIp 192.168.1.42
```

This writes `certs/cert.pem` and `certs/key.pem` (already referenced by
`SSL_CERTFILE`/`SSL_KEYFILE` in `.env.example`).

> **Best experience:** use [`mkcert`](https://github.com/FiloSottile/mkcert),
> which creates a locally-trusted cert so the headset shows no warning page:
> `mkcert localhost 127.0.0.1 192.168.1.42` then point `SSL_*` at the output.
> With a plain self-signed cert you must accept the browser warning once.

---

## Step 5 — Run

```bash
python main.py
```

- With `SSL_CERTFILE`/`SSL_KEYFILE` present → serves **HTTPS** on `:8443`.
- Without them → serves plain **HTTP** on the same port (`:8443`) — fine for
  `http://localhost` only.

Or run uvicorn directly:

```bash
uvicorn main:app --host 0.0.0.0 --port 8443 \
  --ssl-certfile certs/cert.pem --ssl-keyfile certs/key.pem
```

Health check: `GET https://localhost:8443/health`.

---

## Step 6 — Use it

**Desktop test (no headset):** open `https://localhost:8443/` (or `http://localhost:8443`
if running plain HTTP), click **Connect to AI Assistant**, allow camera + mic.
Speak — the assistant replies out loud and can see your webcam. Ask something
that forces a lookup, e.g. *"What does error code E-45 mean?"* — Gemini will call
the `query_technical_manual` tool and answer from the notebook.

**On the Meta Quest 3:**
1. Make sure the headset and server are on the same Wi-Fi.
2. In the Quest Browser, open `https://<your-lan-ip>:8443/` and accept the cert
   warning (unless you used `mkcert`).
3. Tap **Connect to AI Assistant** and grant camera/mic, then tap **Enter AR**
   in the top bar (rendered by the React HUD; enabled once the XR store is
   ready).

**On an iPad / iPhone (Safari):**
1. Generate a cert covering your machine's LAN IP and start the server — the
   PowerShell script auto-detects the IP and prints the exact URL:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\make_cert.ps1
   bash web/deploy.sh        # build the app into static/ (first run / after UI changes)
   python main.py            # auto-detects certs\ -> HTTPS on :8443
   ```
2. On the iPad (same Wi-Fi), open `https://<your-lan-ip>:8443/` in Safari. It
   warns about the self-signed cert → **Show Details → visit this website**.
   (Accepting it makes the page a secure context, which iOS requires for the
   camera/mic.) For a warning-free experience use `mkcert` instead.
3. Tap **Connect to AI Assistant** and allow camera + mic. The rear camera is
   used (`facingMode: environment`). There's no "Enter AR" on iOS (Safari has no
   WebXR) — it runs the 2D-over-camera mode, which is the same one used on a
   desktop. The AI's diagrams, highlights, step playback, and pinned overlays
   all work; **Snap** opens the iOS share sheet so you can *Save to Photos*.
4. Optional: **Share → Add to Home Screen** for a fullscreen, no-chrome launch.
   On **older iPadOS (< 16.4)** the camera is blocked in the installed
   (home-screen) app — stay in Safari there. iPadOS 16.4+ works installed.

> First-visit notes: you must accept the cert warning **before** Connect can
> reach the server (the signaling fetches use the same origin). And on a busy
> Wi-Fi the first Connect may sit on "Connecting…" for a second or two while ICE
> gathers — that's normal, not a hang.

**On a phone (PWA):** the app is installable — use the browser menu's **Add to
Home screen** for a one-tap, fullscreen (no browser chrome) launch. Note: with
the self-signed LAN cert, browsers skip the *automatic* install prompt; the
manual Add-to-Home-screen path still honors the manifest. With a CA-valid cert
(e.g. `mkcert` or a real domain) the install banner appears normally.

---

## Step 7 — Run it from ANYWHERE (off your Wi-Fi)

Steps 4-6 are **same-Wi-Fi** (the iPad/headset and the server share a LAN, behind
a self-signed cert). To use it from the field — an iPad on cellular, a tech in
another building — two things have to be true, because a WebRTC call has two
parts:

| Part | Needs | Why |
|------|-------|-----|
| **Signalling + the page** (`/`, `/offer`, `/ice-config`) | a public **HTTPS** URL | iOS needs a secure context for camera/mic; a tunnel gives a real cert (no warning) |
| **The live media** (audio/video/data) | a **TURN** relay | the iPad and your PC are on different networks; STUN alone fails on symmetric NAT |

**A) Expose the app with a TLS-terminating tunnel** (no cert of your own needed —
run plain HTTP locally; the tunnel provides the real cert):

```bash
python main.py                              # plain HTTP on :8443 (no cert)
# in another terminal — Cloudflare quick tunnel (install cloudflared first):
cloudflared tunnel --url http://localhost:8443
# -> prints  https://<random>.trycloudflare.com   (open THAT on the iPad)
```

(Tailscale Funnel or ngrok work too. `trycloudflare` URLs are ephemeral — use a
*named* Cloudflare tunnel for a stable address.)

**B) Configure a TURN relay** so the media can connect across networks. Use a
managed TURN (e.g. Metered's free tier, Twilio NTS, or Cloudflare Calls TURN) —
or self-host [coturn](https://github.com/coturn/coturn) — and set in `.env`:

```dotenv
TURN_URL=turn:your-turn-host:3478
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

The server hands these to the browser **only** through the auth-gated
`/ice-config`, so the long-lived credential isn't harvestable. The startup log
warns when TURN is unset (off-network clients will fail without it).

**C) Lock it down before exposing it publicly.** A public URL means anyone can
spend your Gemini/NotebookLM quota. Set `API_AUTH_TOKEN` in `.env` and append
`?token=<token>` to the URL you open — the client persists it and sends it as
`Authorization: Bearer <token>` on every signalling call (it's gone from the URL
after first load). Treat this as a personal/field tool, not an open endpoint.

Then open the tunnel URL on the iPad **from anywhere**, Connect, and it works
exactly like the LAN path — with a real cert (no warning page).

---

## How tool calling works (grounding)

1. On connect, `GeminiBridge` opens the Gemini Live WebSocket and sends a `setup`
   frame with the system instruction, the `AUDIO` response modality, and three
   tool declarations — **`query_technical_manual(query)`**,
   **`annotate_component(label, detail, box, shape, level, step)`**, and
   **`clear_annotations(label?)`** (see `config.TOOL_DECLARATIONS`) — plus
   session-resumption and input/output audio-transcription config. It then runs
   two loops: **`upstream()`** (drains the send-queue) and **`downstream()`**
   (reads Gemini's stream). `annotate_component` / `clear_annotations` toolCalls
   are routed to the client over the WebRTC data channel and rendered as AR
   highlights (`main.py` `_handle_annotate` / `_handle_clear`).
2. `PeerSession`'s pumps push camera frames (throttled to `VIDEO_FPS`, JPEG) and
   microphone audio (16 kHz PCM16) into the bridge's queue; `upstream()` sends
   them as `realtimeInput`.
3. When Gemini needs a hard fact it emits a `toolCall`. `downstream()` intercepts
   it and spawns a **background task** (so audio/barge-in keep flowing) that calls
   `knowledge.fetch_technical_guidance(query)`.
4. That function opens NotebookLM via `notebooklm-py`
   (`async with NotebookLMClient.from_storage()` — not awaited, one client on the
   app's event loop per the loop-affinity rule), runs
   `client.chat.ask(ACTIVE_NOTEBOOK_ID, query)`, and formats `result.answer` plus
   the `result.references` (`citation_number` + `cited_text` + `source_id`) into a
   clean grounding block.
5. The block is returned to Gemini as a `toolResponse`, and Gemini speaks a
   grounded, cited answer — 24 kHz PCM that `GeminiAudioTrack` resamples to 48 kHz
   and plays back over the WebRTC audio track to the technician's glasses.

---

## What the AI can draw (diagram capabilities)

When words aren't enough, the AI calls **`show_model`** to compose an explanatory
diagram — `mode: "3d"` (orbitable assembly) or `"2d"` (flat schematic) — from
labelled primitives. No CAD library is required; the diagram is composed live,
and for key machines it can be backed by a real GLTF model (see
`MODEL_ASSETS_JSON`).

**Each part** carries:

- **shape** — 3D: `box, cylinder, sphere, cone, torus, arrow, plane`; 2D: `rect,
  circle, line, arrow, text, dimension` (a measurement / clearance call-out).
- **position / size / rotation** — 3D `[x,y,z]`; 2D `[x,y]` (0–100%) with size as
  `[w,h]` or an endpoint delta for the line family.
- **color** — semantic palette: `info, warn, danger, accent, metal, steel, dark,
  light`.
- **label** + **note** — a name plus a short explanation ("M8 bolt — torque to
  25 Nm"); shown in the legend and on the focused part.
- **material** (3D) — `metal / plastic / rubber / glass / painted` (PBR finish) —
  and **opacity** (3D) to make a housing see-through and reveal what's inside.
- **dashed** (2D) — hidden / internal / reference geometry.
- **animate** (2D + 3D) — a looping motion that demonstrates an action: `spin`,
  `swing` (about a `pivot` — scissor blades, a hinge, a wrench), `slide`, `pulse`.
- **spec** + **warning** — tap-to-view hard data (rows of torque / size / part #…)
  and a prominent safety caution.
- **step** — a 1-based sequence number for step-by-step playback.

**Spec-level options:** `caption` (the takeaway), `anchor` (2D — pin the diagram
over the equipment in the camera view), `assetId` (3D — show a pre-built model).

**Companion tools** (no redraw, so the technician keeps their orbit/zoom):
**`highlight_model_part(labels)`** glows named parts, **`set_diagram_step(step)`**
walks a sequence (current glows, later steps dim), and **`clear_model`** dismisses
it.

The technician can **orbit/zoom** a 3D model, **play/pause** any animation
(reduced-motion respected), and **tap a part** (or its legend entry) for its spec
and warnings. Diagrams travel with the session record and stay interactive in the
saved-job view.

---

## Testing

```bash
# Mock unit/integration suite — NO network, NO live keys. Covers toolCalls
# (query/annotate/clear), RAG tiers, transcription/captions, reconnect +
# toolCallCancellation, audio playout, the session reaper, and hardening:
pytest                                         # 113 tests

# Gemini Live connectivity pre-flight (needs only GEMINI_API_KEY) — probes
# auth/model/API-version combinations and prints which reaches setupComplete:
python scripts/probe_gemini.py

# WebRTC negotiation end-to-end, no browser and no live Gemini key
# (GeminiBridge.start is stubbed) — proves the SDP answer + AI-voice track wiring:
python scripts/test_webrtc_loopback.py         # prints "WEBRTC LOOPBACK: PASS"

# RAG tool against your real notebook (needs `notebooklm login` + ACTIVE_NOTEBOOK_ID):
python scripts/test_notebook.py "Summarize the seal replacement procedure"

# Full cognitive loop LIVE, no browser — drives the REAL GeminiBridge + NotebookLM
# with text input; verifies setup-with-tools, toolCall, grounded toolResponse, and
# audio out. Needs a live GEMINI_API_KEY + a configured notebook:
python scripts/test_live_loop.py
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser: "camera/mic blocked" | You're not on a secure context. Use `https://` or `http://localhost`. |
| `/offer` returns 502 "Failed to start AI session" | Bad/missing `GEMINI_API_KEY`, or the model id isn't Live-capable. Try `gemini-2.0-flash-live-001`. |
| Tool answers say "could not authenticate to NotebookLM" | Re-run `notebooklm login --browser-cookies chrome`; check `notebooklm auth check --test`. |
| No AI voice heard | Confirm the page shows "Receiving AI audio track"; check the browser didn't block autoplay (Connect must be the user gesture). |
| Quest can't reach the server | Same Wi-Fi? Firewall allowing port 8443? Cert SAN includes the LAN IP? |
| `Enter AR` button missing/disabled | It stays "Preparing AR…" until WebXR is available. Devices without `immersive-ar` automatically run the 2D HUD (T0) tier — voice, captions, and annotations all still work. |

---

## Security & operations (v2 hardening)

The `/offer` endpoint is gated (in order): **auth → rate limit → body-size →
JSON/schema validation → session cap** (capacity is checked last, deliberately —
no `await` between the check and session registration, so concurrent offers
can't overshoot the cap). All configurable in `.env`:

| Setting | Purpose | Default |
|---|---|---|
| `API_AUTH_TOKEN` | If set, `/offer` **and** `/ice-config` require `X-API-Key: <token>` (or `Authorization: Bearer`). Client reads it from `?token=` or `localStorage.apiToken`, and falls back to STUN-only if `/ice-config` returns 401. | _(off)_ |
| `ALLOWED_ORIGINS` | CORS allow-list (comma-separated). Lock down in prod. | `*` |
| `MAX_SESSIONS` | Concurrent live sessions before `429`. | `25` |
| `RATE_LIMIT_PER_MIN` | Per-IP `/offer` requests per 60s before `429`. | `30` |
| `MAX_OFFER_BYTES` | Reject oversized `/offer` bodies (`413`). | `262144` |
| `SESSION_MAX_SECONDS` | Session reaper: max wall-clock seconds per session (`0` disables). | `14400` (4h) |
| `SESSION_IDLE_SECONDS` | Session reaper: end a session after this long with no inbound media (`0` disables). | `300` (5min) |
| `USER_TEXT_MAX_CHARS` | Max length of a typed user message over the data channel; oversized input is dropped. | `2000` |
| `MODEL_ASSETS_JSON` | Optional catalog of pre-built 3D models the AI can show instead of drawing from primitives. JSON map of `id → {"url","title"}`. A working sample ships in the build, so `{"sample-box":{"url":"/static/sample-assets/box.glb","title":"Sample Box"}}` renders out of the box (validated end-to-end). The AI sets `assetId` on `show_model`; the backend validates it against this catalog (unknown ids fall back to the primitive diagram), the client lazy-loads the GLTF/GLB and overlays the AI's call-outs on it, and a load failure degrades to primitives. **Host your own `.glb` same-origin** — under the app it's served at `/static/<path>` — for offline/field use; uncompressed glTF (no Draco). You own the models' licensing. | _(empty → primitives only)_ |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | TURN relay for real NAT traversal (factory/symmetric NAT). Served to the client via `/ice-config`. | _(STUN only)_ |

**Gemini session resilience:** the bridge supervises its own connection — on a
drop / `goAway` / Live session time-limit it **reconnects with exponential backoff
and a session-resumption handle** (context continuity) while the WebRTC link stays
up, so a long repair job never loses the assistant. The client shows
"reconnecting…" then "re-established" via data-channel `status` events. Only after
`GEMINI_MAX_RECONNECTS` exhausted does the session tear down. Tunable via
`GEMINI_RECONNECT` / `GEMINI_MAX_RECONNECTS` / `GEMINI_RECONNECT_BACKOFF` /
`GEMINI_SESSION_RESUMPTION` / `GEMINI_MIN_HEALTHY_SECONDS` (backoff resets only
after the session stays healthy this long, preventing reconnect flapping).
Reconnects are hygienic: the stale socket is retired immediately and stale queued
media is flushed before the new session starts, and `toolCallCancellation` frames
from the model cancel any in-flight RAG lookups they revoke.

**Ops endpoints:** `GET /health` (liveness + session counts), `GET /ready`
(readiness — `200` only when configured, else `503`; wire to a k8s readiness
probe), `GET /ice-config` (STUN/TURN servers for the browser; auth-gated like
`/offer` when a token is set), `GET /metrics` (Prometheus text — counters for
offer requests/rejections-by-reason, sessions, Gemini reconnects, tool calls by
tool (`query`/`annotate`/`clear`/`unknown`), annotations + clears, reaped
sessions by reason (`sessions_reaped_total`), typed-text accepted/dropped
(`user_text_total` / `user_text_dropped_total`), `/ice-config` auth rejections
(`ice_config_rejected_total`); the `sessions_active` gauge; and
`nb_query_seconds` latency + `nb_query_result_total` by cache tier).

### Knowledge-base speed tiers (v2)

A query resolves through the cheapest tier that can answer it (each tier's hits
are visible in `/metrics` as `nb_query_result_total{tier=...}`):

| Tier | What | Latency | Toggle |
|------|------|---------|--------|
| **L1** | exact-match answer cache (normalized query) | instant | `NOTEBOOKLM_CACHE_*` |
| **L2** | near-duplicate cache — token-cosine paraphrase match to a prior answer | instant | `NOTEBOOKLM_SIMILARITY_*` |
| **L3 fast** | answer locally from a BM25 index over the manual when the match is very strong (opt-in; trades synthesis quality for latency) | ~1 ms | `NOTEBOOKLM_LOCAL_FAST_PATH` |
| **L4** | NotebookLM `chat.ask` — authoritative synthesized answer (the quality path) | seconds | always |
| **L3 fallback** | on L4 timeout/rate-limit/error, return the top **verbatim** manual passages (grounded) instead of an apology | ~1 ms | `NOTEBOOKLM_LOCAL_FALLBACK` |

The L3 BM25 index is built once in the background after the warm client is up
(one `get_fulltext` RPC per source; pure-Python, no ML dependency). L2/L3 are
hallucination-free: L2 reuses a verified NotebookLM answer for the same question;
L3 returns the manual's own words, clearly labelled as direct excerpts.

> The bearer token is a shared secret that blocks anonymous traffic; it is **not**
> per-user auth (a browser token isn't truly secret). For production, put a real
> per-user identity layer (OAuth/session) in front and mint short-lived tokens.
> The rate limiter is in-memory + per-worker (use Redis across workers); it keys
> on the real socket IP unless `TRUST_FORWARDED_FOR=true` (only enable behind a
> proxy you control — `X-Forwarded-For` is client-spoofable), and the tracked-IP
> set is bounded by `RATE_LIMIT_MAX_IPS`.

## Notes & limitations

- **WebXR camera pixels:** raw camera access inside an XR session is still
  fragmented across browsers, so this app intentionally uses `getUserMedia`
  for capture and WebRTC for transport, independent of XR session state.
- `notebooklm-py` wraps **undocumented** Google endpoints; treat it as
  best-effort and expect occasional breakage when Google changes things.
- **Model + API version:** defaults are `GEMINI_API_VERSION=v1alpha` and
  `GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001` (a GA, tool-capable Live model
  that boots reliably). To use a newer model set `GEMINI_LIVE_MODEL` (e.g.
  `gemini-live-2.5-flash`); if a model 404s on connect, flip `GEMINI_API_VERSION`
  to `v1beta`. Plain `gemini-2.5-flash` is **not** a Live model. If your model
  rejects the typed `realtimeInput.audio`/`.video` fields, set
  `GEMINI_USE_MEDIA_CHUNKS=true` for the legacy format.
- **Loop affinity:** `NotebookLMClient` is bound to its open-time event loop and
  is not thread-safe. The whole app runs on one asyncio loop and the RAG client
  is opened/used/closed within a single coroutine on that loop — compliant by
  construction. Do not move it to a thread pool or a second loop.
- Video is forwarded at `VIDEO_FPS` (default 1 fps) to keep latency/cost low —
  ample for step-by-step visual guidance. Raise it in `.env` if needed.
- **World-anchored 6DoF markers** (`web/src/components/WorldMarkers.tsx`) render
  only inside an active `immersive-ar` session and are strictly additive — the 2D
  screen-space `AnnotationOverlay` is the universal baseline on every device, so
  phones / display glasses / desktop are unaffected. Each marker captures its
  world position once from the headset pose (world-locked) and best-effort
  promotes to a real `XRAnchor`; if hit-test/anchors are unsupported it falls back
  to the captured point. Build- and type-verified here; spatial accuracy is tuned
  on the headset (the box→world projection uses approximate FOV constants).
- **Frontend bundle:** the 3D stack (`three` / r3f / xr / uikit / drei) is
  code-split and lazy-loaded, so first paint (camera feed + 2D HUD) ships in a
  tiny entry chunk and the WebGL bundle streams in after. The WebXR **emulator**
  (and its multi-MB synthetic room meshes) is enabled only in dev
  (`emulate: import.meta.env.DEV`), so a real headset never downloads it.
- TURN relay and shared-token auth are built in (see **Security & operations**);
  before production use, add a per-user identity layer and per-session notebook
  selection.
