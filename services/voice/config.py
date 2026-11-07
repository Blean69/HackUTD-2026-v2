"""Environment -> typed settings for the voice service. Nothing secret has a default; nothing here is ever logged."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


def load_env() -> None:
    """Dev convenience: read the repo-root .env (or VOICE_ENV_FILE) without overriding real env vars. Production uses compose env_file."""
    explicit = os.environ.get("VOICE_ENV_FILE")
    candidates = [Path(explicit)] if explicit else [Path(__file__).resolve().parents[2] / ".env", Path(__file__).resolve().parent / ".env"]
    for p in candidates:
        if p.is_file():
            load_dotenv(p, override=False)


def _s(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    if v is None:
        return default
    # compose and python-dotenv strip trailing "# comments"; be tolerant when a value arrived with one anyway
    v = v.split(" #")[0].strip()
    return v if v else default


def _i(name: str, default: int) -> int:
    try:
        return int(_s(name) or default)
    except ValueError:
        return default


def _f(name: str, default: float) -> float:
    try:
        return float(_s(name) or default)
    except ValueError:
        return default


def _list(name: str, default: str = "") -> list[str]:
    return [x.strip() for x in _s(name, default).replace(";", ",").split(",") if x.strip()]


@dataclass(frozen=True)
class Settings:
    # HTTP
    host: str = "0.0.0.0"
    port: int = 7860
    public_hostname: str = "localhost"
    public_path: str = "/voice"  # where Caddy mounts this service (prefix stripped before it reaches us)
    cors_origins: list[str] = field(default_factory=lambda: ["*"])
    enabled: bool = True
    transports: list[str] = field(default_factory=lambda: ["webrtc", "twilio"])
    ice_servers: str = "stun:stun.l.google.com:19302"
    # worker
    worker_url: str = "http://127.0.0.1:8787"
    shared_secret: str = ""
    # NVIDIA
    nvidia_api_key: str = ""
    asr_server: str = "grpc.nvcf.nvidia.com:443"
    asr_function_id: str = "bb0837de-8c7b-481f-9ec8-ef5663e9c1fa"
    tts_server: str = ""  # defaults to asr_server
    tts_function_id: str = "877104f7-e885-42b9-8de8-f6e4c6303969"
    tts_voice: str = "Magpie-Multilingual.EN-US.Mia.Calm"
    llm_base_url: str = "https://integrate.api.nvidia.com/v1"
    llm_model: str = "nvidia/nemotron-3.5-lightning-30b-a3b"
    llm_api_key: str = ""
    llm_temperature: float = 0.7
    llm_top_p: float = 0.95
    llm_max_tokens: int = 110
    llm_retry_secs: float = 4.0
    # calls
    max_call_secs: int = 300
    max_sessions: int = 3
    idle_secs: int = 20
    pin_length: int = 4
    caller_hash_salt: str = ""
    known_caller_hashes: list[str] = field(default_factory=list)
    # webhook signature check on /twiml: SIGNALWIRE_SIGNING_KEY (or a Twilio auth token). Empty = skipped with a logged warning;
    # the media socket is still protected by the short-lived stream token
    signature_token: str = ""
    signalwire_number: str = ""

    @property
    def tts_grpc_server(self) -> str:
        return self.tts_server or self.asr_server

    def with_overrides(self, **kw) -> "Settings":
        from dataclasses import replace

        return replace(self, **kw)


def load_settings() -> Settings:
    http = _s("VOICE_HTTP", "0.0.0.0:7860")
    host, _, port = http.rpartition(":")
    nvidia_key = _s("NVIDIA_VOICE_API_KEY") or _s("NVIDIA_API_KEY")
    raw_path = _s("VOICE_PUBLIC_PATH", "/voice").strip("/")
    public_path = f"/{raw_path}" if raw_path else ""
    return Settings(
        host=host or "0.0.0.0",
        port=int(port) if port.isdigit() else 7860,
        public_hostname=_s("PUBLIC_HOSTNAME", "localhost"),
        public_path=public_path,
        cors_origins=_list("VOICE_CORS_ORIGINS", "*") or ["*"],
        enabled=_s("VOICE_ENABLED", "1") != "0",
        transports=[t.lower() for t in _list("VOICE_TRANSPORTS", "webrtc,twilio")],
        ice_servers=_s("PIPECAT_ICE_SERVERS", "stun:stun.l.google.com:19302"),
        worker_url=_s("WORKER_URL", "http://127.0.0.1:8787").rstrip("/"),
        shared_secret=_s("VOICE_SHARED_SECRET"),
        nvidia_api_key=nvidia_key,
        asr_server=_s("NVIDIA_ASR_SERVER", "grpc.nvcf.nvidia.com:443"),
        asr_function_id=_s("NVIDIA_ASR_FUNCTION_ID", "bb0837de-8c7b-481f-9ec8-ef5663e9c1fa"),
        tts_server=_s("NVIDIA_TTS_SERVER"),
        tts_function_id=_s("NVIDIA_TTS_FUNCTION_ID", "877104f7-e885-42b9-8de8-f6e4c6303969"),
        tts_voice=_s("NVIDIA_TTS_VOICE", "Magpie-Multilingual.EN-US.Mia.Calm"),
        llm_base_url=_s("VOICE_LLM_BASE_URL", "https://integrate.api.nvidia.com/v1"),
        llm_model=_s("VOICE_LLM_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b"),
        llm_api_key=_s("VOICE_LLM_API_KEY") or nvidia_key,
        llm_temperature=_f("VOICE_LLM_TEMPERATURE", 0.7),
        llm_top_p=_f("VOICE_LLM_TOP_P", 0.95),
        llm_max_tokens=_i("VOICE_LLM_MAX_TOKENS", 110),
        llm_retry_secs=_f("VOICE_LLM_RETRY_SECS", 4.0),
        max_call_secs=_i("VOICE_MAX_CALL_SECS", 300),
        max_sessions=_i("VOICE_MAX_SESSIONS", 3),
        idle_secs=_i("VOICE_IDLE_SECS", 20),
        pin_length=_i("PHONE_PIN_LENGTH", 4),
        caller_hash_salt=_s("PHONE_CALLER_SALT") or _s("CALLER_HASH_SALT"),
        known_caller_hashes=_list("KNOWN_CALLER_HASHES"),
        signature_token=_s("SIGNALWIRE_SIGNING_KEY") or _s("TWILIO_AUTH_TOKEN"),
        signalwire_number=_s("SIGNALWIRE_PHONE_NUMBER"),
    )
