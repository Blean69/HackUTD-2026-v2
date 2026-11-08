"""The callback through the HTTP/WebSocket edge: /twiml remembers the caller's number in memory, the call ends, a callback is dialled (mock),
/twiml?cb= verifies its signature and single-use token and streams a callback session, /ws only takes that session once.
VoiceCall is replaced by a stub (no audio, no NVIDIA); SignalWire is a mock."""
import json
import re
import time
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from fastapi.testclient import TestClient

import alerts
import callback
import config
import prompts
import server
from callback import CallbackManager
from test_callback import FakeDialer, FakeSleep, FakeWorker, Clock, NUMBER, OUR, SECRET, plan_for
from twiml import signalwire_signature

KEY = "PSK_signingKey0123"
S = config.Settings(
    shared_secret=SECRET, signature_token=KEY, public_hostname="keystone.example", caller_hash_salt="pepper", nvidia_api_key="k",
    signalwire_space_url="example.signalwire.com", signalwire_project_id="proj", signalwire_api_token="tok", signalwire_number=OUR,
    callback_secs=15.0, callback_cooldown_secs=0,
)


class StubCall:
    """Stands in for VoiceCall: remembers its init; a normal call 'passes the PIN' and ends, a callback call just ends."""

    made: list["StubCall"] = []

    def __init__(self, settings, init, transport):
        self.s, self.init, self.transport = settings, init, transport
        self.unlocked, self.household_id, self.first_name, self.end_reason = False, init.household_id, "", "hangup"
        StubCall.made.append(self)

    async def run(self):
        if self.init.callback is None:
            self.unlocked, self.household_id, self.first_name = True, "hh_rivera", "Marisol"
        return self.end_reason


@pytest.fixture(autouse=True)
def _stub(monkeypatch):
    StubCall.made = []
    callback.REDACTOR._exact.clear()
    monkeypatch.setattr(server, "VoiceCall", StubCall)
    yield
    callback.REDACTOR._exact.clear()


def build(settings=S, **mk):
    clock = Clock()
    m = CallbackManager(settings, dialer=FakeDialer(), worker=FakeWorker(**mk), now=clock, sleep=FakeSleep(clock))
    return m, TestClient(server.create_app(settings, callbacks=m))


def post_twiml(c, form, query=""):
    body = urlencode(form).encode()
    url = "https://keystone.example/voice/twiml" + (f"?{query}" if query else "")
    return c.post("/twiml" + (f"?{query}" if query else ""), content=body, headers={"content-type": "application/x-www-form-urlencoded", "X-SignalWire-SHA256-Signature": signalwire_signature(KEY, url, body)})


def stream_params(xml):
    return dict(re.findall(r'<Parameter name="([^"]+)" value="([^"]*)"/>', xml))


def _start(ws, params, call_sid):
    ws.send_text(json.dumps({"event": "start", "start": {"streamSid": "MZ1", "callSid": call_sid, "customParameters": params}}))


def wait_for(cond, secs=3.0):
    end = time.time() + secs
    while time.time() < end and not cond():
        time.sleep(0.02)
    return cond()


def open_stream(c, params, call_sid):
    """A stream the server accepts: it starts a (stub) call, which runs to its end."""
    before = len(StubCall.made)
    with c.websocket_connect("/ws") as ws:
        _start(ws, params, call_sid)
        assert wait_for(lambda: len(StubCall.made) > before), "the server did not start a call"
    time.sleep(0.1)


def open_refused(c, params, call_sid):
    """A stream the server closes without starting anything."""
    before = len(StubCall.made)
    with pytest.raises(Exception):
        with c.websocket_connect("/ws") as ws:
            _start(ws, params, call_sid)
            ws.receive_text()
    assert len(StubCall.made) == before


def test_an_inbound_call_keeps_the_number_in_memory_only_and_never_echoes_it():
    m, c = build()
    with c:
        r = post_twiml(c, {"CallSid": "CAin1", "From": NUMBER, "To": OUR})
        assert r.status_code == 200 and "<Connect><Stream" in r.text and "5555550123" not in r.text
        assert set(m._numbers) == {"CAin1"} and m._numbers["CAin1"][0] == NUMBER  # the one place it lives
        assert "caller_hash" in stream_params(r.text) and "cb_session" not in stream_params(r.text)
        assert c.get("/health").json()["callback"] is True and "5555550123" not in c.get("/health").text


def test_nothing_is_remembered_when_callbacks_are_off():
    m, c = build(S.with_overrides(callback_enabled=False))
    with c:
        post_twiml(c, {"CallSid": "CAin1", "From": NUMBER})
        assert m._numbers == {} and c.get("/health").json()["callback"] is False


def test_whole_flow_call_ends_then_one_callback_is_dialled_then_the_callback_streams_once():
    m, c = build()
    with c:
        # 1. the inbound call: webhook (number remembered), media stream (PIN passes in the stub), hang-up
        tw = post_twiml(c, {"CallSid": "CAin1", "From": NUMBER, "To": OUR})
        p = stream_params(tw.text)
        open_stream(c, {"token": p["token"], "call_sid": "CAin1", "caller_hash": p["caller_hash"]}, "CAin1")
        first = StubCall.made[0]
        assert first.init.may_ring_back is True and first.init.callback is None and first.init.call_sid == "CAin1"  # goodbyes say he might ring back
        # 2. exactly one outbound call is placed, after the 15 s wait (fake clock), with the signed single-use URL
        assert wait_for(lambda: len(m.dialer.calls) == 1)
        time.sleep(0.2)
        assert len(m.dialer.calls) == 1 and m._numbers == {} and m.dialer.calls[0]["to"] == NUMBER
        dial_url = m.dialer.calls[0]["url"]
        parts = urlsplit(dial_url)
        assert parts.path == "/voice/twiml" and list(parse_qs(parts.query)) == ["cb"] and "5555550123" not in dial_url
        # 3. SignalWire signs the webhook of its outbound call too: a wrong signature is refused and does NOT burn the token
        bad = c.post(f"/twiml?{parts.query}", data={"CallSid": "CAout1", "From": OUR, "To": NUMBER}, headers={"X-SignalWire-SHA256-Signature": "0" * 64})
        assert bad.status_code == 403
        # 4. the signed webhook gets the stream with a callback session token, and no number anywhere
        ok = post_twiml(c, {"CallSid": "CAout1", "From": OUR, "To": NUMBER, "Direction": "outbound-api"}, query=parts.query)
        assert ok.status_code == 200 and "<Connect><Stream" in ok.text and "5555550123" not in ok.text
        cp = stream_params(ok.text)
        assert cp["cb_session"] and cp["token"] and cp["caller_hash"] == callback.caller_hash("pepper", NUMBER)
        # 5. the dial token works once
        again = post_twiml(c, {"CallSid": "CAout1", "From": OUR, "To": NUMBER}, query=parts.query)
        assert "<Hangup/>" in again.text and "<Connect>" not in again.text and prompts.CALLBACK_EXPIRED in again.text
        # 6. the media stream claims the session: unlocked for that household, a callback, never followed by another callback
        open_stream(c, {"token": cp["token"], "call_sid": "CAout1", "caller_hash": cp["caller_hash"], "cb_session": cp["cb_session"]}, "CAout1")
        cb_call = StubCall.made[1]
        assert cb_call.init.callback is not None and cb_call.init.callback.household_id == "hh_rivera" and cb_call.init.household_id == "hh_rivera"
        assert cb_call.init.caller == "callback" and cb_call.init.may_ring_back is False and cb_call.init.kind == "phone"
        assert cb_call.init.callback.alert.severity == "critical" and cb_call.init.callback.first_name == "Marisol"
        time.sleep(0.2)
        assert len(m.dialer.calls) == 1  # the callback call ending placed nothing new
        # 7. the session token works once
        open_refused(c, {"token": p["token"], "call_sid": "CAout1", "cb_session": cp["cb_session"]}, "CAout1")
        assert len(StubCall.made) == 2


def test_a_callback_stream_without_a_good_session_is_refused_and_not_run_as_a_pin_call():
    m, c = build()
    with c:
        tok = server.make_stream_token(SECRET)
        open_refused(c, {"token": tok, "cb_session": "forged.token"}, "CAx")
        open_refused(c, {"token": tok, "cb_session": callback.make_token(SECRET, "cbs", {"n": "nope", "h": "hh_rivera"})}, "CAx")
        assert StubCall.made == []


def test_bad_or_expired_callback_tokens_get_a_polite_hang_up():
    m, c = build()
    with c:
        for q in ("cb=junk", "cb=" + callback.make_callback_token("other-secret", "hh_rivera", "a", "n"), "cb="):
            r = post_twiml(c, {"CallSid": "CA1", "From": OUR, "To": NUMBER}, query=q)
            assert r.status_code == 200 and "<Hangup/>" in r.text and "<Connect>" not in r.text, q
        dial = m.store.add(plan_for(m))
        m._now.t += 121  # the person took more than two minutes to pick up
        late = post_twiml(c, {"CallSid": "CA1", "From": OUR, "To": NUMBER}, query=f"cb={dial}")
        assert "<Hangup/>" in late.text and "<Connect>" not in late.text


def test_answering_machine_detection_hangs_up_or_leaves_only_a_private_message():
    m, c = build(S.with_overrides(callback_amd="detect_message_end"))
    with c:
        def hit(answered_by):
            dial = m.store.add(plan_for(m))
            return post_twiml(c, {"CallSid": "CAo", "From": OUR, "To": NUMBER, "AnsweredBy": answered_by}, query=f"cb={dial}")

        vm = hit("machine_end_beep")
        assert "<Say>" in vm.text and "<Hangup/>" in vm.text and "<Connect>" not in vm.text and "critical alert" in vm.text
        assert not re.search(r"\$|\d", vm.text.split("<Response>")[1])  # no amounts, no card digits, nothing private on a voicemail
        assert len(m.store) == 0
        early = hit("machine_start")
        assert "<Hangup/>" in early.text and "<Say>" not in early.text and "<Connect>" not in early.text
        assert "<Connect><Stream" in hit("human").text and "<Connect><Stream" in hit("unknown").text
    m2, c2 = build()  # detection off: AnsweredBy is not even looked at
    with c2:
        dial = m2.store.add(plan_for(m2))
        assert "<Connect><Stream" in post_twiml(c2, {"CallSid": "CAo", "AnsweredBy": "machine_start"}, query=f"cb={dial}").text


def test_a_web_call_never_triggers_a_callback():
    m, c = build()
    with c:
        # the browser path does not go through /twiml or /ws at all, so no number was ever remembered; the manager also refuses the kind
        assert m._numbers == {}
        assert m.call_ended(type("C", (), {"init": server.CallInit(call_id="web-1", kind="webrtc", transport_label="webrtc", household_id="hh"), "unlocked": True, "household_id": "hh", "first_name": "", "end_reason": "hangup"})()) == "not_phone"


def test_health_reports_the_noise_filter_and_barge_in_settings_without_secrets():
    m, c = build()
    with c:
        body = c.get("/health").json()
    assert body["noise_filter"]["webrtc"] == "rnnoise" and body["noise_filter"]["phone"] == "off" and isinstance(body["noise_filter"]["installed"], bool)
    assert body["barge_in_words"] == {"webrtc": 3, "phone": 2} and "tok" not in str(body) and SECRET not in str(body)
