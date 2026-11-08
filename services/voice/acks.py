"""Pre-rendered acknowledgements: a short human "Mm-hm." / "Got it." the instant the caller's turn ends, so the wait for the real answer
does not sound like a dead line. The clips are rendered ONCE per voice (ElevenLabs over HTTP, Magpie over gRPC as the fallback), cached in
memory, and played straight to the output transport, so an acknowledgement costs about 0 ms and no TTS or LLM round trip.

Rules (the pipeline in bot.py enforces them): never two in a row the same, never on top of the tool filler or of words already spoken, and
skipped when the real answer is about to start (it must not delay it). Audio tags are not used: the lines are plain words the voice says
naturally. Disabled by VOICE_ACKS=0."""
from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass

import httpx
from loguru import logger

from config import Settings
from tts import ELEVEN_API, TTSChoice

ACK_LINES = ("Mm-hm.", "Got it.", "Okay.", "Right.", "Sure.", "Hmm, let me look.")


@dataclass(frozen=True)
class Clip:
    text: str
    pcm: bytes  # 16-bit mono
    rate: int

    @property
    def secs(self) -> float:
        return len(self.pcm) / 2 / self.rate


_cache: dict[tuple, list[Clip]] = {}
_lock: asyncio.Lock | None = None


def cache_key(choice: TTSChoice) -> tuple:
    return (choice.provider, choice.model, choice.voice, choice.sample_rate)


async def _render_eleven(client: httpx.AsyncClient, s: Settings, choice: TTSChoice, line: str, gate: asyncio.Semaphore) -> Clip | None:
    for attempt in range(3):
        async with gate:  # the account allows only a few concurrent requests: 429 otherwise
            r = await client.post(
                f"{ELEVEN_API}/v1/text-to-speech/{choice.voice}/stream?output_format=pcm_{choice.sample_rate}",
                headers={"xi-api-key": s.elevenlabs_api_key},
                json={"text": line, "model_id": choice.model, "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.0}},
            )
        if r.status_code != 429:
            break
        await asyncio.sleep(0.8 * (attempt + 1))
    if r.status_code != 200 or len(r.content) < 800:
        logger.warning(f"ack clip {line!r}: ElevenLabs answered HTTP {r.status_code}")
        return None
    return Clip(line, _trim(r.content), choice.sample_rate)


def _render_magpie_sync(s: Settings, choice: TTSChoice, line: str) -> Clip | None:
    import riva.client

    meta = [["function-id", s.tts_function_id], ["authorization", f"Bearer {s.nvidia_api_key}"]]
    svc = riva.client.SpeechSynthesisService(riva.client.Auth(None, True, s.tts_grpc_server, meta))
    resp = svc.synthesize(line, voice_name=choice.voice, language_code="en-US", sample_rate_hz=choice.sample_rate)
    return Clip(line, _trim(resp.audio), choice.sample_rate) if resp.audio else None


def _trim(pcm: bytes) -> bytes:
    """Whole 16-bit samples only, and no more than 1.5 s: an acknowledgement is a breath, not a sentence."""
    return pcm[: len(pcm) // 2 * 2]


async def ensure_clips(s: Settings, choice: TTSChoice) -> list[Clip]:
    """The clips for this voice, rendered on first use and cached (a second call, or a call for another transport rate, reuses/extends the cache)."""
    global _lock
    _lock = _lock or asyncio.Lock()
    key = cache_key(choice)
    async with _lock:
        if key in _cache:
            return _cache[key]
        t0 = time.monotonic()
        clips: list[Clip] = []
        try:
            if choice.provider == "elevenlabs":
                gate = asyncio.Semaphore(2)
                async with httpx.AsyncClient(timeout=10) as client:
                    got = await asyncio.gather(*[_render_eleven(client, s, choice, ln, gate) for ln in ACK_LINES], return_exceptions=True)
            elif choice.provider == "magpie":
                got = await asyncio.gather(*[asyncio.to_thread(_render_magpie_sync, s, choice, ln) for ln in ACK_LINES], return_exceptions=True)
            else:
                got = []
            clips = [c for c in got if isinstance(c, Clip) and 0.15 < c.secs < 1.8]
        except Exception as e:
            logger.warning(f"could not render the acknowledgement clips: {type(e).__name__}")
        _cache[key] = clips
        logger.info(f"acknowledgement clips for {choice.provider}:{choice.voice or 'default'} @ {choice.sample_rate} Hz: {len(clips)}/{len(ACK_LINES)} rendered in {round((time.monotonic() - t0) * 1000)} ms")
        return clips


def cached(choice: TTSChoice) -> list[Clip]:
    return _cache.get(cache_key(choice), [])


class AckPicker:
    """Random clip that never repeats the previous one."""

    def __init__(self, rng: random.Random | None = None):
        self._rng = rng or random.Random()
        self._last: str | None = None

    def pick(self, clips: list[Clip]) -> Clip | None:
        pool = [c for c in clips if c.text != self._last] or clips
        if not pool:
            return None
        c = self._rng.choice(pool)
        self._last = c.text
        return c
