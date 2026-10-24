# BuildSight — Decisions Log

Running record of every product and technical decision, newest at the bottom of each section.
Feeds the README, the Devpost write-up, and the demo script. Add a line whenever something changes.

Format: **Decision** — why. *(date, PT)*

---

## Product

- **Build a hands-free build copilot, not a repair copilot.** You show it any picture-based instructions; it watches you build through the camera, tells you what's next, and catches mistakes. — Building moves forward naturally (no faked faults), the instructions-as-input design makes it general, and a caught mistake is a stronger demo moment than naming a part. *(Sat Oct 24, ~1 AM)*
- **Dropped earlier ideas:** FixSight bike repair (story didn't match the factory pitch; purchase step felt forced) and desktop-PC repair (practical but uninspiring). *(Sat Oct 24, ~1 AM)*
- **Target user: frontline workers following work instructions with their hands busy** (assembly lines, kitting, field installs, new hires). LEGO and IKEA are stand-ins judges can watch. *(Sat Oct 24, ~1 AM)*
- **Working name: BuildSight.** Easy to change. *(Sat Oct 24, ~1 AM)*

## Demo

- **Main prop: a small LEGO set (100–250 pieces), bright colors, mostly larger bricks. No Technic** (grey pins and beams look alike on camera). *(Sat Oct 24, ~1 AM)*
- **Second prop: a small IKEA piece** (4–8 steps) to prove it isn't LEGO-specific. *(Sat Oct 24, ~1:30 AM)*
- **Demo beats:** guide the next step → catch a deliberate mistake (side-by-side with the manual picture) → switch to the IKEA build by voice. *(Sat Oct 24, ~1 AM)*
- **Camera is fixed overhead on a stand over a plain white mat,** not chest-mounted. — A fixed view makes every frame comparable to the manual picture. *(Sat Oct 24, ~1 AM)*
- **Voice plays through a table speaker** so judges hear it; a live transcript is shown on screen. *(Sat Oct 24, ~1 AM)*

## Platform

- **Website, not an app-store app.** One Next.js codebase runs in the phone's browser and on a laptop; it can be added to the phone's home screen. — No separate builds or store approval, and the demo looks the same. *(Sat Oct 24, ~1:15 AM)*
- **Demo setup: phone as overhead camera, laptop as the big screen,** paired with a room code or QR. *(Sat Oct 24, ~1:15 AM)*
- **Stack:** Next.js 16 + React 19 + TypeScript + Tailwind on Vercel; three.js via react-three-fiber for 3D; Motion for animation. *(Sat Oct 24, ~1:30 AM)*
- **Phone ↔ laptop real-time link: Azure Web PubSub** (Vercel functions can't hold a live socket; also keeps Microsoft in the build). *Not built yet.* *(Sat Oct 24, ~1:15 AM)*
- ~~Speech to text: Azure AI Speech~~ **Voice in and out: Cartesia. Telemetry: Azure Application Insights.** Built Sat evening, see Voice below. *(Sat Oct 24, ~1:15 AM; updated ~8 PM)*

## AI

- **Claude through OpenRouter** (team has an OpenRouter key). Models: `anthropic/claude-sonnet-5.5` for live checks and questions, `anthropic/claude-opus-5.5` for reading manuals once. Model is set by `OPENROUTER_MODEL`. *(Sat Oct 24, ~1:30 AM)*
- **Step checks compare the camera frame to the manual's own picture for that step** (plus the previous step's), instead of asking the model to work out the build from scratch. Output: `step_complete`, `confidence`, `issues[]`. Below 0.7 confidence it asks for a closer look. *(Sat Oct 24, ~1 AM)*
- **Manuals are turned into step records once** (parts, action, expected picture, things to watch for), and a person approves them. *(Sat Oct 24, ~1 AM)*
- **Simple commands (next, back, repeat) skip the model** for sub-second replies. *(Sat Oct 24, ~1 AM)*
- **Claude is called through one helper (`src/lib/claude.ts`) using the official Anthropic SDK when `ANTHROPIC_API_KEY` is set; OpenRouter is the fallback.** Model `claude-sonnet-5-5`, effort `low` for speed, `max_tokens` 16000 (thinking counts toward it), no `temperature` (Sonnet 5.5 rejects non-default sampling values). Server-side refusal fallback on (`fallbacks: "default"`), so an overcautious safety decline re-runs on a fallback model instead of failing. *(Sat Oct 24, ~9 AM)*
- **Step check endpoint: `POST /api/check`** takes `frame`, `expected`, optional `previous`, `instruction`, `watchFor`; returns `step_complete`, `confidence`, `issues[]`, and a short `say` line. Temperature 0. *(Sat Oct 24, ~1:45 AM)*
- **Test manual: LEGO Creator 31163** (official PDF from lego.com, book 1, 100 pages, 1–2 steps per page with parts boxes). *(Sat Oct 24, ~1:40 AM)*
- **Stand-in test result: 10/10** (5 step pairs × finished / not yet), ~3 s per check, using manual pictures as fake camera frames. Without a test-mode note, Claude refused to call a drawing "finished" and asked for a real photo, which is the behavior we want live. **Real-photo test still needed.** *(Sat Oct 24, ~1:50 AM)*
- **Checks fire when the scene goes still** (hands out of frame ~1.5 s), detected in the browser, rather than sending every frame. *(Sat Oct 24, ~1 AM)*

## Hologram / interactive UI

- **Level 1 (building now): floating glass instruction card + a glowing blue 3D model of the next piece, and a pulsing marker roughly where it goes.** *(Sat Oct 24, ~1:15 AM)*
- **Level 2 (maybe): 3D replay of the step** using a community LDraw model of the set, if one exists for the chosen set. *(Sat Oct 24, ~1:15 AM)*
- **Level 3 (out): hologram locked onto the real bricks (true AR).** — Needs precise tracking, and iPhone Safari doesn't support WebXR AR. Roadmap only. *(Sat Oct 24, ~1:15 AM)*
- **First hologram pieces are generated in code** (bricks and plates from stud size and color) instead of loading LDraw files. — No parts library to bundle; covers most pieces in a Creator-style set. LDraw for slopes and special parts later. *(Sat Oct 24, ~1:30 AM)*
- **Practice mode (stretch, Sat evening): build with holograms only, no LEGO needed.** Drag or tap to place the glowing piece; it snaps in if right, shakes if wrong; score and timer. — Not the main product (Microsoft's track is "Built for the Real World", and it skips the camera check), but it doubles as worker training before touching the real line, lets judges try it on their own phones, and is a fallback if the camera or Wi-Fi fails. *(Sat Oct 24, ~2 AM)*
- **Marker position comes from the model as an approximate location,** not exact pixels. Fine because the camera is fixed overhead. *(Sat Oct 24, ~1:15 AM)*

## Hub and manuals

- **Home page is a hub, Jarvis-inspired HUD look** (dark navy, cyan glow, rotating rings, corner-bracket panels, Rajdhani + Geist Mono). Inspired by the style only; no Marvel names, logos or assets. *(Sat Oct 24, ~3 AM)*
- **Manual search: a 4–7 digit number searches LEGO by set number** (scraped from lego.com's building-instructions page: book names, sizes, PDFs, covers); **anything else searches IKEA** (IKEA's public product search, then each product page's assembly PDFs, keeping only PDFs named after the product, de-duplicated across color variants). *(Sat Oct 24, ~3 AM)*
- **Hub organized into three tabs: LEGO, IKEA, My projects,** with category chips (LEGO themes; IKEA Tables & desks / Storage / Seating / Beds / Kids). *(Sat Oct 24, ~10 AM)*
- **Browsable catalog: ~100 LEGO sets across 13 themes (newest 8 per theme) and ~37 IKEA products,** built by `scripts/build-catalog.mjs` into `src/data/catalog.json`. Every item is verified to have downloadable instructions; LEGO details (name, theme, age, pieces, year, product photo) come from lego.com's instructions page. The script caches what it found (`scripts/catalog-cache.json`) because lego.com throttles bursts. *(Sat Oct 24, ~10 AM)*
- **Manuals load on tap, not upfront.** The catalog stores each manual's PDF link; the PDF itself is fetched when you open it. Sets with several books open a picker. Typing filters the catalog instantly; Search still looks up anything not listed (any LEGO set number or IKEA product). *(Sat Oct 24, ~10 AM)*
- **My projects = your uploads and every manual you've opened,** with progress; a "Continue …" shortcut under the search bar resumes the latest build. *(Sat Oct 24, ~10 AM)*
- **Upload any PDF** by button or drag-and-drop anywhere on the hub. *(Sat Oct 24, ~3 AM)*
- **PDFs load through our own domain via Next.js rewrites** (`/manual-pdf/lego/…`, `/manual-pdf/ikea/…`) because browsers can't fetch them from lego.com/ikea.com directly; rewrites avoid Vercel's function size limit (LEGO books are ~20 MB). *(Sat Oct 24, ~3 AM)*
- **PDF pages render in the browser with pdf.js.** *(Sat Oct 24, ~3 AM)*
- **Library lives in the browser (IndexedDB) for now:** manual list, uploaded PDFs, reading progress, and extracted steps per page. Each device has its own library until we add shared storage (Azure Blob is the candidate). *(Sat Oct 24, ~3 AM)*
- **Steps are extracted one page at a time, when you reach it** (`POST /api/extract`, ~3.5 s/page, cached), instead of reading the whole book upfront. Pages with no steps are skipped automatically. Unnumbered steps (common in IKEA) get reading-order numbers. *(Sat Oct 24, ~3 AM)*
- **Build screen starts at the first page with steps** (or where you left off), shows the step's manual picture as a glowing "target" panel, the next part as a hologram, and a **Check build** button (also Space/Enter). A verified step auto-advances. *(Sat Oct 24, ~3 AM)*
- ~~Voice out uses the browser's built-in speech for now~~ Replaced by Cartesia, with the browser voice kept as the fallback. *(Sat Oct 24, ~3 AM; updated ~8 PM)*

## Voice and hosting (Sat Oct 24, ~8 PM)

- **Voice out: Cartesia Sonic** through `POST /api/tts` (MP3, plays on iPhone Safari). Without a Cartesia key, or if a call fails, the browser's own voice speaks instead.
- **Voice in: Cartesia Ink** (`ink-2`, realtime speech-to-text with turn detection). The browser opens Ink's websocket directly with a 10-minute, STT-only token from `POST /api/voice-token`, so audio doesn't pass through our server and the API key never reaches the browser. Without a key it falls back to the browser's speech recognition.
- **Mic button on the build screen.** "next", "back", "repeat", "check" / "is this right?" / "done", "stop" are matched in code (instant, no model call). Anything else is a question: `POST /api/ask` answers from the step's manual picture, step text, the camera and the last few exchanges, in a sentence or less. Captions show what was heard and the reply.
- **The mic ignores what it hears while the app is speaking** (sends silence to Ink), so the app never answers itself through the speaker.
- **Hosting: Azure Container Apps,** one container (`Dockerfile`, Next.js standalone server on port 8000). GitHub Actions builds the image to GHCR on every push to `stepwise`, since ACR Tasks is blocked on student subscriptions. `GET /api/health` reports which providers are live (never keys). Steps in `DEPLOY.md`.
- **Application Insights** via `@azure/monitor-opentelemetry` in `src/instrumentation.ts`, on when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set.
- **Manual PDFs are cached on the server's disk** (`src/app/manual-pdf/[...path]/route.ts`, `src/lib/pdfCache.ts`), replacing the Vercel-era rewrites. The server downloads each LEGO / IKEA PDF once and serves byte ranges from disk, so phones fetch only the pages they render instead of waiting on a ~20 MB file proxied from lego.com. The cache lasts until the container restarts.
- **Page reading and spoken answers run with thinking off** (`thinking: {type: "between_tools"}` on Sonnet 5.5): they're transcription and short replies, and thinking was most of their wait. Step checks keep thinking on, since accuracy matters most there.
- **Read pages are shared across devices:** `/api/extract` keeps each catalog manual page's steps on the server (`src/lib/stepCache.ts`), so once any phone reads a page, others get it instantly. Uploads stay per device. Lasts until the container restarts.
- **Passcode lock is back as an option:** on only when `APP_PASSCODE` is set (it is on Azure, so the public URL can't spend the keys). Unset it to remove the lock.

## Prizes

- **Primary: Microsoft "Built for the Real World" / FDE.** Also Anthropic and Cartesia, which the build covers anyway. Visa only as an optional add-on. *(Sat Oct 24, ~1 AM)*
- **Open: whether Azure is required and Microsoft's exact criteria** — ask at the booth Saturday morning. *(Sat Oct 24)*

## Rules and references

- **All code is written during the event** (Cal Hacks rule). Reference repos are used for ideas only; no code copied. *(Sat Oct 24, ~1:30 AM)*
  - [FORGE](https://github.com/kaushikchaturvedula/FORGE) — ideas: grounding tool arguments against a known catalog; verbal confirmation for safety steps; auto-written work order.
  - [AR Technician Assistant](https://github.com/omer-izhaki/-ar-technician-assistant) — ideas: AI-placed highlight markers (box / point / arrow, with severity); captions for both sides; typed input fallback for loud rooms; mic level meter; end-of-session summary.
- ~~Passcode lock on the whole site~~ **Removed** (Sat Oct 24, ~12 PM): not worth the friction for the demo. The API key still never reaches the browser; a spending limit on the Anthropic key is the safeguard. *(added ~9:30 AM)*
- **Secrets live in `.env.local`** (git-ignored) and in Azure Container Apps secrets (Vercel's environment settings if hosted there). Never committed. *(Sat Oct 24, ~1:30 AM)*

## Open questions

- [ ] Microsoft booth: Azure required? "Path to production" meaning? Credits for Claude on Foundry?
- [ ] Which LEGO set and IKEA piece; do both instruction PDFs download?
- [ ] Step-check risk test result (goal: 13 of 15 judged right).
- [ ] Team size and roles.
