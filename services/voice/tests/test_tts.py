"""TTS engine selection: env picks the engine, a missing key falls back to Magpie, sample rates fit each transport."""
import httpx
import pytest

import config
import tts
from speech import SpeechNormalizer
from tts import ELEVEN_SHORTLIST, choose_tts, engine_rate, eleven_transport, pick_voice, resolve_elevenlabs_voice, score_voice

BASE = config.Settings(nvidia_api_key="nv", tts_voice="Magpie-Multilingual.EN-US.Ray.Neutral")


def S(**kw):
    return BASE.with_overrides(**kw)


def test_default_is_magpie_with_the_configured_voice():
    c = choose_tts(BASE, phone=False)
    assert (c.provider, c.model, c.voice, c.sample_rate, c.warnings) == ("magpie", "magpie-tts-multilingual", "Magpie-Multilingual.EN-US.Ray.Neutral", 22050, ())
    assert choose_tts(S(tts_provider="magpie"), phone=True).sample_rate == 22050
    assert choose_tts(S(tts_provider="nvidia"), phone=True).provider == "magpie"
    assert choose_tts(S(tts_provider=""), phone=True).provider == "magpie"


def test_elevenlabs_needs_a_key_else_magpie_with_one_warning():
    c = choose_tts(S(tts_provider="elevenlabs"), phone=False)
    assert c.provider == "magpie" and len(c.warnings) == 1 and "ELEVENLABS_API_KEY" in c.warnings[0] and "Ray.Neutral" in c.warnings[0]
    assert "secret-key" not in c.warnings[0]


def test_elevenlabs_with_key_uses_the_model_voice_and_transport_rate():
    web = choose_tts(S(tts_provider="elevenlabs", elevenlabs_api_key="secret-key", elevenlabs_voice_id="v123", elevenlabs_model="eleven_v4_turbo"), phone=False)
    assert (web.provider, web.model, web.voice, web.sample_rate, web.warnings) == ("elevenlabs", "eleven_v4_turbo", "v123", 24000, ())
    phone = choose_tts(S(tts_provider="elevenlabs", elevenlabs_api_key="k", elevenlabs_voice_id="v123"), phone=True)
    assert phone.sample_rate == 8000
    assert "secret-key" not in web.label and web.label == "elevenlabs:eleven_v4_turbo:v123"


def test_elevenlabs_without_a_voice_id_leaves_it_to_the_resolver():
    assert choose_tts(S(tts_provider="elevenlabs", elevenlabs_api_key="k"), phone=False).voice == ""


def test_cartesia_needs_key_and_voice():
    assert choose_tts(S(tts_provider="cartesia", cartesia_api_key="k"), phone=False).provider == "magpie"
    assert choose_tts(S(tts_provider="cartesia", cartesia_voice_id="v"), phone=False).provider == "magpie"
    c = choose_tts(S(tts_provider="cartesia", cartesia_api_key="k", cartesia_voice_id="v"), phone=True)
    assert (c.provider, c.model, c.voice, c.sample_rate) == ("cartesia", "sonic-3.6", "v", 8000)


def test_openai_compatible_needs_base_url_and_model_and_is_24k():
    assert choose_tts(S(tts_provider="openai_compatible", tts_model="m"), phone=False).provider == "magpie"
    assert choose_tts(S(tts_provider="openai_compatible", tts_base_url="http://x/v1"), phone=False).provider == "magpie"
    c = choose_tts(S(tts_provider="openai_compatible", tts_base_url="http://brev:8000/v1", tts_model="kokoro", tts_voice_name="am_michael", tts_api_key="k"), phone=True)
    assert (c.provider, c.model, c.voice, c.sample_rate) == ("openai_compatible", "kokoro", "am_michael", 24000)
    assert choose_tts(S(tts_provider="openai_compatible", tts_base_url="http://x/v1", tts_model="m"), phone=False).voice == "default"


def test_unknown_provider_falls_back_with_a_warning():
    c = choose_tts(S(tts_provider="festival"), phone=False)
    assert c.provider == "magpie" and "festival" in c.warnings[0]


def test_sample_rates_per_engine_and_transport():
    assert engine_rate("magpie", True) == engine_rate("magpie", False) == 22050
    assert engine_rate("elevenlabs", True) == 8000 and engine_rate("elevenlabs", False) == 24000
    assert engine_rate("cartesia", True) == 8000 and engine_rate("cartesia", False) == 24000
    assert engine_rate("openai_compatible", True) == engine_rate("openai_compatible", False) == 24000


def test_v4_models_use_http_streaming_others_the_websocket():
    assert eleven_transport(S(elevenlabs_model="eleven_v4_turbo")) == "http"
    assert eleven_transport(S(elevenlabs_model="eleven_v4")) == "http"
    assert eleven_transport(S(elevenlabs_model="eleven_flash_v2_5")) == "websocket"
    assert eleven_transport(S(elevenlabs_model="eleven_v4_turbo", elevenlabs_transport="websocket")) == "websocket"
    assert eleven_transport(S(elevenlabs_model="eleven_flash_v2_5", elevenlabs_transport="http")) == "http"


def test_env_names(monkeypatch):
    for k in list(__import__("os").environ):
        if k.startswith(("VOICE_", "NVIDIA_", "TTS_", "ELEVENLABS_", "CARTESIA_")):
            monkeypatch.delenv(k, raising=False)
    assert config.load_settings().tts_provider == "magpie"
    for k, v in {"TTS_PROVIDER": "ElevenLabs", "ELEVENLABS_API_KEY": "k", "ELEVENLABS_VOICE_ID": "vid", "ELEVENLABS_MODEL": "eleven_v4_turbo", "TTS_BASE_URL": "http://x/v1/", "TTS_MODEL": "m", "TTS_VOICE": "vv", "TTS_API_KEY": "tk"}.items():
        monkeypatch.setenv(k, v)
    s = config.load_settings()
    assert (s.tts_provider, s.elevenlabs_api_key, s.elevenlabs_voice_id, s.elevenlabs_model) == ("elevenlabs", "k", "vid", "eleven_v4_turbo")
    assert (s.tts_base_url, s.tts_model, s.tts_voice_name, s.tts_api_key) == ("http://x/v1", "m", "vv", "tk")


# ---- ElevenLabs voice resolution (no network: httpx.MockTransport) ---------------------------------------------------------------------
def client_for(routes):
    def handler(request: httpx.Request) -> httpx.Response:
        for (method, prefix), resp in routes.items():
            if request.method == method and request.url.path.startswith(prefix):
                return resp(request) if callable(resp) else resp
        return httpx.Response(404)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def _clear_cache():
    tts._eleven_cache.clear()


async def test_key_without_voices_read_falls_back_to_the_shortlist_and_probes():
    probed = []

    def synth(request):
        probed.append(request.url.path.split("/")[3])
        return httpx.Response(200, content=b"\x00\x01" * 100)

    async with client_for({("GET", "/v1/voices"): httpx.Response(401, json={"detail": "missing_permissions"}), ("POST", "/v1/text-to-speech/"): synth}) as http:
        got = await resolve_elevenlabs_voice("k", "eleven_v4_turbo", "", http=http)
    assert got == ("nPczCjzI2devNBz1zQrb", "Brian") and probed == ["nPczCjzI2devNBz1zQrb"]


async def test_a_voice_that_does_not_render_is_skipped():
    def synth(request):
        return httpx.Response(404 if "nPczCjzI2devNBz1zQrb" in request.url.path else 200, content=b"\x00" * 10)

    async with client_for({("GET", "/v1/voices"): httpx.Response(401), ("POST", "/v1/text-to-speech/"): synth}) as http:
        got = await resolve_elevenlabs_voice("k", "eleven_v4_turbo", "", http=http)
    assert got == ("iP95p4xoKVk53GoZ742B", "Chris")


async def test_a_bad_key_stops_at_once_and_returns_none():
    calls = []

    def synth(request):
        calls.append(1)
        return httpx.Response(401)

    async with client_for({("GET", "/v1/voices"): httpx.Response(401), ("POST", "/v1/text-to-speech/"): synth}) as http:
        assert await resolve_elevenlabs_voice("bad", "eleven_v4_turbo", "", http=http) is None
    assert len(calls) == 1


async def test_a_configured_voice_is_only_probed_and_the_result_is_cached():
    calls = []

    def synth(request):
        calls.append(request.url.path)
        return httpx.Response(200, content=b"\x00" * 10)

    async with client_for({("POST", "/v1/text-to-speech/vcfg/stream"): synth}) as http:
        assert await resolve_elevenlabs_voice("k", "m", "vcfg", http=http) == ("vcfg", "configured")
        assert await resolve_elevenlabs_voice("k", "m", "vcfg", http=http) == ("vcfg", "configured")
    assert calls == ["/v1/text-to-speech/vcfg/stream"]


async def test_the_voice_listing_wins_when_the_key_can_list():
    voices = {"voices": [
        {"voice_id": "female1", "name": "Sarah", "labels": {"gender": "female", "accent": "american", "use_case": "conversational"}},
        {"voice_id": "deep1", "name": "Deep", "labels": {"gender": "male", "accent": "american", "use_case": "narration", "age": "middle_aged", "descriptive": "deep"}},
        {"voice_id": "casual1", "name": "Casual Guy", "labels": {"gender": "male", "accent": "american", "use_case": "conversational", "age": "middle_aged", "descriptive": "casual"}},
    ]}
    async with client_for({("GET", "/v1/voices"): httpx.Response(200, json=voices), ("POST", "/v1/text-to-speech/"): httpx.Response(200, content=b"\x00" * 10)}) as http:
        assert await resolve_elevenlabs_voice("k", "m", "", http=http) == ("casual1", "Casual Guy")


def test_voice_scoring_prefers_natural_conversational_american_men():
    casual = {"voice_id": "a", "labels": {"gender": "male", "accent": "american", "use_case": "conversational", "age": "middle_aged", "descriptive": "casual"}}
    british = {"voice_id": "b", "labels": {"gender": "male", "accent": "british", "use_case": "conversational", "age": "middle_aged"}}
    whisper = {"voice_id": "c", "labels": {"gender": "male", "accent": "american", "use_case": "conversational", "descriptive": "whisper asmr"}}
    woman = {"voice_id": "d", "labels": {"gender": "female", "accent": "american", "use_case": "conversational"}}
    assert score_voice(casual) > score_voice(british) > 0
    assert score_voice(whisper) < score_voice(casual) and score_voice(woman) < 0
    assert pick_voice([woman, british, casual, whisper])["voice_id"] == "a"
    assert pick_voice([woman]) is None and pick_voice([]) is None


# ---- build_tts: real pipecat services, constructed offline ---------------------------------------------------------------------------
async def test_build_tts_magpie_by_default_and_when_the_key_is_missing():
    norm = SpeechNormalizer("2026-11-07")
    svc, choice = await tts.build_tts(S(nvidia_api_key="k"), phone=False, normalizer=norm)
    assert choice.provider == "magpie" and type(svc).__name__ == "NvidiaTTSService"
    svc2, choice2 = await tts.build_tts(S(nvidia_api_key="k", tts_provider="elevenlabs"), phone=False, normalizer=norm)
    assert choice2.provider == "magpie" and type(svc2).__name__ == "NvidiaTTSService" and choice2.warnings


async def test_build_tts_openai_compatible_and_cartesia_construct():
    norm = SpeechNormalizer("2026-11-07")
    svc, choice = await tts.build_tts(S(tts_provider="openai_compatible", tts_base_url="http://127.0.0.1:9/v1", tts_model="kokoro", tts_voice_name="am_michael"), phone=True, normalizer=norm)
    assert choice.provider == "openai_compatible" and svc._settings.voice == "am_michael" and svc._settings.model == "kokoro"
    svc, choice = await tts.build_tts(S(tts_provider="cartesia", cartesia_api_key="k", cartesia_voice_id="v"), phone=True, normalizer=norm)
    assert choice.provider == "cartesia" and type(svc).__name__ == "CartesiaTTSService"


async def test_build_tts_elevenlabs_uses_http_for_v4_and_the_websocket_for_flash(monkeypatch):
    async def fake_resolve(key, model, configured="", **kw):
        return (configured or "vfake", "Fake")

    monkeypatch.setattr(tts, "resolve_elevenlabs_voice", fake_resolve)
    norm = SpeechNormalizer("2026-11-07")
    svc, choice = await tts.build_tts(S(tts_provider="elevenlabs", elevenlabs_api_key="k", elevenlabs_model="eleven_v4_turbo"), phone=False, normalizer=norm)
    assert type(svc).__name__ == "ElevenLabsHttpTTSService" and choice.voice == "vfake" and choice.sample_rate == 24000
    assert svc._settings.model == "eleven_v4_turbo" and svc._settings.voice == "vfake"
    await svc.kv_cleanup()
    svc, choice = await tts.build_tts(S(tts_provider="elevenlabs", elevenlabs_api_key="k", elevenlabs_model="eleven_flash_v2_5", elevenlabs_voice_id="vcfg"), phone=True, normalizer=norm)
    assert type(svc).__name__ == "ElevenLabsTTSService" and choice.voice == "vcfg" and choice.sample_rate == 8000


async def test_elevenlabs_that_rejects_the_key_falls_back_to_magpie(monkeypatch):
    async def none(*a, **k):
        return None

    monkeypatch.setattr(tts, "resolve_elevenlabs_voice", none)
    svc, choice = await tts.build_tts(S(nvidia_api_key="k", tts_provider="elevenlabs", elevenlabs_api_key="bad"), phone=False, normalizer=SpeechNormalizer("2026-11-07"))
    assert choice.provider == "magpie" and "rejected" in choice.warnings[0] and "bad" not in choice.warnings[0]


async def test_the_normalizer_sits_in_front_of_every_engine():
    svc, _ = await tts.build_tts(S(nvidia_api_key="k"), phone=False, normalizer=SpeechNormalizer("2026-11-07"))
    out = await svc._transform_text("Saving 8.8% of **income** — about $39,655.", "sentence")
    assert "close to nine percent" in out and "forty thousand" in out and "*" not in out and "—" not in out
