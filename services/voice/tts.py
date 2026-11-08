"""Which engine speaks. Nemotron ASR and the Nemotron LLM never change; only the voice is pluggable, by env, with no code change:

  TTS_PROVIDER=magpie              (default) NVIDIA Magpie TTS Multilingual over gRPC, voice NVIDIA_TTS_VOICE
  TTS_PROVIDER=elevenlabs          ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID (optional), ELEVENLABS_MODEL (default eleven_v4_turbo).
                                   Transport (ELEVENLABS_TRANSPORT=auto|http|websocket): auto = HTTP streaming for the eleven_v4 family
                                   (the classic stream-input websocket is documented to reject v4 models), the websocket otherwise.
                                   No voice id: a hardcoded shortlist of premade male voices is probed with a 3-character synthesis and the
                                   first that renders is used (a key without the voices_read permission cannot list voices).
  TTS_PROVIDER=cartesia            CARTESIA_API_KEY, CARTESIA_VOICE_ID (required), CARTESIA_MODEL (default sonic-3.6)
  TTS_PROVIDER=openai_compatible   TTS_BASE_URL, TTS_API_KEY, TTS_MODEL, TTS_VOICE: any /v1/audio/speech server (e.g. an open model on the
                                   NVIDIA Brev GPU). Must return raw 24 kHz PCM (response_format=pcm).

A provider whose key is missing (or unknown) falls back to Magpie with one warning, so a half-configured env never leaves a call mute.
The spoken-text normalizer (speech.py) sits in front of every engine."""
from __future__ import annotations

import time
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any

import httpx
from loguru import logger

from config import Settings
from speech import SpeechNormalizer

MAGPIE_RATE = 22050  # Magpie's native rate; the transport resamples to 8 kHz (phone) or 24 kHz (browser)
PROVIDERS = ("magpie", "elevenlabs", "cartesia", "openai_compatible")
ELEVEN_API = "https://api.elevenlabs.io"
# premade male voices, the team's pick first (names from memory: trust the audio, not the label)
ELEVEN_SHORTLIST = [
    ("nPczCjzI2devNBz1zQrb", "Brian"),  # the team's pick
    ("iP95p4xoKVk53GoZ742B", "Chris"),
    ("cjVigY5qzO86Huf0OWal", "Eric"),
    ("CwhRBWXzGAHq8TQ4Fs17", "Roger"),
    ("TX3LPaxmHKxFdv7VOQHJ", "Liam"),
    ("bIHbv24MWmeRgasZH58o", "Will"),
    ("pNInz6obpgDQGcFmaJgB", "Adam"),
]


@dataclass(frozen=True)
class TTSChoice:
    """What was selected and why (pure data, so the selection is unit-testable without any network)."""

    provider: str  # magpie | elevenlabs | cartesia | openai_compatible
    model: str  # what the trace badge shows, e.g. "magpie-tts-multilingual" or "eleven_flash_v2_5"
    voice: str  # a voice id/name; "" means "pick one from the account" (ElevenLabs only)
    sample_rate: int
    warnings: tuple[str, ...] = field(default_factory=tuple)

    @property
    def label(self) -> str:
        """Short, secret-free description for logs and the trace (`tts_voice`)."""
        return f"{self.provider}:{self.model}:{self.voice}" if self.provider != "magpie" else self.voice


def engine_rate(provider: str, phone: bool) -> int:
    """The rate the engine renders at. Phone is 8 kHz end to end, so ask for 8 kHz and skip a resample; the browser gets 24 kHz."""
    if provider == "magpie":
        return MAGPIE_RATE
    if provider == "openai_compatible":
        return 24000  # the OpenAI speech format is fixed at 24 kHz PCM
    return 8000 if phone else 24000  # elevenlabs / cartesia offer both natively


def eleven_transport(s: Settings) -> str:
    """"http" or "websocket". The eleven_v4 family is served over HTTP streaming (the stream-input websocket rejects it)."""
    t = (s.elevenlabs_transport or "auto").lower()
    if t in ("http", "websocket"):
        return t
    return "http" if (s.elevenlabs_model or "").lower().startswith("eleven_v4") else "websocket"


def choose_tts(s: Settings, *, phone: bool) -> TTSChoice:
    """Pure selection: provider from env, with a Magpie fallback (and a warning) whenever the provider is not usable."""
    want = (s.tts_provider or "magpie").strip().lower()
    magpie = TTSChoice("magpie", "magpie-tts-multilingual", s.tts_voice, MAGPIE_RATE)
    if want in ("", "magpie", "nvidia"):
        return magpie
    if want not in PROVIDERS:
        return _fallback(magpie, f"TTS_PROVIDER={want!r} is not one of {', '.join(PROVIDERS)}")
    if want == "elevenlabs":
        if not s.elevenlabs_api_key:
            return _fallback(magpie, "TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is empty")
        return TTSChoice("elevenlabs", s.elevenlabs_model or "eleven_v4_turbo", s.elevenlabs_voice_id, engine_rate(want, phone))
    if want == "cartesia":
        if not s.cartesia_api_key or not s.cartesia_voice_id:
            return _fallback(magpie, "TTS_PROVIDER=cartesia needs CARTESIA_API_KEY and CARTESIA_VOICE_ID")
        return TTSChoice("cartesia", s.cartesia_model or "sonic-3.6", s.cartesia_voice_id, engine_rate(want, phone))
    if not s.tts_base_url or not s.tts_model:
        return _fallback(magpie, "TTS_PROVIDER=openai_compatible needs TTS_BASE_URL and TTS_MODEL")
    return TTSChoice("openai_compatible", s.tts_model, s.tts_voice_name or "default", engine_rate(want, phone))


def _fallback(magpie: TTSChoice, why: str) -> TTSChoice:
    return TTSChoice(magpie.provider, magpie.model, magpie.voice, magpie.sample_rate, warnings=(f"{why}; using Magpie ({magpie.voice}) instead",))


# ---- ElevenLabs: pick a natural male voice from the account when ELEVENLABS_VOICE_ID is empty --------------------------------------------------
def score_voice(v: dict[str, Any]) -> int:
    """How well an ElevenLabs voice fits "a natural, conversational adult male American voice on a phone call"; negative = never pick."""
    labels = v.get("labels") or {}
    gender = str(labels.get("gender") or "").lower()
    if gender != "male":
        return -100
    score = 10
    accent = str(labels.get("accent") or "").lower()
    score += 4 if accent in ("american", "us", "en-us") else (-6 if accent else 0)
    use = str(labels.get("use_case") or labels.get("usecase") or "").lower().replace(" ", "_")
    score += {"conversational": 6, "social_media": 1, "narration": -1, "characters_animation": -6, "characters": -6, "advertisement": -3, "news": -1}.get(use, 0)
    age = str(labels.get("age") or "").lower().replace(" ", "_")
    score += {"middle_aged": 3, "young": 2, "old": -3}.get(age, 0)
    desc = str(labels.get("descriptive") or labels.get("description") or "").lower()
    for word, pts in (("casual", 2), ("friendly", 2), ("warm", 2), ("natural", 2), ("calm", 1), ("confident", 1), ("deep", -1), ("raspy", -3), ("intense", -3), ("whisper", -6), ("asmr", -8)):
        if word in desc:
            score += pts
    return score


def pick_voice(voices: list[dict[str, Any]]) -> dict[str, Any] | None:
    ranked = sorted(((score_voice(v), v) for v in voices if v.get("voice_id")), key=lambda t: t[0], reverse=True)
    return ranked[0][1] if ranked and ranked[0][0] > 0 else None


_eleven_cache: dict[tuple[str, str, str], tuple[float, tuple[str, str] | None]] = {}


async def _probe_voice(client: httpx.AsyncClient, api_key: str, model: str, voice_id: str) -> int:
    """HTTP status of a 3-character synthesis (cheapest way to learn that key, voice and model work together)."""
    async with client.stream(
        "POST", f"{ELEVEN_API}/v1/text-to-speech/{voice_id}/stream?output_format=pcm_8000", headers={"xi-api-key": api_key}, json={"text": "Hi.", "model_id": model}
    ) as r:
        if r.status_code == 200:
            async for _ in r.aiter_bytes():
                break
        return r.status_code


async def resolve_elevenlabs_voice(
    api_key: str, model: str, configured: str = "", *, http: httpx.AsyncClient | None = None, ttl: float = 600.0, max_probes: int = 4
) -> tuple[str, str] | None:
    """(voice_id, name) that works for this key and model, or None (caller falls back to Magpie). Cached for `ttl` seconds.

    A configured ELEVENLABS_VOICE_ID is only probed. Without one: try GET /v1/voices (scored for a natural male US voice); a key without
    the voices_read permission gets 401, so fall back to the premade shortlist. Each candidate is probed with a tiny synthesis."""
    ck = (api_key, model, configured)
    hit = _eleven_cache.get(ck)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    own = http is None
    client = http or httpx.AsyncClient(timeout=8)
    result: tuple[str, str] | None = None
    try:
        candidates: list[tuple[str, str]] = [(configured, "configured")] if configured else []
        if not configured:
            try:
                r = await client.get(f"{ELEVEN_API}/v1/voices", headers={"xi-api-key": api_key})
                if r.status_code == 200:
                    v = pick_voice(r.json().get("voices") or [])
                    if v:
                        candidates.append((v["voice_id"], str(v.get("name") or "account voice")))
            except Exception:
                pass  # listing is a nicety; the shortlist below always works
            candidates += ELEVEN_SHORTLIST
        for voice_id, name in candidates[:max_probes]:
            status = await _probe_voice(client, api_key, model, voice_id)
            if status == 200:
                result = (voice_id, name)
                logger.info(f"ElevenLabs voice ok: {name} ({voice_id}) with model {model}")
                break
            logger.warning(f"ElevenLabs probe: voice {name} gave HTTP {status}")
            if status in (401, 429):  # bad key or rate limit: other voices will not do better
                break
    except Exception as e:
        logger.warning(f"ElevenLabs probe failed: {type(e).__name__}")
    finally:
        if own:
            await client.aclose()
    _eleven_cache[ck] = (time.monotonic(), result)
    return result


# ---- the OpenAI-compatible adapter ---------------------------------------------------------------------------------------------------------
def _openai_compatible_class():
    from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
    from pipecat.services.openai.tts import OpenAITTSService
    from pipecat.utils.tracing.service_decorators import traced_tts

    class OpenAICompatibleTTSService(OpenAITTSService):
        """OpenAITTSService without the fixed OpenAI voice list: any voice string goes to the server as is (raw 24 kHz PCM back)."""

        @traced_tts
        async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
            params: dict[str, Any] = {"input": text, "model": self._settings.model, "voice": self._settings.voice, "response_format": "pcm"}
            if self._settings.speed:
                params["speed"] = self._settings.speed
            try:
                async with self._client.audio.speech.with_streaming_response.create(**params) as r:
                    if r.status_code != 200:
                        yield ErrorFrame(error=f"TTS server error (HTTP {r.status_code})")
                        return
                    await self.start_tts_usage_metrics(text)
                    async for chunk in r.iter_bytes(self.chunk_size):
                        if chunk:
                            await self.stop_ttfb_metrics()
                            yield TTSAudioRawFrame(chunk, self.sample_rate, 1, context_id=context_id)
            except Exception as e:
                yield ErrorFrame(error=f"TTS server error: {type(e).__name__}")

    return OpenAICompatibleTTSService


async def build_tts(s: Settings, *, phone: bool, normalizer: SpeechNormalizer, force_magpie: bool = False) -> tuple[Any, TTSChoice]:
    """The TTS service for this call plus what was chosen (for logs and the trace). Never raises for a missing/invalid key: falls back to Magpie."""
    choice = choose_tts(s, phone=phone) if not force_magpie else choose_tts(s.with_overrides(tts_provider="magpie"), phone=phone)
    cleanup = None
    if choice.provider == "elevenlabs":
        picked = await resolve_elevenlabs_voice(s.elevenlabs_api_key, choice.model, choice.voice)
        if picked:
            choice = TTSChoice(choice.provider, choice.model, picked[0], choice.sample_rate, choice.warnings)
        else:
            choice = _fallback(choose_tts(s.with_overrides(tts_provider="magpie"), phone=phone), "ElevenLabs rejected this key, voice or model")
    for w in choice.warnings:
        logger.warning(w)
    transforms = [("*", normalizer.transform)]

    if choice.provider == "elevenlabs":
        if eleven_transport(s) == "http":
            import aiohttp
            from pipecat.services.elevenlabs.tts import ElevenLabsHttpTTSService

            session = aiohttp.ClientSession()
            svc = ElevenLabsHttpTTSService(
                api_key=s.elevenlabs_api_key,
                aiohttp_session=session,
                sample_rate=choice.sample_rate,
                settings=ElevenLabsHttpTTSService.Settings(voice=choice.voice, model=choice.model, stability=0.5, similarity_boost=0.75, style=0.0),
                text_transforms=transforms,
            )
            cleanup = session.close
        else:
            from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

            svc = ElevenLabsTTSService(
                api_key=s.elevenlabs_api_key,
                sample_rate=choice.sample_rate,
                settings=ElevenLabsTTSService.Settings(voice=choice.voice, model=choice.model, stability=0.5, similarity_boost=0.75, style=0.0),
                text_transforms=transforms,
            )
    elif choice.provider == "cartesia":
        from pipecat.services.cartesia.tts import CartesiaTTSService

        svc = CartesiaTTSService(api_key=s.cartesia_api_key, sample_rate=choice.sample_rate, settings=CartesiaTTSService.Settings(voice=choice.voice, model=choice.model), text_transforms=transforms)
    elif choice.provider == "openai_compatible":
        cls = _openai_compatible_class()
        svc = cls(api_key=s.tts_api_key or "none", base_url=s.tts_base_url, sample_rate=choice.sample_rate, settings=cls.Settings(model=choice.model, voice=choice.voice), text_transforms=transforms)
    else:
        from pipecat.services.nvidia.tts import NvidiaTTSService

        svc = NvidiaTTSService(
            api_key=s.nvidia_api_key,
            server=s.tts_grpc_server,
            model_function_map={"function_id": s.tts_function_id, "model_name": "magpie-tts-multilingual"},
            sample_rate=choice.sample_rate,
            settings=NvidiaTTSService.Settings(voice=choice.voice, synthesis_mode=s.tts_synthesis_mode),
            text_transforms=transforms,
        )
    svc.kv_cleanup = cleanup  # awaited by the call when it ends (closes the HTTP session of the ElevenLabs HTTP path)
    logger.info(f"TTS engine: {choice.provider} model={choice.model} voice={choice.voice} rate={choice.sample_rate}")
    return svc, choice
