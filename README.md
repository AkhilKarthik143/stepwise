# BuildSight

Hands-free build copilot (Cal Hacks 13.0). Show it any picture-based instructions; it watches you build through the camera, tells you what's next out loud, and catches mistakes by comparing your build with the manual's own picture for that step.

All decisions: [DECISIONS.md](DECISIONS.md). Deploying: [DEPLOY.md](DEPLOY.md).

## How it works

- **Hub:** browse about 100 LEGO sets and 37 IKEA products, search any LEGO set number or IKEA product, or upload a PDF.
- **Build screen:** the camera fills the screen. Claude reads each manual page into steps as you reach it. You see the step's manual picture as a glowing target, a 3D hologram of the next part, and the step in words.
- **Check build** (button, Space, or say "check"): Claude compares the camera frame with the manual's picture for this step and the one before, then says "looks right" or what's wrong.
- **Talk to it:** tap **Mic** and say "next", "back", "repeat", "check" or "stop", or ask anything ("what color was that piece?"). Cartesia Ink hears you; Cartesia Sonic answers.

## Stack

| Piece | Tool |
|---|---|
| App | Next.js 16, React 19, TypeScript, Tailwind, Motion, three.js (react-three-fiber) |
| Step reading, checks, questions | Claude Sonnet 5.5 via the Anthropic SDK (`src/lib/claude.ts`), OpenRouter as fallback |
| Voice | Cartesia Sonic TTS (`/api/tts`) and Ink STT with turn detection (`/api/voice-token`), browser speech as fallback |
| Hosting | Azure Container Apps (`Dockerfile`), image built by GitHub Actions to GHCR |
| Telemetry | Azure Application Insights (`src/instrumentation.ts`) |
| Manual PDFs | pdf.js in the browser; LEGO and IKEA PDFs proxied through Next.js rewrites |

## Run it locally

```bash
npm install
cp .env.example .env.local   # add ANTHROPIC_API_KEY and CARTESIA_API_KEY
npm run dev                  # http://localhost:3000
```

Phones only open the camera and mic on `https://`, so use the Azure URL on a phone. `localhost` works on a laptop.

## Credits

- App by David Zhu ([davidzhu314/Calhacks](https://github.com/davidzhu314/Calhacks)); Cartesia voice and Azure deploy added on top.
- Manuals and product photos: [LEGO building instructions](https://www.lego.com/en-us/service/building-instructions) and [IKEA](https://www.ikea.com) assembly instructions, loaded live from their public pages. Not affiliated with LEGO or IKEA.
- Ideas (no code copied): [FORGE](https://github.com/kaushikchaturvedula/FORGE) (verbal confirmation gating), [AR Technician Assistant](https://github.com/omer-izhaki/-ar-technician-assistant) (captions, highlight markers, session summary), [FieldVision](https://github.com/SunnyYadav16/field-vision) (mic streaming, session report), [AI_MaintenanceAgent](https://github.com/dogaece-koca/AI_MaintenanceAgent) (manual-grounded answers), [RepairMate](https://github.com/omkar-core/RepairMate) (photo to steps).
- APIs: [Anthropic Claude](https://docs.claude.com), [Cartesia](https://docs.cartesia.ai), [Azure Container Apps](https://learn.microsoft.com/azure/container-apps/), [Application Insights](https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview).
