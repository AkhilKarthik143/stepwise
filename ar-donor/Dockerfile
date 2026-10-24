# AR Technician Assistant — backend (FastAPI + aiortc WebRTC + Gemini Live).
#
# Why Docker (not Render's native Python runtime): the media stack pulls native
# libraries that the bare runtime often lacks — opencv needs libGL + glib, and
# aiortc/PyAV want the ffmpeg shared libs. Installing them here makes the build
# reproducible instead of "works on my machine".
#
# Render terminates TLS at its edge and injects $PORT, so the server runs plain
# HTTP inside the container. All secrets (GEMINI_API_KEY, API_AUTH_TOKEN,
# AUTH_USERS_JSON, TURN_*, ALLOWED_ORIGINS) arrive as env vars at runtime — they
# are NEVER baked into the image (.env is excluded via .dockerignore).
FROM python:3.11-slim

# Runtime native libs for opencv-python (libGL, glib) and the WebRTC/ffmpeg path.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so the layer caches across code-only changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code (see .dockerignore — no .env, .venv, node_modules, certs, .git).
COPY . .

# Render sets $PORT; default to 8443 for `docker run` locally. Bind 0.0.0.0 so
# the platform proxy can reach the app.
ENV PORT=8443
EXPOSE 8443
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8443}"]
