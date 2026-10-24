# Frontend (v2) — React + react-three-fiber + WebXR + uikit

Premium, hardware-agnostic AR UI for the technician assistant. Built with Vite;
the output is deployed into `../static/` so the existing FastAPI server serves it
with **no backend change** (`/` → `static/index.html`, `/static/*` → built assets;
Vite `base` is `/static/`).

## Stack
- **React 19 + TypeScript**
- **@react-three/fiber 9** — declarative Three.js
- **@react-three/xr 6** — WebXR sessions (`createXRStore` / `store.enterAR()`)
- **@react-three/uikit 1** — GPU-rendered spatial UI panels (the in-AR HUD)
- **@react-three/drei 10** — helpers (Billboard/Text for world markers)

The glowing/pulsing annotation look is pure CSS (`src/styles.css` `ann-pulse`
keyframes + box-shadow stacks). `@react-three/postprocessing` is installed in
`package.json` but currently **unused** — nothing in `src/` imports it.

## Capability tiers (hardware-agnostic — Goal 3)
`src/lib/capabilities.ts` detects the best mode the device supports, one codebase:
- **T0-hud** — 2D DOM HUD over the camera feed (XREAL Air / Rokid / phones / laptops). Universal baseline, voice-first.
- **T1-3dof** — defined in the `Tier` type for orientation-only devices, but
  detection currently resolves only T0 or T2 (no UA sniffing for 3DoF glasses).
- **T2-6dof** — WebXR immersive-ar + hit-test/anchors → world-locked component markers (Quest 3).

## Spatial annotations (Step 3)
Gemini calls the `annotate_component(label, detail, box, shape, level, step)`
tool when it references a physical part. Those calls ride a **WebRTC data
channel** (`useWebRTC` creates the `events` channel; the backend
`PeerSession.send_event` pushes JSON) and become auto-expiring `Annotation`s.
`AnnotationOverlay` draws a **glowing, pulsing outline + label/value chip** over
the camera view, positioned from the box (`[ymin, xmin, ymax, xmax]`, normalized
0-1000 — Gemini's spatial convention). Presentation args:

- **`shape`** — `box` outlines the part (default); `point` drops a precise pin at
  the box centre (single screw / LED); `arrow` points at a target that's hard to box.
- **`level`** — severity styling: `info` (green, default), `warn` (amber),
  `danger` (red), with non-color glyphs so severity survives color blindness.
- **`step`** — optional 1-based number shown as a badge for ordered procedures.

A companion **`clear_annotations(label?)`** tool removes one highlight (by label)
or all of them, so the view stays uncluttered as work proceeds. Every annotation
also survives expiry into the right-edge **history rail**
(`AnnotationHistory.tsx`, "Marks (N)") — tapping an entry re-injects the mark for
another full TTL.

The 2D screen-space `AnnotationOverlay` is the **universal baseline** on every
tier (T0 and a screen-locked layer in AR). On **T2** devices inside an active
`immersive-ar` session, `WorldMarkers.tsx` additionally **world-locks** each
annotation: a viewer-space hit-test estimates surface distance, the box centre is
projected to a world point captured once from the headset pose, and the marker is
best-effort promoted to a real `XRAnchor` (with a fixed-distance fallback when
hit-test/anchors are unsupported).

The `events` channel is **bidirectional**: alongside server→client annotation,
caption, status, and activity events, the client sends `{"type": "user_text"}`
frames upstream (the typed-text fallback below), validated server-side in
`main.py` `_handle_client_message` and length-capped by `USER_TEXT_MAX_CHARS`.

## Session UX
- **Live captions + two-sided transcript** (`CaptionBar.tsx`) — the backend
  forwards `transcript` / `transcript_done` data-channel events (backed by
  `GEMINI_OUTPUT_TRANSCRIPTION` + `GEMINI_INPUT_TRANSCRIPTION`, both default
  true). The assistant's speech becomes a bottom-center caption line; the
  technician's own speech appears as timestamped "You" turns, so they can verify
  the AI heard "M8", not "N8".
- **Typed text input** — a "Type" pill in the HUD opens an input row for loud
  environments; messages ride the events channel as `user_text` frames and show
  up as "You" transcript turns. Typed input counts as session activity for the
  server's idle reaper.
- **Mic controls** (`Hud2D.tsx` + `useWebRTC` analysers) — mute/unmute toggle
  (the `m` key works too, wired in `App.tsx`), a blinking MIC OFF badge, a live
  5-segment mic level meter, and a "NO MIC SIGNAL" warning after sustained
  unmuted silence.
- **Session summary export** (`SessionSummaryModal.tsx`) — pressing End opens a
  summary (duration, turns, marked components, full conversation) with Copy and
  Download-.txt buttons.
- **Reconnect/status UX** — the backend pushes `status` events
  (`reconnecting` / `connected` / `ended` with a reason), and the hook's
  `ConnState` includes `reconnecting`; failures render human-readable messages
  with a Retry button.
- **Screen wake lock** (`lib/useWakeLock.ts`) — keeps the display awake while
  the session is connected/reconnecting.
- **ICE config fetch** — the client fetches `/ice-config` with auth headers
  (when a token is set) and falls back to plain STUN if it gets a 401.

## Develop
```bash
cd web
npm install
npm run dev          # http://localhost:5173 ; proxies /offer + /health + /ice-config to :8443
```
Run the FastAPI backend (`python main.py`) alongside for signaling.

## Build + deploy into static/
```bash
cd web
bash deploy.sh       # vite build -> preserves v1 under web/legacy/ -> copies dist/ into ../static/
# (or: npm run build, then copy dist/* into ../static/)
```
Then start the backend and open `http://localhost:8443/`.

## Layout
```
web/
├── index.html
├── vite.config.ts          base=/static/, dev proxy to :8443
├── src/
│   ├── main.tsx
│   ├── App.tsx             tier detection + XR store + WebRTC wiring + hotkeys
│   ├── styles.css          premium dark HUD (incl. CSS annotation glow/pulse)
│   ├── lib/
│   │   ├── capabilities.ts T0/T1/T2 detection
│   │   ├── useWebRTC.ts    hardened connect flow (ported from v1) as a hook
│   │   └── useWakeLock.ts  screen wake lock while connected
│   └── components/
│       ├── Scene.tsx        r3f Canvas + <XR> + uikit in-AR HUD
│       ├── Hud2D.tsx        2D DOM HUD (T0 baseline + controls + text input)
│       ├── AnnotationOverlay.tsx  2D screen-space highlights (all tiers)
│       ├── WorldMarkers.tsx       T2 world-anchored 6DoF markers (in AR)
│       ├── AnnotationHistory.tsx  "Marks" rail — tap to recall a highlight
│       ├── CaptionBar.tsx         live captions + two-sided transcript
│       ├── SessionSummaryModal.tsx end-of-session summary (copy/download)
│       └── CameraBackground.tsx   camera feed behind the HUD
└── legacy/                 the v1 vanilla frontend, preserved for reference
```
