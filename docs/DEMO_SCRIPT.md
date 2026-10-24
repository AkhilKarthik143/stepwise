# STEPWISE AR demo script

## Launch

```bash
cd "/Users/akhilsanapala/Documents/ChatGPT/New project/stepwise/backend"
STEPWISE_PROVIDER=mock uvicorn app.main:app --reload --port 8000
```

In a second terminal:

```bash
cd "/Users/akhilsanapala/Documents/ChatGPT/New project/stepwise/frontend"
npm run dev -- --host 0.0.0.0
```

Open the Vite URL on a phone over HTTPS for camera/mic permissions. Without HTTPS, use the bundled CNC video/demo fallback or run the browser locally on the laptop.

## Five beats

1. Send `STEPWISE, what am I looking at?` using the text fallback. The mock provider calls the grounded nameplate tool and labels the answer `MOCK / STEPWISE CATALOG`.
2. Send `Show me where the spindle is.` STEPWISE validates `spindle`, opens the relevant schematic, and creates a pending camera target. Tap the spindle in the camera to confirm the box; the overlay becomes `CONFIRMED · USER TAP`.
3. Send `What should I inspect?` to show grounded faults/telemetry and the safety-aware next action.
4. Send `Walk me through it.` to start the approved drawbar inspection procedure. Use the checklist controls or text confirmations; no safety gate is skipped.
5. Send `Generate the report.` The existing report tool produces the structured work-order output.

All five beats use the real STEPWISE tool path. If live credentials are configured, the provider status changes; mock/local labels remain explicit in the UI.
