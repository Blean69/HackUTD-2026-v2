import pytest
from fastapi.testclient import TestClient

import config
import prompts
from server import create_app
from twiml import make_stream_token, twilio_signature


def test_settings_from_env(monkeypatch):
    for k in list(__import__("os").environ):
        if k.startswith(("VOICE_", "NVIDIA_", "PHONE_", "SIGNALWIRE_", "PIPECAT_", "WORKER_URL", "KNOWN_", "CALLER_", "PUBLIC_")):
            monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("NVIDIA_API_KEY", "team-key")
    monkeypatch.setenv("NVIDIA_VOICE_API_KEY", "voice-key")
    monkeypatch.setenv("NVIDIA_ASR_FUNCTION_ID", "bb0837de-8c7b-481f-9ec8-ef5663e9c1fa   # nemotron-asr-streaming (alt: parakeet)")
    monkeypatch.setenv("VOICE_HTTP", "0.0.0.0:7861")
    monkeypatch.setenv("VOICE_TRANSPORTS", "WebRTC, twilio")
    monkeypatch.setenv("SIGNALWIRE_SIGNING_KEY", "sk")
    monkeypatch.setenv("PHONE_CALLER_SALT", "pepper")
    s = config.load_settings()
    assert s.nvidia_api_key == "voice-key" and s.llm_api_key == "voice-key"  # the voice-specific key wins
    assert s.asr_function_id == "bb0837de-8c7b-481f-9ec8-ef5663e9c1fa"  # trailing comment tolerated
    assert (s.host, s.port) == ("0.0.0.0", 7861) and s.transports == ["webrtc", "twilio"]
    assert s.tts_voice == "Magpie-Multilingual.EN-US.Mia.Calm" and s.llm_model == "nvidia/nemotron-3.5-lightning-30b-a3b"
    assert s.signature_token == "sk" and s.caller_hash_salt == "pepper" and s.public_path == "/voice"
    assert s.tts_grpc_server == s.asr_server and s.ice_servers.startswith("stun:")


def test_prompts_disclose_and_carry_the_brief():
    for line in (prompts.DISCLOSURE_WEB, prompts.DISCLOSURE_PHONE):
        assert line.startswith("Hi, I'm the family's AI money assistant") and "not a person" in line and "licensed advisor" in line and "made-up data" in line
    assert "PIN" in prompts.DISCLOSURE_PHONE and "PIN" not in prompts.DISCLOSURE_WEB
    p = prompts.system_prompt(family="Rivera family", first_name="Marisol", brief=["Cushion: about 3.3 months"], today="2026-11-07", channel="phone")
    assert "Marisol from the Rivera family" in p and "- Cushion: about 3.3 months" in p and "by phone" in p and "2026-11-07" in p
    assert "AI, not a person" in p
    assert len({prompts.filler() for _ in range(60)}) > 1


S = config.Settings(shared_secret="vs", signature_token="swkey", public_hostname="keystone.example", caller_hash_salt="pepper", nvidia_api_key="k")


def client(**over):
    return TestClient(create_app(S.with_overrides(**over)))


def test_health_never_leaks_secrets():
    with client() as c:
        body = c.get("/health").json()
    assert body["ok"] and body["nvidia_key"] is True and body["worker_secret"] is True
    assert "vs" not in str(body.values()) and "swkey" not in str(body.values())


def test_twiml_needs_a_valid_signature_when_a_key_is_set():
    form = {"From": "+15555550123", "To": "+14695550100", "CallSid": "CA1"}
    with client() as c:
        assert c.post("/twiml", data=form).status_code == 403
        assert c.post("/twiml", data=form, headers={"X-SignalWire-Signature": "bogus"}).status_code == 403
        sig = twilio_signature("swkey", "https://keystone.example/voice/twiml", form)
        r = c.post("/twiml", data=form, headers={"X-SignalWire-Signature": sig})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/xml")
    assert 'Stream url="wss://keystone.example/voice/ws"' in r.text and 'name="token"' in r.text and "5555550123" not in r.text


def test_twiml_without_a_signing_key_still_works_and_hangs_up_when_the_line_is_off():
    form = {"From": "+15555550123", "CallSid": "CA1"}
    with client(signature_token="") as c:
        assert "<Connect><Stream" in c.post("/twiml", data=form).text
    with client(signature_token="", enabled=False) as c:
        assert "<Hangup/>" in c.post("/twiml", data=form).text


def test_media_socket_refuses_strangers():
    with client() as c:
        with pytest.raises(Exception):
            with c.websocket_connect("/ws") as ws:
                ws.send_text('{"event":"start","start":{"streamSid":"MZ1","callSid":"CA1","customParameters":{"token":"1.bad"}}}')
                ws.receive_text()


def test_offer_validation():
    with client() as c:
        assert c.post("/api/offer", json={"sdp": "x", "type": "offer"}).status_code == 400  # no household
        assert c.post("/api/offer", content=b"not json").status_code == 400
    with client(transports=["twilio"]) as c:
        assert c.post("/api/offer", json={"sdp": "x", "type": "offer", "request_data": {"household_id": "hh_rivera"}}).status_code == 503
