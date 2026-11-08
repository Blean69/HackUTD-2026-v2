"""Environment -> typed settings for the voice service. Nothing secret has a default; nothing here is ever logged."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


def load_env() -> None:
    """Dev convenience: read the repo-root .env (or VOICE_ENV_FILE) without overriding real env vars. Production uses compose env_file."""
    explicit = os.environ.get("VOICE_ENV_FILE")
    here = Path(__file__).resolve()
    # In the repo this file is services/voice/config.py (repo root = parents[2]); in the image it is /app/config.py,
    # which has no parents[2], so only look up the tree as far as it goes.
    candidates = [Path(explicit)] if explicit else [*([here.parents[2] / ".env"] if len(here.parents) > 2 else []), here.parent / ".env"]
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


def pin_lengths(raw: str) -> list[int]:
    """Digit counts of the PINs in PHONE_PINS ("1234:hh_rivera,56789:hh_nguyen"), parsed like the worker does (4 to 8 digits, then ':household').
    Only lengths, never the digits, leave this function."""
    out: list[int] = []
    for item in raw.replace(";", ",").replace(" ", ",").split(","):
        pin, _, rest = item.strip().partition(":")
        if rest and pin.isdigit() and 4 <= len(pin) <= 8:
            out.append(len(pin))
    return out


def derive_pin_length(explicit: str, phone_pins: str) -> tuple[int, bool]:
    """(digits to collect, variable). PHONE_PIN_LENGTH wins when set. Otherwise it follows PHONE_PINS: all the same length -> that length;
    different lengths -> the longest, with `variable` set so '#' submits a shorter one. Neither set -> 4."""
    if explicit.strip().isdigit() and int(explicit) > 0:
        return int(explicit), False
    lens = pin_lengths(phone_pins)
    if lens:
        return max(lens), len(set(lens)) > 1
    return 4, False


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
    tts_voice: str = "Magpie-Multilingual.EN-US.Ray.Neutral"
    tts_synthesis_mode: str = "per_sentence"  # per_sentence | stitched (Magpie only; see bot notes in docs/voice-agent.md)
    # pluggable speaking voice (tts.py): magpie (default) | elevenlabs | cartesia | openai_compatible. A missing key falls back to Magpie.
    tts_provider: str = "magpie"
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = ""  # empty = pick a natural male US voice from the account
    elevenlabs_model: str = "eleven_v4_turbo"
    elevenlabs_transport: str = "auto"  # auto | http | websocket
    cartesia_api_key: str = ""
    cartesia_voice_id: str = ""
    cartesia_model: str = "sonic-3.6"
    tts_base_url: str = ""  # openai_compatible: e.g. http://brev-host:8000/v1
    tts_api_key: str = ""
    tts_model: str = ""
    tts_voice_name: str = ""
    llm_base_url: str = "https://integrate.api.nvidia.com/v1"
    llm_model: str = "nvidia/nemotron-3.5-lightning-30b-a3b"
    llm_api_key: str = ""
    llm_temperature: float = 0.5  # lower = sticks to the notes and tool results (0.7 invented figures under pushback)
    llm_top_p: float = 0.95
    llm_max_tokens: int = 80  # backstop against rambling, applied to PLAIN-TEXT replies only (about 55 spoken words); the prompt asks for ~30
    llm_api_max_tokens: int = 400  # what the API is allowed to generate: a tool call cut at 80 tokens is invalid JSON and silences the bot
    turn_cap_words: int = 32  # a spoken turn stops at the first sentence end after this many words (pacing.SentenceCap)
    # first-token stalls on the hosted endpoint (seen: 38 s with no error): hedge, retry, hard-cap, then fail over (llm.py)
    llm_providers: list[str] = field(default_factory=lambda: ["brev", "nvidia_lightning", "nvidia_nano"])
    llm_hedge_secs: float = 1.5  # no first token after this long: send a second identical request and use whichever answers first (0 = off)
    llm_retry_secs: float = 4.0  # still nothing: bring in the next provider (or one more request when there is none); 0 = off
    llm_timeout_secs: float = 8.0  # hard cap per provider: no first token by then, drop its requests and use the next provider
    llm_cooldown_secs: float = 30.0  # a provider that stalled or errored is tried last for this long, so one outage costs one slow turn
    llm_hedge_until: str = "sentence"  # what a request must deliver to win the race: "sentence" (first speakable unit) | "token" (first chunk)
    llm_warm: bool = True  # warm the LLM connections (and the prompt cache) in the background when a call connects
    llm_keepwarm_secs: float = 3.0  # during a call, ping the next provider this often so its connection never idles out (5 s); 0 = off
    brev_base_url: str = ""  # BREV_BASE_URL / BREV_API_KEY / BREV_NEMOTRON_MODEL: our own Nemotron on a Brev GPU; empty = provider skipped
    brev_api_key: str = ""
    brev_model: str = ""
    brev_label: str = "nemotron-3.5-lightning (Brev L40S)"  # what the trace shows for the model served by our Brev GPU (vLLM calls it "nemotron")
    nano_base_url: str = "https://integrate.api.nvidia.com/v1"
    # another Nemotron on the hosted API (a different route from Lightning). nvidia/nemotron-nano-3-30b-a3b is in /v1/models but 404s on
    # completions for our key (checked 2026-11-07); the Nano-3 omni model answers, calls tools and honours enable_thinking=false.
    nano_model: str = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
    # turn-taking: Silero decides "silence", Smart Turn v3 (local ONNX, CPU) decides "finished"; barge-in needs `barge_in_words` words
    vad_stop_secs: float = 0.2
    smart_turn: bool = True
    smart_turn_stop_secs: float = 2.0  # longest silence tolerated when Smart Turn thinks the caller is mid-thought
    barge_in_words: int = 2  # words that interrupt Brian on the phone
    barge_in_words_webrtc: int = 3  # VOICE_BARGE_IN_WORDS_WEBRTC: in the browser (speakers echo, rooms are noisy) it takes three
    noise_filter: str = "auto"  # VOICE_NOISE_FILTER: auto (RNNoise on WebRTC only) | on | webrtc | phone | off (noise.py)
    echo_overlap: float = 0.6  # VOICE_ECHO_OVERLAP: a would-be interruption this similar to what Brian just said is his own echo and is ignored (0 = off)
    echo_grace_secs: float = 1.0  # VOICE_ECHO_GRACE_SECS: the guard also covers this long after he stops (the tail of his sentence is still arriving)
    turn_hold_secs: float | None = None  # also require this much quiet after the caller's last word (Smart Turn AND timer). None = auto: 0.6 on the phone, 0 in the browser
    hesitation_hold_secs: float = 1.5  # extra wait when the last words are a filler or dangling word ("uh", "so", "and the"); 0 = off
    acks: bool = True  # pre-rendered "Mm-hm." / "Got it." the moment the caller's turn ends (acks.py)
    # calls
    max_call_secs: int = 300
    max_sessions: int = 3
    idle_secs: int = 20
    pin_length: int = 4  # PHONE_PIN_LENGTH, else derived from PHONE_PINS (config.derive_pin_length)
    pin_variable: bool = False  # the configured PINs differ in length: the gate collects up to pin_length digits and '#' submits early
    caller_hash_salt: str = ""
    known_caller_hashes: list[str] = field(default_factory=list)
    # webhook signature check on /twiml: SIGNALWIRE_SIGNING_KEY (or a Twilio auth token). Empty = skipped with a logged warning;
    # the media socket is still protected by the short-lived stream token
    signature_token: str = ""
    signalwire_number: str = ""
    # callback after a phone call (docs/contracts.md section 10): Brian rings the same number back with a critical alert. Needs the four
    # SIGNALWIRE_* values below plus VOICE_SHARED_SECRET (it signs the callback tokens); anything missing = the feature stays off.
    signalwire_space_url: str = ""  # SIGNALWIRE_SPACE_URL, e.g. yourspace.signalwire.com
    signalwire_project_id: str = ""
    signalwire_api_token: str = ""
    callback_enabled: bool = True  # VOICE_CALLBACK_ENABLED (default 1)
    callback_secs: float = 15.0  # VOICE_CALLBACK_SECS: wait after the first call ends before dialling
    callback_ring_secs: int = 20  # VOICE_CALLBACK_RING_SECS: give up ringing after this long (also keeps most calls out of voicemail)
    callback_amd: str = "off"  # VOICE_CALLBACK_AMD: off | enable | detect_message_end (SignalWire answering-machine detection)
    callback_cooldown_secs: float = 60.0  # VOICE_CALLBACK_COOLDOWN_SECS: at most one callback per caller number in this window
    callback_max_per_hour: int = 20  # VOICE_CALLBACK_MAX_PER_HOUR: cost and abuse cap across all callers

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
        tts_voice=_s("NVIDIA_TTS_VOICE", "Magpie-Multilingual.EN-US.Ray.Neutral"),
        tts_synthesis_mode=_s("VOICE_TTS_MODE", "per_sentence").lower() if _s("VOICE_TTS_MODE", "per_sentence").lower() in ("per_sentence", "stitched") else "per_sentence",
        tts_provider=_s("TTS_PROVIDER", "magpie").lower(),
        elevenlabs_api_key=_s("ELEVENLABS_API_KEY"),
        elevenlabs_voice_id=_s("ELEVENLABS_VOICE_ID"),
        elevenlabs_model=_s("ELEVENLABS_MODEL", "eleven_v4_turbo"),
        elevenlabs_transport=_s("ELEVENLABS_TRANSPORT", "auto").lower(),
        cartesia_api_key=_s("CARTESIA_API_KEY"),
        cartesia_voice_id=_s("CARTESIA_VOICE_ID"),
        cartesia_model=_s("CARTESIA_MODEL", "sonic-3.6"),
        tts_base_url=_s("TTS_BASE_URL").rstrip("/"),
        tts_api_key=_s("TTS_API_KEY"),
        tts_model=_s("TTS_MODEL"),
        tts_voice_name=_s("TTS_VOICE"),
        llm_base_url=_s("VOICE_LLM_BASE_URL", "https://integrate.api.nvidia.com/v1"),
        llm_model=_s("VOICE_LLM_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b"),
        llm_api_key=_s("VOICE_LLM_API_KEY") or nvidia_key,
        llm_temperature=_f("VOICE_LLM_TEMPERATURE", 0.5),
        llm_top_p=_f("VOICE_LLM_TOP_P", 0.95),
        llm_max_tokens=_i("VOICE_LLM_MAX_TOKENS", 80),
        llm_api_max_tokens=max(_i("VOICE_LLM_API_MAX_TOKENS", 400), _i("VOICE_LLM_MAX_TOKENS", 80)),
        turn_cap_words=_i("VOICE_TURN_CAP_WORDS", 32),
        vad_stop_secs=_f("VOICE_VAD_STOP_SECS", 0.2),
        smart_turn=_s("VOICE_SMART_TURN", "1") != "0",
        smart_turn_stop_secs=_f("VOICE_SMART_TURN_STOP_SECS", 2.0),
        barge_in_words=_i("VOICE_BARGE_IN_WORDS", 2),
        barge_in_words_webrtc=max(1, _i("VOICE_BARGE_IN_WORDS_WEBRTC", 3)),
        noise_filter=_s("VOICE_NOISE_FILTER", "auto").lower(),
        echo_overlap=min(1.0, max(0.0, _f("VOICE_ECHO_OVERLAP", 0.6))),
        echo_grace_secs=max(0.0, _f("VOICE_ECHO_GRACE_SECS", 1.0)),
        turn_hold_secs=_f("VOICE_TURN_HOLD_SECS", -1.0) if _s("VOICE_TURN_HOLD_SECS") else None,
        hesitation_hold_secs=max(0.0, _f("VOICE_HESITATION_HOLD_SECS", 1.5)),
        llm_providers=[x.lower() for x in _list("VOICE_LLM_PROVIDERS", "brev,nvidia_lightning,nvidia_nano")] or ["nvidia_lightning"],
        llm_hedge_secs=max(0.0, _f("VOICE_LLM_HEDGE_SECS", 1.5)),
        llm_retry_secs=max(0.0, _f("VOICE_LLM_RETRY_SECS", _f("LLM_RETRY_SECS", 4.0))),
        llm_timeout_secs=max(0.0, _f("VOICE_LLM_TIMEOUT_SECS", 8.0)),
        llm_cooldown_secs=max(0.0, _f("VOICE_LLM_COOLDOWN_SECS", 30.0)),
        llm_hedge_until="token" if _s("VOICE_LLM_HEDGE_UNTIL", "sentence").lower() == "token" else "sentence",
        llm_warm=_s("VOICE_LLM_WARM", "1") != "0",
        llm_keepwarm_secs=max(0.0, _f("VOICE_LLM_KEEPWARM_SECS", 3.0)),
        brev_base_url=_s("BREV_BASE_URL").rstrip("/"),
        brev_api_key=_s("BREV_API_KEY"),
        brev_model=_s("BREV_NEMOTRON_MODEL"),
        brev_label=_s("VOICE_BREV_LABEL", "nemotron-3.5-lightning (Brev L40S)"),
        nano_base_url=_s("VOICE_LLM_NANO_BASE_URL", "https://integrate.api.nvidia.com/v1").rstrip("/"),
        nano_model=_s("VOICE_LLM_NANO_MODEL", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"),
        acks=_s("VOICE_ACKS", "1") != "0",
        max_call_secs=_i("VOICE_MAX_CALL_SECS", 300),
        max_sessions=_i("VOICE_MAX_SESSIONS", 3),
        idle_secs=_i("VOICE_IDLE_SECS", 20),
        pin_length=derive_pin_length(_s("PHONE_PIN_LENGTH"), _s("PHONE_PINS"))[0],
        pin_variable=derive_pin_length(_s("PHONE_PIN_LENGTH"), _s("PHONE_PINS"))[1],
        caller_hash_salt=_s("PHONE_CALLER_SALT") or _s("CALLER_HASH_SALT"),
        known_caller_hashes=_list("KNOWN_CALLER_HASHES"),
        signature_token=_s("SIGNALWIRE_SIGNING_KEY") or _s("TWILIO_AUTH_TOKEN"),
        signalwire_number=_s("SIGNALWIRE_PHONE_NUMBER"),
        signalwire_space_url=_s("SIGNALWIRE_SPACE_URL"),
        signalwire_project_id=_s("SIGNALWIRE_PROJECT_ID"),
        signalwire_api_token=_s("SIGNALWIRE_API_TOKEN"),
        callback_enabled=_s("VOICE_CALLBACK_ENABLED", "1") != "0",
        callback_secs=max(0.0, _f("VOICE_CALLBACK_SECS", 15.0)),
        callback_ring_secs=max(0, _i("VOICE_CALLBACK_RING_SECS", 20)),
        callback_amd=_s("VOICE_CALLBACK_AMD", "off").lower() if _s("VOICE_CALLBACK_AMD", "off").lower() in ("off", "enable", "detect_message_end") else "off",
        callback_cooldown_secs=max(0.0, _f("VOICE_CALLBACK_COOLDOWN_SECS", 60.0)),
        callback_max_per_hour=max(0, _i("VOICE_CALLBACK_MAX_PER_HOUR", 20)),
    )
