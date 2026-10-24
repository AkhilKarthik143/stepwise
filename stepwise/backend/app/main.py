"""STEPWISE backend entrypoint — FastAPI app with the realtime WebSocket bridge.

Routes:
  * ``GET  /healthz``                 — liveness.
  * ``GET  /api/config``              — non-secret runtime config for the frontend.
  * ``GET  /api/schematics/{file}``   — serve the bundled labeled SVG schematics.
  * ``WS   /ws``                      — the realtime field-console bridge.
  * ``GET  /cloud/health``            — Alibaba Cloud OSS + DashScope proof (Stage G).
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.data.catalog import catalog
from app.data.catalog import SCHEMATICS_DIR
from app.realtime.cartesia import CartesiaTTS, CartesiaUnavailable
from app.realtime.connectors import connector_status
from app.ws.gateway import RealtimeBridge, voice_modes

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("stepwise")

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Log the runtime posture. STEPWISE runs locally with only DASHSCOPE_API_KEY set —
    Alibaba Cloud OSS/ECS credentials are OPTIONAL and only enable the cloud-asset
    fetch and the OSS half of /cloud/health. Nothing here touches the network."""
    if settings.realtime_configured:
        logger.info("Realtime ready: model=%s region=%s", settings.realtime_model, settings.region)
    else:
        logger.warning(
            "DASHSCOPE_API_KEY is not set — the voice loop is disabled until you add it to "
            "backend/.env. The backend, /healthz, /api/config, schematics, and the frontend "
            "still run normally."
        )
    if settings.oss_configured:
        logger.info("OSS configured: bucket=%s endpoint=%s", settings.oss_bucket, settings.oss_endpoint)
    else:
        logger.info(
            "OSS not configured — this is OPTIONAL for local dev. Cloud asset fetch and the OSS "
            "section of /cloud/health are disabled; everything else runs with only DASHSCOPE_API_KEY."
        )
    yield


app = FastAPI(
    title="STEPWISE",
    version="0.1.0",
    description="Field Operations Real-time Guidance Engine",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    # Served same-origin with no cookie/credential auth — keep credentials OFF so a wildcard
    # origins list ("*") stays valid (browsers reject "*" + allow_credentials=True).
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Alibaba Cloud proof router (OSS + cloud health). Optional so the app boots even
# before cloud creds are wired.
try:  # pragma: no cover - exercised at deploy time
    from app.cloud.alibaba import router as cloud_router

    app.include_router(cloud_router)
except Exception as exc:  # noqa: BLE001
    logger.info("cloud router not mounted: %s", exc)


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "stepwise",
        "realtime_configured": settings.realtime_configured,
        "model": settings.realtime_model,
        "region": settings.region,
        "connectors": connector_status(),
        "agent_provider": settings.agent_provider,
        "claude_configured": settings.claude_configured,
        "cartesia_configured": settings.cartesia_configured,
        "moss_configured": settings.moss_configured,
        "mock_mode": not settings.claude_configured or settings.agent_provider == "mock",
    }


@app.get("/api/config")
def api_config() -> dict[str, object]:
    """Non-secret config the frontend needs (audio rates, asset, vision dims)."""
    return {
        "asset_id": catalog.default_asset_id,
        "input_sample_rate": settings.input_sample_rate,
        "output_sample_rate": settings.output_sample_rate,
        "vision": {"width": 320, "height": 240, "fps": 1, "screen": {"width": 768, "height": 768}},
        "session_max_seconds": settings.session_resume_after_seconds,
        "providers": {
            "agent": "claude" if settings.agent_provider == "claude" and settings.claude_configured else "mock",
            "claude_configured": settings.claude_configured,
            "cartesia_configured": settings.cartesia_configured,
            "moss_configured": settings.moss_configured,
            "vision": "claude" if settings.claude_configured else "local",
            "voice_in": voice_modes(settings)[0],
            "voice_out": voice_modes(settings)[1],
        },
    }


@app.get("/api/schematics/{file}", response_model=None)
def schematic(file: str) -> FileResponse | JSONResponse:
    # Serve only bundled SVGs; reject anything that isn't a plain .svg basename.
    if "/" in file or "\\" in file or not file.endswith(".svg"):
        return JSONResponse({"error": "not found"}, status_code=404)
    path = SCHEMATICS_DIR / file
    if not path.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(path, media_type="image/svg+xml")


@app.get("/api/tts", response_model=None)
async def tts(text: str) -> Response | JSONResponse:
    """Cartesia Sonic as a WAV file, for the mobile app. 503 means use on-device speech."""
    text = text.strip()[:1200]
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    try:
        audio = await CartesiaTTS(settings.cartesia_api_key, settings.cartesia_voice_id, settings.cartesia_tts_model).wav(text)
    except CartesiaUnavailable:
        return JSONResponse({"error": "cartesia not configured"}, status_code=503)
    except Exception as exc:  # noqa: BLE001
        logger.warning("tts failed: %r", exc)
        return JSONResponse({"error": "tts failed"}, status_code=502)
    return Response(audio, media_type="audio/wav")


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    bridge = RealtimeBridge(websocket)
    await bridge.run()


# Serve the built field console (single-container deploy). API/WS routes above take
# precedence; this SPA mount (html=True) catches everything else. Set STEPWISE_FRONTEND_DIST
# or place the build at ../frontend/dist.
_dist = Path(os.environ.get("STEPWISE_FRONTEND_DIST", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")
    logger.info("serving frontend from %s", _dist)
else:
    logger.info("frontend dist not found at %s (dev mode serves it via Vite)", _dist)

