# ── BuildSight — one image: the built web app + the FastAPI backend ─────────────
# Build from this folder:  docker build -t buildsight .   (or: az containerapp up --source .)
# Stage 1: build the React app (also served here, so the backend URL works on its own).
FROM node:20-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Python backend that serves the API/WebSocket and the built console.
FROM python:3.12-slim AS backend
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY backend/requirements.txt backend/requirements-optional.txt ./
# Optional SDKs (Claude, Cartesia, Moss, PDF/image tools) — without them the backend runs in demo mode.
RUN pip install --no-cache-dir -r requirements.txt -r requirements-optional.txt

COPY backend/app ./app
COPY --from=frontend /frontend/dist ./frontend_dist
ENV STEPWISE_FRONTEND_DIST=/app/frontend_dist

# Long-lived WebSocket sessions: a single worker (sticky realtime session per conn),
# generous timeouts, WS protocol enabled.
# Railway and Render pass the port in $PORT; 8000 otherwise.
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --ws websockets --timeout-keep-alive 75 --proxy-headers --forwarded-allow-ips '*'"]
