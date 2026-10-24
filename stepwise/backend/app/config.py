"""STEPWISE configuration, loaded from environment / backend/.env.

All secrets come from env vars — nothing is committed. The realtime endpoint is
built from the region + model so a single constant change re-targets the model
(the international endpoint serves qwen3-omni-flash-realtime / qwen-omni-turbo-realtime;
the China endpoint also serves qwen3.5-omni-plus-realtime).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Realtime WebSocket endpoints per region (DashScope / Model Studio).
_WS_ENDPOINTS = {
    "intl": "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime",
    "cn": "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
}
_DASHSCOPE_REGION = {"intl": "ap-southeast-1 (Singapore)", "cn": "cn-beijing"}
# OpenAI-compatible REST base per region (for the off-loop diagnostic text agent).
_COMPAT_ENDPOINTS = {
    "intl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "cn": "https://dashscope.aliyuncs.com/compatible-mode/v1",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"), env_file_encoding="utf-8", extra="ignore"
    )

    # ── Qwen Cloud / DashScope ───────────────────────────────────────────────
    dashscope_api_key: str = Field(default="", alias="DASHSCOPE_API_KEY")
    region: str = Field(default="intl", alias="STEPWISE_REGION")
    # qwen3.5-omni-plus-realtime has full tool support (the older flash variant's is
    # limited). Available on the international endpoint.
    realtime_model: str = Field(
        default="qwen3.5-omni-plus-realtime", alias="STEPWISE_REALTIME_MODEL"
    )
    # Voice for qwen3.5-omni-*-realtime (Cherry is flash/turbo-only and is rejected on
    # plus). Valid plus voices include Tina (default), Ethan, Serena, Dylan, Sunny, …
    voice: str = Field(default="Tina", alias="STEPWISE_VOICE")

    # Turn detection: "server_vad" (broadly supported) or "semantic_vad" (qwen3.5+).
    vad_type: str = Field(default="server_vad", alias="STEPWISE_VAD_TYPE")

    # ── Background diagnostic agent (off the realtime loop) ───────────────────
    # A SEPARATE Qwen TEXT model (OpenAI-compatible chat-completions) that reasons over the
    # grounded telemetry/fault context to produce a structured diagnosis. Not the voice model.
    diagnostic_model: str = Field(default="qwen-plus", alias="STEPWISE_DIAGNOSTIC_MODEL")
    diagnostic_timeout_s: float = Field(default=20.0, alias="STEPWISE_DIAGNOSTIC_TIMEOUT_S")

    # Realtime tool registration shape: "flat" ({type,name,description,parameters},
    # OpenAI-Realtime style) or "nested" ({type,function:{...}}). The session.updated echo
    # (logged at startup) tells you which the server accepted.
    tools_format: str = Field(default="flat", alias="STEPWISE_TOOLS_FORMAT")
    # Only sent when set (an unsupported field can nullify tool registration).
    tool_choice: str = Field(default="", alias="STEPWISE_TOOL_CHOICE")
    # Dump every raw realtime event to the log for protocol debugging.
    debug_events: bool = Field(default=False, alias="STEPWISE_DEBUG_EVENTS")

    # ── Provider-independent STEPWISE runtime ───────────────────────────────────
    agent_provider: str = Field(default="claude", alias="STEPWISE_PROVIDER")
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    anthropic_model: str = Field(default="claude-sonnet-4-5-20250929", alias="STEPWISE_ANTHROPIC_MODEL")
    cartesia_api_key: str = Field(default="", alias="CARTESIA_API_KEY")
    cartesia_voice_id: str = Field(default="6ccbfb76-1fc6-48f7-b71d-91ac6298247b", alias="CARTESIA_VOICE_ID")
    cartesia_tts_model: str = Field(default="sonic-latest", alias="CARTESIA_TTS_MODEL")
    cartesia_stt_model: str = Field(default="ink-2", alias="CARTESIA_STT_MODEL")
    # BuildSight: Sonnet checks each step live, Opus reads manuals once (scripts/ingest_manual.py).
    # Public deployments: passcode for the whole site, and Azure Application Insights.
    app_passcode: str = Field(default="", alias="APP_PASSCODE")
    appinsights_connection_string: str = Field(default="", alias="APPLICATIONINSIGHTS_CONNECTION_STRING")
    check_model: str = Field(default="claude-sonnet-5-5", alias="STEPWISE_CHECK_MODEL")
    check_effort: str = Field(default="low", alias="STEPWISE_CHECK_EFFORT")
    ingest_model: str = Field(default="claude-opus-5-5", alias="STEPWISE_INGEST_MODEL")
    # Below this confidence a step check asks for a closer look instead of judging.
    check_min_confidence: float = Field(default=0.7, alias="STEPWISE_CHECK_MIN_CONFIDENCE")
    moss_project_id: str = Field(default="", alias="MOSS_PROJECT_ID")
    moss_project_key: str = Field(default="", alias="MOSS_PROJECT_KEY")
    moss_index_name: str = Field(default="stepwise-maintenance", alias="MOSS_INDEX_NAME")

    # Audio formats (Qwen-Omni-Realtime: input 16 kHz, output 24 kHz PCM16 mono;
    # the wire format value is "pcm").
    input_sample_rate: int = 16000
    output_sample_rate: int = 24000

    # ── Alibaba Cloud OSS (assets + deployment proof) ────────────────────────
    alibaba_cloud_access_key_id: str = Field(
        default="", alias="ALIBABA_CLOUD_ACCESS_KEY_ID"
    )
    alibaba_cloud_access_key_secret: str = Field(
        default="", alias="ALIBABA_CLOUD_ACCESS_KEY_SECRET"
    )
    oss_bucket: str = Field(default="", alias="OSS_BUCKET")
    oss_endpoint: str = Field(default="", alias="OSS_ENDPOINT")
    oss_region: str = Field(default="", alias="OSS_REGION")

    # ── Server ───────────────────────────────────────────────────────────────
    host: str = Field(default="0.0.0.0", alias="STEPWISE_HOST")
    port: int = Field(default=8000, alias="STEPWISE_PORT")
    # e.g. https://buildsight.*\.vercel\.app to also allow Vercel preview deployments.
    allowed_origin_regex: str = Field(default="", alias="STEPWISE_ALLOWED_ORIGIN_REGEX")
    allowed_origins: str = Field(
        default="http://localhost:5173,http://127.0.0.1:5173",
        alias="STEPWISE_ALLOWED_ORIGINS",
    )

    # Realtime session auto-closes near 120 min; resume a bit before that.
    session_resume_after_seconds: int = 115 * 60

    # ── Derived ──────────────────────────────────────────────────────────────
    @property
    def realtime_ws_url(self) -> str:
        base = _WS_ENDPOINTS.get(self.region, _WS_ENDPOINTS["intl"])
        return f"{base}?model={self.realtime_model}"

    @property
    def dashscope_region(self) -> str:
        return _DASHSCOPE_REGION.get(self.region, self.region)

    @property
    def compat_base_url(self) -> str:
        """OpenAI-compatible REST base for the diagnostic text agent (same key, by region)."""
        return _COMPAT_ENDPOINTS.get(self.region, _COMPAT_ENDPOINTS["intl"])

    @property
    def realtime_configured(self) -> bool:
        return bool(self.dashscope_api_key)

    @property
    def claude_configured(self) -> bool:
        return bool(self.anthropic_api_key)

    @property
    def cartesia_configured(self) -> bool:
        return bool(self.cartesia_api_key)

    @property
    def moss_configured(self) -> bool:
        return bool(self.moss_project_id and self.moss_project_key and self.moss_index_name)

    @property
    def oss_configured(self) -> bool:
        return bool(
            self.alibaba_cloud_access_key_id
            and self.alibaba_cloud_access_key_secret
            and self.oss_bucket
            and self.oss_endpoint
        )

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
