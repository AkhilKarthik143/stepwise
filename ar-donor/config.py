"""
Central configuration loader.

Reads `.env` once at import time and exposes typed settings plus the system
prompt and tool schema. Every module imports from here so there is a single
source of truth for environment-driven behavior.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os

from dotenv import load_dotenv

# Load .env from the project root into os.environ (does NOT override real env).
load_dotenv()


def _get_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def _get_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        return default


def _get_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


# ============================================================================
# Gemini Multimodal Live API
# ============================================================================
GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()

# Live (bidiGenerateContent) model. MUST be a Live-capable model id.
#   gemini-2.0-flash-live-001            -> GA, half-cascade, robust tool calling (default)
#   gemini-live-2.5-flash                -> newer half-cascade (best for tools)
#   gemini-live-2.5-flash-native-audio   -> native-audio (best voice, tools more limited)
#   gemini-2.0-flash-exp                 -> classic v1alpha experimental
# Plain "gemini-2.5-flash" is NOT a Live model — it has no bidiGenerateContent.
GEMINI_LIVE_MODEL: str = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001").strip()

# API version segment of the websocket host. The brief specifies v1alpha;
# some GA models are also reachable on v1beta. Override if your model 404s.
GEMINI_API_VERSION: str = os.getenv("GEMINI_API_VERSION", "v1alpha").strip()

# Text/vision CHAT model (separate from the live voice session) — a standard
# multimodal model used by the /chat endpoint. Image GENERATION model used by
# /generate-image (Gemini's "image" model, aka Nano Banana). Both use the same
# GEMINI_API_KEY. Override the names if your key targets different model ids.
GEMINI_CHAT_MODEL: str = os.getenv("GEMINI_CHAT_MODEL", "gemini-2.5-flash").strip()
GEMINI_IMAGE_MODEL: str = os.getenv("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image").strip()
GEMINI_CHAT_MAX_TOKENS: int = max(128, _get_int("GEMINI_CHAT_MAX_TOKENS", 1024))

# Prebuilt TTS voice (half-cascade models). e.g. Puck, Charon, Kore, Fenrir, Aoede
GEMINI_VOICE: str = os.getenv("GEMINI_VOICE", "Puck").strip()

# Optional BCP-47 speech language (e.g. "de-DE", "es-ES", "ja-JP"). Empty (the
# default) omits the field entirely — the setup frame stays byte-identical to
# the verified English behavior. Set it to run sessions in another language.
GEMINI_LANGUAGE_CODE: str = os.getenv("GEMINI_LANGUAGE_CODE", "").strip()

# Realtime-input wire format. The current API uses typed `audio`/`video` fields;
# older/experimental models may require the legacy `mediaChunks` list. Flip this
# to true if your chosen model rejects the typed fields.
GEMINI_USE_MEDIA_CHUNKS: bool = _get_bool("GEMINI_USE_MEDIA_CHUNKS", False)

# Auto-reconnect the Gemini Live session on drop / goAway / time-limit, keeping
# the WebRTC connection alive (a long field job shouldn't lose the assistant).
GEMINI_RECONNECT: bool = _get_bool("GEMINI_RECONNECT", True)
GEMINI_MAX_RECONNECTS: int = _get_int("GEMINI_MAX_RECONNECTS", 5)
GEMINI_RECONNECT_BACKOFF: float = _get_float("GEMINI_RECONNECT_BACKOFF", 1.0)
# Use Gemini session-resumption handles for context continuity across reconnects.
GEMINI_SESSION_RESUMPTION: bool = _get_bool("GEMINI_SESSION_RESUMPTION", True)
# Treat a session as "healthy" (reset the reconnect backoff/attempt counter) only
# after it has stayed up this long — stops a setup-then-instant-drop flap from
# reconnecting forever at the backoff floor.
GEMINI_MIN_HEALTHY_SECONDS: float = _get_float("GEMINI_MIN_HEALTHY_SECONDS", 10.0)

# Ask Gemini to transcribe its own spoken output (BidiGenerateContent
# `outputAudioTranscription`). Drives live captions + the session transcript on
# the client. Flip to false to revert to voice-only (no setup-frame field).
GEMINI_OUTPUT_TRANSCRIPTION: bool = _get_bool("GEMINI_OUTPUT_TRANSCRIPTION", True)
# Also transcribe the TECHNICIAN's speech (`inputAudioTranscription`) so the
# session transcript is two-sided — the user can verify the AI heard "M8", not
# "N8". Flip to false to record only the assistant's side.
GEMINI_INPUT_TRANSCRIPTION: bool = _get_bool("GEMINI_INPUT_TRANSCRIPTION", True)

# Max characters accepted for a typed user message arriving over the WebRTC data
# channel (the loud-environment text fallback). Oversized input is dropped.
USER_TEXT_MAX_CHARS: int = max(1, _get_int("USER_TEXT_MAX_CHARS", 2000))

# Gemini speaks 24 kHz PCM16; it accepts realtime audio at 16 kHz PCM16.
GEMINI_INPUT_SAMPLE_RATE = 16_000
GEMINI_OUTPUT_SAMPLE_RATE = 24_000

# Fully-qualified BidiGenerateContent websocket host (key appended at connect).
GEMINI_WS_HOST: str = (
    "wss://generativelanguage.googleapis.com/ws/"
    f"google.ai.generativelanguage.{GEMINI_API_VERSION}"
    ".GenerativeService.BidiGenerateContent"
)


# ============================================================================
# NotebookLM RAG
# ============================================================================
# If NOTEBOOKLM_HOME is provided, push it into the environment so notebooklm-py
# (which reads it directly) picks it up regardless of import order.
_NB_HOME = os.getenv("NOTEBOOKLM_HOME", "").strip()
if _NB_HOME:
    os.environ["NOTEBOOKLM_HOME"] = _NB_HOME
NOTEBOOKLM_HOME: str = _NB_HOME
NOTEBOOKLM_STORAGE: str = os.getenv("NOTEBOOKLM_STORAGE", "").strip()
NOTEBOOKLM_PROFILE: str = os.getenv("NOTEBOOKLM_PROFILE", "").strip()


def _materialize_notebook_storage() -> str:
    """Headless NotebookLM auth. `notebooklm login` writes a Playwright
    storage_state.json on a desktop; a server has no browser. So allow injecting
    that file's CONTENT as the env var NOTEBOOKLM_STORAGE_STATE_JSON — we write it
    to disk here (before the client initializes) and point NOTEBOOKLM_STORAGE at
    it. Using stored cookies needs no browser at runtime (httpx + the cookies).

    Best-effort: returns the path written, or "" on any failure (the app then
    runs without NotebookLM, exactly as before). The cookies EXPIRE — re-export
    periodically — and this is an UNOFFICIAL path; treat the JSON as a secret (it
    grants NotebookLM access as that Google account)."""
    raw = os.getenv("NOTEBOOKLM_STORAGE_STATE_JSON", "").strip()
    if not raw:
        return ""
    dest = NOTEBOOKLM_STORAGE or os.path.join(
        _NB_HOME or os.path.expanduser("~/.notebooklm"),
        "profiles",
        NOTEBOOKLM_PROFILE or "default",
        "storage_state.json",
    )
    try:
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(raw)
        return dest
    except OSError:
        return ""


_NB_MATERIALIZED = _materialize_notebook_storage()
if _NB_MATERIALIZED and not NOTEBOOKLM_STORAGE:
    NOTEBOOKLM_STORAGE = _NB_MATERIALIZED  # point the client at the injected file
ACTIVE_NOTEBOOK_ID: str = os.getenv("ACTIVE_NOTEBOOK_ID", "").strip()
# NotebookLM's FIRST query on a notebook is a cold start (observed ~40-45s);
# warm follow-ups are far faster. Default generous so a cold start doesn't fail.
NOTEBOOKLM_TIMEOUT_SECONDS: float = _get_float("NOTEBOOKLM_TIMEOUT_SECONDS", 90.0)
# Ceiling on concurrent LIVE NotebookLM round-trips server-wide. A single Gemini
# toolCall frame can carry several query_technical_manual calls (now dispatched
# concurrently); this bounds the fan-out so it can't trip NotebookLM's rate limit
# or spike load. Cache hits and instant tools never count against it.
NOTEBOOKLM_MAX_CONCURRENT_LOOKUPS: int = _get_int("NOTEBOOKLM_MAX_CONCURRENT_LOOKUPS", 4)

# Resolve fuller citation context via get_fulltext() + find_citation_context()
# (per the notebooklm SKILL.md: `cited_text` is often only a snippet/header).
# OFF by default — it adds one RPC per cited source. Enable for richer grounding.
NOTEBOOKLM_RESOLVE_CITATIONS: bool = _get_bool("NOTEBOOKLM_RESOLVE_CITATIONS", False)
# Cap how many citations are included in the grounding block handed to Gemini.
# Clamp to >= 0: a negative value would invert the list slice (raw[:-n]) and
# silently drop grounding instead of capping it.
NOTEBOOKLM_MAX_CITATIONS: int = max(0, _get_int("NOTEBOOKLM_MAX_CITATIONS", 5))

# --- v2 speed: warm singleton client + L1 cache + pre-warm -------------------
# Keep ONE long-lived NotebookLMClient (repo-recommended production pattern) to
# skip per-call connect/auth setup. Falls back to per-call clients if unset/failed.
NOTEBOOKLM_WARM_CLIENT: bool = _get_bool("NOTEBOOKLM_WARM_CLIENT", True)
# Cookie keepalive for the long-lived client (seconds; 0 = disabled). When > 0,
# the client periodically refreshes Google cookies so an unattended worker
# doesn't stale out. Values below 60s are clamped up by the library.
NOTEBOOKLM_KEEPALIVE_SECONDS: float = _get_float("NOTEBOOKLM_KEEPALIVE_SECONDS", 0.0)
# L1 exact-match answer cache (normalized query -> answer).
NOTEBOOKLM_CACHE_TTL_SECONDS: float = _get_float("NOTEBOOKLM_CACHE_TTL_SECONDS", 300.0)
NOTEBOOKLM_CACHE_MAXSIZE: int = max(0, _get_int("NOTEBOOKLM_CACHE_MAXSIZE", 256))
# Pre-warm: fire a throwaway query so the notebook's cold start happens up front.
NOTEBOOKLM_PREWARM: bool = _get_bool("NOTEBOOKLM_PREWARM", True)
NOTEBOOKLM_PREWARM_QUERY: str = os.getenv(
    "NOTEBOOKLM_PREWARM_QUERY", "Briefly, what equipment or topic does this manual cover?"
).strip()

# --- v2 speed L2: near-duplicate answer cache (token-cosine over prior queries).
# A high threshold means only strong paraphrases of the SAME question reuse an
# answer; different questions fall through to the live lookup. 0 disables.
NOTEBOOKLM_SIMILARITY_CACHE: bool = _get_bool("NOTEBOOKLM_SIMILARITY_CACHE", True)
NOTEBOOKLM_SIMILARITY_THRESHOLD: float = _get_float("NOTEBOOKLM_SIMILARITY_THRESHOLD", 0.86)
NOTEBOOKLM_SIMILARITY_MAXSIZE: int = max(0, _get_int("NOTEBOOKLM_SIMILARITY_MAXSIZE", 128))

# --- v2 speed L3: local BM25 index over the notebook's source fulltext.
# Built once in the background after the warm client is up (one get_fulltext RPC
# per source). Used as a grounded *fallback* when NotebookLM times out / errors,
# and (optionally) as a fast path when a query matches the manual very strongly.
NOTEBOOKLM_LOCAL_INDEX: bool = _get_bool("NOTEBOOKLM_LOCAL_INDEX", True)
# Return top local manual passages (verbatim, grounded) instead of an apology
# when the live NotebookLM call times out / is rate-limited / errors.
NOTEBOOKLM_LOCAL_FALLBACK: bool = _get_bool("NOTEBOOKLM_LOCAL_FALLBACK", True)
# Aggressive: answer straight from the local index (skipping the slow NotebookLM
# call) when the top BM25 score clears the bar below. OFF by default — the quality
# path is NotebookLM's synthesis; this trades some quality for latency.
NOTEBOOKLM_LOCAL_FAST_PATH: bool = _get_bool("NOTEBOOKLM_LOCAL_FAST_PATH", False)
NOTEBOOKLM_LOCAL_FAST_PATH_MIN_SCORE: float = _get_float(
    "NOTEBOOKLM_LOCAL_FAST_PATH_MIN_SCORE", 12.0
)
# How many local passages to return, and the index size cap (bounds memory + scan).
# The cap is clamped to >= 1 so it is always a real bound (a value of 0 would make
# the index UNBOUNDED — the opposite of a cap). To disable L3 entirely, set
# NOTEBOOKLM_LOCAL_INDEX=false rather than zeroing the cap.
NOTEBOOKLM_LOCAL_PASSAGES: int = max(1, _get_int("NOTEBOOKLM_LOCAL_PASSAGES", 3))
NOTEBOOKLM_INDEX_MAX_CHUNKS: int = max(1, _get_int("NOTEBOOKLM_INDEX_MAX_CHUNKS", 2000))


# ============================================================================
# Media tuning
# ============================================================================
VIDEO_FPS: float = _get_float("VIDEO_FPS", 1.0)            # Gemini Live: <= 1 fps
VIDEO_MAX_WIDTH: int = _get_int("VIDEO_MAX_WIDTH", 768)
VIDEO_JPEG_QUALITY: int = _get_int("VIDEO_JPEG_QUALITY", 70)


# ============================================================================
# HTTP(S) server
# ============================================================================
HOST: str = os.getenv("HOST", "0.0.0.0").strip()
PORT: int = _get_int("PORT", 8443)
SSL_CERTFILE: str = os.getenv("SSL_CERTFILE", "").strip()
SSL_KEYFILE: str = os.getenv("SSL_KEYFILE", "").strip()

# Public STUN server for NAT traversal.
STUN_URL: str = os.getenv("STUN_URL", "stun:stun.l.google.com:19302").strip()

# TURN relay for real-world NAT traversal (STUN alone fails on locked-down /
# symmetric-NAT networks common in factories). Set all three to enable.
TURN_URL: str = os.getenv("TURN_URL", "").strip()
TURN_USERNAME: str = os.getenv("TURN_USERNAME", "").strip()
TURN_CREDENTIAL: str = os.getenv("TURN_CREDENTIAL", "").strip()


# ============================================================================
# NVIDIA-hosted VLM recognizer (build.nvidia.com — commercial, no local GPU)
# ============================================================================
# A specialized vision model used as a detector/OCR from images: identifies
# equipment/parts and reads labels + model/part numbers. OpenAI-compatible API
# at integrate.api.nvidia.com. Optional — the app runs fine without it. Get an
# nvapi- key at https://build.nvidia.com/settings/api-keys.
NVIDIA_API_KEY: str = os.getenv("NVIDIA_API_KEY", "").strip()
NVIDIA_VLM_MODEL: str = os.getenv(
    "NVIDIA_VLM_MODEL", "meta/llama-3.2-90b-vision-instruct"
).strip()
NVIDIA_VLM_MAX_TOKENS: int = max(64, _get_int("NVIDIA_VLM_MAX_TOKENS", 512))
NVIDIA_VLM_TIMEOUT_SECONDS: float = _get_float("NVIDIA_VLM_TIMEOUT_SECONDS", 45.0)

# Upper bound on an uploaded/base64 image body (chat + recognize). A phone photo
# base64-encodes to a few MB; 16 MB leaves headroom without allowing abuse.
MAX_IMAGE_BYTES: int = max(64 * 1024, _get_int("MAX_IMAGE_BYTES", 16 * 1024 * 1024))


# ============================================================================
# Security / limits (v2 hardening)
# ============================================================================
# Comma-separated allowed CORS origins; "*" = open (dev). Lock down for prod.
ALLOWED_ORIGINS: list[str] = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()
] or ["*"]
# Max concurrent live sessions before /offer returns 429 (cost/DoS guard).
MAX_SESSIONS: int = _get_int("MAX_SESSIONS", 25)
# Per-client-IP /offer requests allowed per 60s window (0 disables).
RATE_LIMIT_PER_MIN: int = _get_int("RATE_LIMIT_PER_MIN", 30)
# Max accepted /offer request body size in bytes (a valid SDP offer is a few KiB).
MAX_OFFER_BYTES: int = _get_int("MAX_OFFER_BYTES", 262_144)  # 256 KiB
# Optional bearer token required on /offer. Empty = no auth (dev default).
# When set, clients must send `Authorization: Bearer <token>` or `X-API-Key: <token>`.
API_AUTH_TOKEN: str = os.getenv("API_AUTH_TOKEN", "").strip()


def _load_auth_users() -> dict:
    """Email (lowercased) -> password hash, from AUTH_USERS_JSON:
    [{"email": "...", "hash": "pbkdf2_sha256$<iters>$<salt_hex>$<hash_hex>"}].
    Empty by default (no login). Passwords are NEVER stored in plaintext."""
    raw = os.environ.get("AUTH_USERS_JSON", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    out: dict = {}
    if isinstance(parsed, list):
        for entry in parsed:
            if not isinstance(entry, dict):
                continue
            email = str(entry.get("email") or "").strip().lower()
            digest = str(entry.get("hash") or "").strip()
            if email and digest:
                out[email] = digest
    return out


def _load_auth_companies() -> dict:
    """Email (lowercased) -> company id, from the same AUTH_USERS_JSON entries'
    optional "company" field. Users without one belong to "default". Company ids
    are slugged (lowercase alnum + dash/underscore) — they name per-tenant data
    directories, so they must be filesystem-safe."""
    raw = os.environ.get("AUTH_USERS_JSON", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    out: dict = {}
    if isinstance(parsed, list):
        for entry in parsed:
            if not isinstance(entry, dict):
                continue
            email = str(entry.get("email") or "").strip().lower()
            company = str(entry.get("company") or "default").strip().lower()
            company = "".join(c for c in company if c.isalnum() or c in "-_") or "default"
            if email:
                out[email] = company
    return out


# Email -> pbkdf2 hash. When set together with API_AUTH_TOKEN, the /login endpoint
# verifies credentials and hands back a signed per-user token (which gates /offer
# etc. and carries the user's company for per-tenant data scoping).
AUTH_USERS: dict = _load_auth_users()
AUTH_COMPANIES: dict = _load_auth_companies()
AUTH_ENABLED: bool = bool(API_AUTH_TOKEN and AUTH_USERS)

# Root for ALL persistent per-company data (solution memory DBs + photos).
# In Docker this is volume-mounted (deploy/docker-compose.yml) so data survives
# rebuilds. Layout: DATA_DIR/tenants/<company>/solutions.db + photos/.
DATA_DIR: str = os.getenv("DATA_DIR", "data").strip() or "data"


def _dummy_pbkdf2_iters() -> int:
    """Iteration count for the unknown-user dummy hash. Matched to the SLOWEST
    configured user so an unknown email never returns faster than a known one
    (the enumeration-timing oracle the dummy exists to close). Falls back to a
    modern default when no parseable hash is configured."""
    best = 0
    for digest in AUTH_USERS.values():
        try:
            scheme, iters, _salt, _hash = digest.split("$")
            if scheme == "pbkdf2_sha256":
                best = max(best, int(iters))
        except (ValueError, TypeError):
            continue
    return best or 200_000


_DUMMY_PBKDF2_ITERS: int = _dummy_pbkdf2_iters()


def verify_login(email: str, password: str) -> bool:
    """Constant-time check of an email + password against AUTH_USERS. Never raises;
    returns False for unknown users / malformed hashes / bad input."""
    if not isinstance(email, str) or not isinstance(password, str) or not password:
        return False
    stored = AUTH_USERS.get(email.strip().lower())
    if not stored:
        # Dummy hash at the slowest configured user's cost so an unknown email
        # doesn't return measurably faster than a known one (enumeration timing).
        hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), b"x" * 16, _DUMMY_PBKDF2_ITERS)
        return False
    try:
        scheme, iters, salt_hex, hash_hex = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(derived.hex(), hash_hex)
    except (ValueError, TypeError):
        return False
# Only honor the X-Forwarded-For header (for client IP) when behind a trusted
# proxy — otherwise it's client-spoofable (rate-limit bypass + memory growth).
TRUST_FORWARDED_FOR: bool = _get_bool("TRUST_FORWARDED_FOR", False)
# Cap the number of distinct client IPs the rate limiter tracks (bounds memory).
RATE_LIMIT_MAX_IPS: int = max(1, _get_int("RATE_LIMIT_MAX_IPS", 10_000))
# Session lifecycle bounds: an abandoned headset must not hold a MAX_SESSIONS
# slot + a live Gemini connection forever (capacity + cost leak).
# Max wall-clock seconds per session (0 disables).
SESSION_MAX_SECONDS: float = _get_float("SESSION_MAX_SECONDS", 14_400.0)  # 4h
# Reap after this long with NO inbound media frames at all (0 disables).
SESSION_IDLE_SECONDS: float = _get_float("SESSION_IDLE_SECONDS", 300.0)  # 5min


# ============================================================================
# System prompt + tool schema
# ============================================================================
SYSTEM_INSTRUCTION: str = (
    "You are an expert technical assistant guiding a field technician in real "
    "time. You see the physical equipment through the technician's AR-glasses "
    "camera and hear them through their microphone. Guide them step-by-step, "
    "one concise instruction at a time, and confirm what you see before moving "
    "on. Keep spoken replies short and unambiguous — the technician's hands are "
    "busy. If you lack specific measurements, torque specifications, schematics, "
    "part numbers, or error-code procedures, YOU MUST invoke the "
    "query_technical_manual tool rather than guessing. Never fabricate a value; "
    "cite the manual when you provide one. "
    "Whenever you direct the technician to a specific physical component they "
    "should look at (a bolt, connector, gauge, lever, warning light, etc.), call "
    "annotate_component with its label, an optional short value/spec, and its "
    "bounding box from the camera image — this draws a highlight on it in their "
    "view. Annotate the component in the same turn you talk about it. "
    "Make highlights precise and informative: set 'box' as a TIGHT box around the "
    "exact part (not the whole machine). Choose 'shape': 'box' to outline a part, "
    "'point' for a small target like a single screw or LED (a precise pin), or "
    "'arrow' to point at something hard to box. Set 'level' to 'danger' for "
    "hazards / hot / live / do-not-touch, 'warn' for caution, otherwise 'info'. "
    "When you give an ordered procedure, set 'step' to the 1-based step number so "
    "the technician sees them numbered. Call clear_annotations (with a label to "
    "remove one, or no label to clear all) once a step is done or a marked part is "
    "no longer relevant, so the view stays uncluttered. "
    "If the technician asks you to take, save, or capture a photo/picture/snapshot "
    "of what they're seeing, call take_snapshot — it saves the current camera view "
    "with your highlights to their device (their hands may be gloved or busy). "
    "When a fix is hard to convey in words — how parts fit together, an "
    "orientation, a bolt/torque pattern, the direction of flow or rotation, or a "
    "wiring/circuit layout — call show_model to draw it: mode '3d' for spatial "
    "assemblies (orbitable) or '2d' for flat schematics, built from labelled "
    "primitive shapes. Then talk them through what they're looking at, and call "
    "clear_model when it is no longer needed. To point at a part of a diagram you "
    "already drew WITHOUT redrawing it (redrawing resets the technician's "
    "orbit/zoom), call highlight_model_part with the part's exact legend label(s) "
    "so it glows as you talk about it; pass an empty list to stop emphasizing. "
    "To walk them through a sequence (assembly/disassembly/repair order), give the "
    "parts a 'step' number in show_model and call set_diagram_step as you talk "
    "through each step — the current step glows and later steps dim; pass 0 to "
    "show the whole diagram again. For a 2d schematic, you may pass an 'anchor' "
    "box (same coordinates as annotate_component) to PIN it over the spot on the "
    "equipment it explains, instead of the side panel. "
    "MAKE DIAGRAMS GENUINELY DETAILED — combine the features, never draw bare "
    "unlabelled boxes. Example (3D pump): a translucent housing (material 'glass', "
    "opacity 0.3) revealing an EXPLODED impeller, shaft and seal offset along the "
    "axis, each with a short 'note' (e.g. seal: 'replace if cracked'); the "
    "retaining bolt as material 'metal' with a 'swing' animate about its head "
    "'pivot' to mime unscrewing, a 'spec' like [Torque: 25 Nm], and a 'warning' if "
    "it is hot or live. In 2D schematics use 'dimension' shapes for clearances and "
    "'dashed' for hidden/internal lines. Label EVERY part: an unlabelled-box "
    "diagram is a failure — use notes, colour, materials, dimensions, animation "
    "and specs so the diagram teaches on its own."
)

# Function declaration advertised to Gemini in the `setup` frame. The proto
# Schema.Type enum is upper-case (OBJECT/STRING); this is the most broadly
# accepted form over the raw websocket.
QUERY_TOOL_NAME = "query_technical_manual"
QUERY_TOOL_DECLARATION: dict = {
    "name": QUERY_TOOL_NAME,
    "description": (
        "Look up authoritative technical information from the equipment's "
        "service manual / knowledge base: torque specifications, schematics, "
        "wiring diagrams, error-code meanings, part numbers, and step-by-step "
        "procedures. Use this whenever you need an exact, verifiable value or "
        "an official procedure instead of relying on memory."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "query": {
                "type": "STRING",
                "description": (
                    "A precise natural-language question for the manual, e.g. "
                    "'What is the torque spec for the M8 head bolts on the "
                    "XR-200 pump?' or 'What does error code E-45 mean and how "
                    "do I clear it?'"
                ),
            }
        },
        "required": ["query"],
    },
}

# Spatial-annotation tool: the model calls this to highlight a physical component
# in the technician's view. Its args ride a WebRTC data channel to the client,
# which draws a glowing marker + label/value chip. Box is normalized 0-1000 as
# [ymin, xmin, ymax, xmax] — the convention Gemini's spatial output uses.
ANNOTATE_SHAPES = ("box", "point", "arrow")
ANNOTATE_LEVELS = ("info", "warn", "danger")

ANNOTATE_TOOL_NAME = "annotate_component"
ANNOTATE_TOOL_DECLARATION: dict = {
    "name": ANNOTATE_TOOL_NAME,
    "description": (
        "Visually highlight a physical component in the technician's AR view. "
        "Call this whenever you reference a specific part they should look at so "
        "it is outlined and labelled in their display. Provide a TIGHT bounding "
        "box around the exact part as seen in the camera image, normalized 0-1000 "
        "as [ymin, xmin, ymax, xmax]."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "label": {
                "type": "STRING",
                "description": "Short component name, e.g. 'M8 head bolt' or 'E-45 warning light'.",
            },
            "detail": {
                "type": "STRING",
                "description": "Optional short value/spec to show on the chip, e.g. '25 N·m' or 'reset for 5s'.",
            },
            "box": {
                "type": "ARRAY",
                "description": "TIGHT bounding box normalized 0-1000 as [ymin, xmin, ymax, xmax].",
                "items": {"type": "NUMBER"},
            },
            "shape": {
                "type": "STRING",
                "enum": list(ANNOTATE_SHAPES),
                "description": (
                    "How to mark it: 'box' outlines the part (default); 'point' drops a "
                    "precise pin at the box centre for a small target (a single screw/LED); "
                    "'arrow' points at the target when it is hard to box."
                ),
            },
            "level": {
                "type": "STRING",
                "enum": list(ANNOTATE_LEVELS),
                "description": (
                    "Severity colour: 'danger' (red) for hazards / hot / live / do-not-touch, "
                    "'warn' (amber) for caution, 'info' (green, default) otherwise."
                ),
            },
            "step": {
                "type": "INTEGER",
                "description": "Optional 1-based step number for an ordered procedure (shows a numbered badge).",
            },
        },
        "required": ["label", "box"],
    },
}

# Hands-free snapshot: the model calls this when the technician ASKS for a photo
# ("save a picture of this") — gloved hands can't tap the Snap button. The event
# rides the data channel; the client captures the camera frame + live marks.
TAKE_SNAPSHOT_TOOL_NAME = "take_snapshot"
TAKE_SNAPSHOT_TOOL_DECLARATION: dict = {
    "name": TAKE_SNAPSHOT_TOOL_NAME,
    "description": (
        "Save a photo of the technician's current camera view (including any "
        "highlights you have drawn) to their device. Call this when they ask "
        "you to take/save a photo, picture, or snapshot of what they're seeing."
    ),
    "parameters": {"type": "OBJECT", "properties": {}},
}

# Solution-model tool: the model BUILDS an explanatory 3D assembly (or 2D
# schematic) out of labelled primitives and shows it in a floating viewer the
# technician can orbit. Works for ANY equipment — no pre-built CAD library —
# because the AI composes the diagram from shapes. Args ride the data channel.
MODEL_MODES = ("3d", "2d")
MODEL_3D_SHAPES = ("box", "cylinder", "sphere", "cone", "torus", "arrow", "plane")
MODEL_2D_SHAPES = ("rect", "circle", "line", "arrow", "text", "dimension")
MODEL_COLORS = ("info", "warn", "danger", "accent", "metal", "steel", "dark", "light")
MODEL_MAX_PARTS = 40
# Per-part explanatory note (what the part is / what to do with it). Longer than
# the short `label` (a name) — this is where the instructional detail lives.
MODEL_NOTE_MAX = 140
# 3D-only PBR material presets. Decoupled from colour (so e.g. a 'metal' part can
# be any tint); the renderer maps each to metalness/roughness/clearcoat/opacity.
MODEL_MATERIALS = ("metal", "plastic", "rubber", "glass", "painted")
# Floor for a see-through part so a housing can't be made fully invisible.
MODEL_OPACITY_MIN = 0.05
# Looping motion primitives that DEMONSTRATE an action (3D). The renderer plays
# them continuously; 'swing' rotates about an optional pivot (e.g. scissor blades).
MODEL_ANIM_TYPES = ("spin", "swing", "slide", "pulse")
MODEL_AXES = ("x", "y", "z")
MODEL_ANIM_SPEED_MIN = 0.1
MODEL_ANIM_SPEED_MAX = 4.0
# Tap-a-part spec sheet (interactive depth): key facts + a safety warning shown
# when the technician taps the part or its legend entry.
MODEL_SPEC_MAX_ROWS = 6
MODEL_SPEC_LABEL_MAX = 32
MODEL_SPEC_VALUE_MAX = 64
MODEL_WARNING_MAX = 140


def _load_model_assets() -> dict:
    """Operator-supplied catalog of pre-built 3D models (GLTF/GLB) keyed by id:
    {"<id>": {"url": "...", "title": "..."}}. Set MODEL_ASSETS_JSON to a JSON
    object to populate it. EMPTY by default — show_model then draws from
    primitives as before. Malformed JSON degrades to empty (never crashes)."""
    raw = os.environ.get("MODEL_ASSETS_JSON", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    out: dict = {}
    for key, entry in parsed.items():
        if not (isinstance(key, str) and isinstance(entry, dict)):
            continue
        url = entry.get("url")
        if not (isinstance(url, str) and url.strip()):
            continue  # a non-string / empty url is malformed — drop the entry
        out[key.strip()] = {
            "url": url.strip(),
            "title": str(entry.get("title") or key).strip()[:80],
        }
    return out


# assetId -> {"url", "title"}. Validated against this catalog server-side; an
# unknown id falls back to the primitive diagram. URLs are sent to the browser
# as-is — host them same-origin for offline/field use.
MODEL_ASSETS: dict = _load_model_assets()

def _show_model_asset_hint() -> str:
    """assetId field help — lists the operator-configured models when any exist,
    so the AI can pick one; otherwise just explains the option."""
    base = (
        "Optional (3D). If a pre-built model of THIS equipment exists, set its id "
        "to display the real model — your shapes then overlay it as labelled "
        "call-outs. Omit to draw the whole thing from primitives."
    )
    if MODEL_ASSETS:
        catalog = ", ".join(f"'{k}' ({v.get('title', k)})" for k, v in MODEL_ASSETS.items())
        return f"{base} Available pre-built models: {catalog}."
    return base


SHOW_MODEL_TOOL_NAME = "show_model"
SHOW_MODEL_TOOL_DECLARATION: dict = {
    "name": SHOW_MODEL_TOOL_NAME,
    "description": (
        "Show the technician an explanatory diagram so they can SEE the solution, "
        "not just hear it. You compose it from labelled primitive shapes — you are "
        "NOT limited to a parts library. Use mode '3d' for anything spatial (how "
        "parts assemble, a component's orientation, a bolt/torque pattern, the "
        "direction of flow or rotation, clearances); use mode '2d' for flat "
        "schematics (wiring, hydraulic/pneumatic circuits, flow charts, "
        "before/after). Call this whenever words alone are hard to follow, then "
        "talk them through it. "
        "MAKE EVERY DIAGRAM DETAILED ENOUGH TO STAND ON ITS OWN: "
        "(1) LABEL every part with its real name, and add a short 'note' saying "
        "what it is or what to do with it (e.g. 'M8 bolt — torque to 25 Nm', "
        "'inlet — fuel enters here'). "
        "(2) Use REALISTIC relative proportions and positions so it matches the "
        "real thing. "
        "(3) For an ASSEMBLY, prefer an EXPLODED view — offset parts along the axis "
        "they separate so each is visible and the order is obvious. "
        "(4) Use COLOUR with meaning: 'danger'=hazard/do-not, 'warn'=caution/check, "
        "'accent'=the part in focus, 'info'=normal, 'metal'/'steel'=metal "
        "structure, 'dark'/'light'=housing/background. "
        "(5) For a SEQUENCE (assembly/disassembly/repair order), give parts a "
        "'step' number and walk through them with set_diagram_step. "
        "(6) Put the single key takeaway in the 'caption'. "
        "(7) In 2D, use a 'dimension' shape to call out a measurement or "
        "clearance (its label is the value, e.g. '25 mm'), and set 'dashed': true "
        "for hidden, internal, or reference geometry. "
        "(8) In 3D, set 'material' (metal/plastic/rubber/glass/painted) for a "
        "realistic finish, and lower 'opacity' (e.g. 0.3) to make a housing or "
        "cover see-through so the parts inside it are visible. "
        "(9) To DEMONSTRATE a motion (unscrewing, a lever, sliding a part in/out, "
        "scissors cutting; in 2D a switch toggling, a valve opening, flow along a "
        "line), give the part an 'animate' — it loops so the technician can watch "
        "the action; use 'swing' with a 'pivot' for anything hinged (scissor "
        "blades pivot at the joint). Works in both 2D and 3D. "
        "(10) Attach hard data the technician can TAP for: a 'spec' (rows of key "
        "facts — torque, size, part number, capacity) and/or a 'warning' (a safety "
        "caution). They appear when the part (or its legend entry) is tapped. "
        "(11) GET THE DETAILS RIGHT — a diagram that is spatially or physically "
        "wrong misleads the technician: for an EXPLODED view, separate the parts "
        "along ONE axis with visible gaps (never give two parts the same "
        "position); keep proportions realistic and fit internal parts INSIDE "
        "their container (a shaft must not poke through its housing); parts of one "
        "rigid body (a handle and its blade, a lever and its arm) must share the "
        "SAME 'animate' axis and direction; and a part's 'label' and 'note' must "
        "never contradict each other. "
        "(12) When the technician asks to SEE something, point to WHERE, or be "
        "WALKED THROUGH it, DRAW it with show_model even if you also look a value "
        "up — look up the number AND show the dimension / stepped diagram in the "
        "same turn; don't answer a 'show me' with a lookup alone. "
        "Each part has a shape, position, size, optional rotation (degrees), a "
        "colour, a short label, an optional explanatory note, an optional 2D "
        "'dashed' flag, optional 3D 'material' + 'opacity', and an optional "
        "'animate'."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "mode": {
                "type": "STRING",
                "enum": list(MODEL_MODES),
                "description": "'3d' for an orbitable assembly, '2d' for a flat schematic.",
            },
            "title": {
                "type": "STRING",
                "description": "Short title for the diagram, e.g. 'Manifold bolt order' or 'Relay wiring'.",
            },
            "caption": {
                "type": "STRING",
                "description": "Optional one-line explanation shown under the diagram.",
            },
            "parts": {
                "type": "ARRAY",
                "description": "The shapes that make up the diagram (a few to a couple dozen).",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "shape": {
                            "type": "STRING",
                            "description": (
                                "3d: box, cylinder, sphere, cone, torus, arrow, plane. "
                                "2d: rect, circle, line, arrow, text, dimension "
                                "(a measurement/clearance call-out — label is the value)."
                            ),
                        },
                        "position": {
                            "type": "ARRAY",
                            "items": {"type": "NUMBER"},
                            "description": "3d: [x, y, z] model units. 2d: [x, y] as 0-100 percent.",
                        },
                        "size": {
                            "type": "ARRAY",
                            "items": {"type": "NUMBER"},
                            "description": (
                                "3d: dimensions/radii per shape. 2d: [w, h] (rect) / [r] "
                                "(circle) / [dx, dy] to the end point (line, arrow, dimension)."
                            ),
                        },
                        "rotation": {
                            "type": "ARRAY",
                            "items": {"type": "NUMBER"},
                            "description": "Optional rotation in degrees. 3d: [x, y, z]. 2d: [deg].",
                        },
                        "color": {
                            "type": "STRING",
                            "enum": list(MODEL_COLORS),
                            "description": "Palette colour: info/warn/danger/accent or metal/steel/dark/light.",
                        },
                        "label": {
                            "type": "STRING",
                            "description": "Short NAME for this part (shown in the legend / on 2d text).",
                        },
                        "note": {
                            "type": "STRING",
                            "description": (
                                "Optional short explanation of what this part is or what to "
                                "do with it — e.g. 'M8 bolt — torque to 25 Nm' or 'inlet — "
                                "fuel enters here'. Shown in the legend and on the focused "
                                "part. This is where the useful detail lives; add it for "
                                "every part that isn't self-evident."
                            ),
                        },
                        "dashed": {
                            "type": "BOOLEAN",
                            "description": (
                                "Optional (2D). Draw this part with a dashed stroke to show "
                                "hidden, internal, or reference geometry (vs a solid visible "
                                "edge)."
                            ),
                        },
                        "material": {
                            "type": "STRING",
                            "enum": list(MODEL_MATERIALS),
                            "description": (
                                "Optional (3D). Surface finish for realism: 'metal' (brushed "
                                "metal), 'plastic' (glossy), 'rubber' (matte), 'glass' "
                                "(clear, see-through), 'painted' (semi-gloss). Independent of "
                                "colour."
                            ),
                        },
                        "opacity": {
                            "type": "NUMBER",
                            "description": (
                                "Optional (3D), 0-1. Make a part see-through (e.g. a housing "
                                "or cover) so the components inside it are visible. 1 = solid "
                                "(default)."
                            ),
                        },
                        "spec": {
                            "type": "ARRAY",
                            "description": (
                                "Optional. Key technical facts shown when the technician TAPS "
                                "this part (or its legend entry): torque, size, part number, "
                                "capacity, gap, etc. A few rows of label + value."
                            ),
                            "items": {
                                "type": "OBJECT",
                                "properties": {
                                    "label": {"type": "STRING", "description": "Fact name, e.g. 'Torque'."},
                                    "value": {"type": "STRING", "description": "Fact value, e.g. '25 Nm'."},
                                },
                                "required": ["label", "value"],
                            },
                        },
                        "warning": {
                            "type": "STRING",
                            "description": (
                                "Optional. A short SAFETY caution for this part (e.g. 'Hot "
                                "surface — let cool' or 'Live terminal — isolate first'). Shown "
                                "prominently when the technician opens the part from the legend."
                            ),
                        },
                        "animate": {
                            "type": "OBJECT",
                            "description": (
                                "Optional (2D or 3D). Loop a motion on this part to DEMONSTRATE "
                                "an action (unscrewing, a lever, sliding a connector out, "
                                "scissors cutting; or in 2D a switch toggling, a valve opening, "
                                "flow along a line). It plays continuously so the technician can "
                                "watch it."
                            ),
                            "properties": {
                                "type": {
                                    "type": "STRING",
                                    "enum": list(MODEL_ANIM_TYPES),
                                    "description": (
                                        "'spin' = continuous rotation about the axis (drill, "
                                        "fan, turning bolt); 'swing' = rotate back and forth by "
                                        "'amount' degrees about the axis, pivoting at 'pivot' "
                                        "(hinge, lever, scissor blade, wrench); 'slide' = move "
                                        "back and forth by 'amount' units along the axis "
                                        "(insert/extract, piston); 'pulse' = gently grow/shrink "
                                        "to draw the eye."
                                    ),
                                },
                                "axis": {
                                    "type": "STRING",
                                    "enum": list(MODEL_AXES),
                                    "description": "Axis of the motion (x/y/z). Default y.",
                                },
                                "amount": {
                                    "type": "NUMBER",
                                    "description": (
                                        "Motion size: degrees for 'swing', model units for "
                                        "'slide', a 0-1 scale fraction for 'pulse'. Ignored for "
                                        "'spin'."
                                    ),
                                },
                                "speed": {
                                    "type": "NUMBER",
                                    "description": "Relative speed (0.1-4, default 1).",
                                },
                                "pivot": {
                                    "type": "ARRAY",
                                    "items": {"type": "NUMBER"},
                                    "description": (
                                        "Optional [x, y, z] offset from the part centre for the "
                                        "rotation pivot of 'swing'/'spin' (e.g. a scissor blade "
                                        "pivots at the joint, not its middle). Ignored for "
                                        "slide/pulse. Default: the part centre."
                                    ),
                                },
                            },
                            "required": ["type"],
                        },
                        "step": {
                            "type": "INTEGER",
                            "description": (
                                "Optional 1-based sequence step this part belongs to, for "
                                "step-by-step playback (assembly/disassembly/repair order). "
                                "Omit for always-present scaffolding shown at every step. Then "
                                "use set_diagram_step to walk the technician through the steps."
                            ),
                        },
                    },
                    "required": ["shape"],
                },
            },
            "anchor": {
                "type": "OBJECT",
                "description": (
                    "Optional, mode '2d' ONLY: pin the diagram OVER the camera view at "
                    "the spot on the equipment it explains, instead of the side panel. "
                    "Use the same coordinates as annotate_component."
                ),
                "properties": {
                    "box": {
                        "type": "ARRAY",
                        "items": {"type": "NUMBER"},
                        "description": (
                            "TIGHT bounding box of the spot to pin over, normalized 0-1000 "
                            "as [ymin, xmin, ymax, xmax] (same convention as annotate_component)."
                        ),
                    },
                },
                "required": ["box"],
            },
            "assetId": {
                "type": "STRING",
                "description": _show_model_asset_hint(),
            },
        },
        "required": ["mode", "title", "parts"],
    },
}

CLEAR_MODEL_TOOL_NAME = "clear_model"
CLEAR_MODEL_TOOL_DECLARATION: dict = {
    "name": CLEAR_MODEL_TOOL_NAME,
    "description": (
        "Hide the explanatory diagram shown by show_model once it is no longer "
        "needed, so it doesn't block the technician's view."
    ),
    "parameters": {"type": "OBJECT", "properties": {}},
}

HIGHLIGHT_MODEL_TOOL_NAME = "highlight_model_part"
HIGHLIGHT_MODEL_TOOL_DECLARATION: dict = {
    "name": HIGHLIGHT_MODEL_TOOL_NAME,
    "description": (
        "Emphasize one or more parts of the diagram you ALREADY drew with "
        "show_model, by their exact legend label(s), so they glow while you talk "
        "about them. This does NOT redraw the diagram, so the technician keeps "
        "their current orbit/zoom and framing. Pass an empty list to clear all "
        "emphasis. Has no effect until a diagram is shown; labels that don't "
        "match a part are ignored."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "labels": {
                "type": "ARRAY",
                "items": {"type": "STRING"},
                "description": "Exact legend labels of the parts to emphasize. Empty list clears emphasis.",
            }
        },
        "required": ["labels"],
    },
}

SET_DIAGRAM_STEP_TOOL_NAME = "set_diagram_step"
SET_DIAGRAM_STEP_TOOL_DECLARATION: dict = {
    "name": SET_DIAGRAM_STEP_TOOL_NAME,
    "description": (
        "Walk the technician through the diagram STEP BY STEP. Give parts a 'step' "
        "number in show_model, then call this with the step you're currently on: "
        "that step's parts glow while later steps dim, so the technician sees the "
        "order to do things WITHOUT redrawing (their orbit/zoom is preserved). "
        "Advance as you talk ('now step 2…'). Pass 0 to turn playback off and show "
        "the whole diagram. Has no effect until a stepped diagram is shown."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "step": {
                "type": "INTEGER",
                "description": "The current 1-based step to focus, or 0 to show the whole diagram.",
            }
        },
        "required": ["step"],
    },
}

# Companion tool: remove highlights so the view stays uncluttered as work proceeds.
ANNOTATE_CLEAR_TOOL_NAME = "clear_annotations"
ANNOTATE_CLEAR_TOOL_DECLARATION: dict = {
    "name": ANNOTATE_CLEAR_TOOL_NAME,
    "description": (
        "Remove component highlights from the technician's view. Call this when a "
        "step is finished or a previously marked part is no longer relevant. Pass "
        "'label' to remove just that highlight, or omit it to clear ALL highlights."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "label": {
                "type": "STRING",
                "description": "Exact label of the highlight to remove. Omit to clear all highlights.",
            }
        },
        "required": [],
    },
}

# All tools advertised to Gemini in the setup frame.
TOOL_DECLARATIONS: list[dict] = [
    QUERY_TOOL_DECLARATION,
    ANNOTATE_TOOL_DECLARATION,
    ANNOTATE_CLEAR_TOOL_DECLARATION,
    TAKE_SNAPSHOT_TOOL_DECLARATION,
    SHOW_MODEL_TOOL_DECLARATION,
    CLEAR_MODEL_TOOL_DECLARATION,
    HIGHLIGHT_MODEL_TOOL_DECLARATION,
    SET_DIAGRAM_STEP_TOOL_DECLARATION,
]


def validate(strict: bool = False) -> list[str]:
    """Return a list of human-readable configuration problems."""
    problems: list[str] = []
    if not GEMINI_API_KEY:
        problems.append("GEMINI_API_KEY is not set (.env).")
    if not ACTIVE_NOTEBOOK_ID:
        problems.append("ACTIVE_NOTEBOOK_ID is not set (.env) — RAG tool calls will fail.")
    if strict and problems:
        raise RuntimeError("Configuration error:\n  - " + "\n  - ".join(problems))
    return problems
