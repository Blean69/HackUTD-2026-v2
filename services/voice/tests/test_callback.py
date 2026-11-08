"""Phone callback (docs/contracts.md section 10): tokens, the SignalWire request, scheduling on a fake clock, the once-per-call and
unlocked-only rules, and that no phone number ever reaches a log line. No real call is placed: HTTP goes to mocks only."""
import asyncio
import base64
import json
import random
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from loguru import logger

import alerts
import callback
import config
from bot import CallInit
from callback import CallbackManager, CallbackPlan, CallbackStore, DialError, Redactor, SignalWireDialer, api_base, make_callback_token, make_token, read_callback_token, read_token

SECRET = "voice-shared-secret"
NUMBER = "+15555550123"
OTHER = "+15555550999"
OUR = "+15555550100"  # a fictional number: tests never use a real one
S = config.Settings(
    shared_secret=SECRET, public_hostname="keystone.example", caller_hash_salt="pepper", nvidia_api_key="k",
    signalwire_space_url="example.signalwire.com", signalwire_project_id="proj-123", signalwire_api_token="tok-456", signalwire_number=OUR,
)


# ---- helpers ----------------------------------------------------------------------------------------------------------------------
class Clock:
    def __init__(self, t: float = 1_000_000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


class FakeSleep:
    """A sleep on the fake clock: records the delays, and (when `gate` is set) waits until the test opens it."""

    def __init__(self, clock: Clock):
        self.clock, self.delays, self.gate = clock, [], None

    async def __call__(self, secs: float) -> None:
        self.delays.append(secs)
        if self.gate is not None:
            await self.gate.wait()
        self.clock.t += secs


class FakeDialer(SignalWireDialer):
    def __init__(self, fail: Exception | None = None):
        super().__init__(S.signalwire_space_url, S.signalwire_project_id, S.signalwire_api_token, OUR)
        self.calls, self.fail = [], fail

    async def call(self, to, url, *, ring_secs=0, amd="off"):
        self.calls.append({"to": to, "url": url, "ring_secs": ring_secs, "amd": amd})
        if self.fail:
            raise self.fail
        return callback.DialResult(sid="CA0000000000000000000000000000cb01", status="queued")


class FakeWorker:
    def __init__(self, payload=None, error: Exception | None = None):
        self.payload, self.error, self.asked = payload, error, []

    async def alert_candidates(self, household_id):
        self.asked.append(household_id)
        if self.error:
            raise self.error
        return self.payload


def finished(sid="CAcall1", *, kind="phone", unlocked=True, household="hh_rivera", reason="hangup", cb=None, first="Marisol"):
    """What the server hands the manager when a call ends (the finished VoiceCall)."""
    return SimpleNamespace(init=CallInit(call_id=f"tel-{sid}", kind=kind, transport_label="signalwire", call_sid=sid, callback=cb), unlocked=unlocked, household_id=household if unlocked else "", first_name=first, end_reason=reason)


def manager(settings=S, *, worker=None, dialer=None, seed=1):
    clock = Clock()
    sleep = FakeSleep(clock)
    m = CallbackManager(settings, dialer=dialer or FakeDialer(), worker=worker or FakeWorker(), now=clock, sleep=sleep, rng=random.Random(seed))
    return m, clock, sleep


async def drain(m: CallbackManager) -> None:
    await asyncio.gather(*list(m.tasks), return_exceptions=True)


@pytest.fixture(autouse=True)
def _clean_redactor():
    callback.REDACTOR._exact.clear()
    yield
    callback.REDACTOR._exact.clear()


# ---- tokens -----------------------------------------------------------------------------------------------------------------------
def test_callback_token_round_trips_and_names_the_household_and_alert_only():
    t = make_callback_token(SECRET, "hh_rivera", "tpl:card_other_city", "n0nce", now=1000)
    assert read_callback_token(SECRET, t, now=1001) == {"h": "hh_rivera", "a": "tpl:card_other_city", "n": "n0nce"}
    body = json.loads(base64.urlsafe_b64decode(t.split(".")[0] + "=="))
    assert set(body) == {"h", "a", "n", "p", "e"} and body["p"] == "cb"
    assert "5555550123" not in t and "+" not in t and "/" not in t and " " not in t  # URL-safe as it stands, no number inside


def test_token_is_valid_for_about_two_minutes():
    t = make_callback_token(SECRET, "hh", "a", "n", now=1000)
    assert read_callback_token(SECRET, t, now=1000 + 119) is not None
    assert read_callback_token(SECRET, t, now=1000 + 121) is None  # expired
    assert callback.TOKEN_TTL_SECS == 120


def test_token_tampering_wrong_key_and_wrong_purpose_are_rejected():
    t = make_callback_token(SECRET, "hh_rivera", "a", "n", now=1000)
    body, _, mac = t.partition(".")
    forged = base64.urlsafe_b64encode(json.dumps({"h": "hh_other", "a": "a", "n": "n", "p": "cb", "e": 9_999_999_999}).encode()).decode().rstrip("=")
    assert read_callback_token(SECRET, f"{forged}.{mac}", now=1001) is None
    assert read_callback_token(SECRET, f"{body}.{'0' * 32}", now=1001) is None
    assert read_callback_token("other-secret", t, now=1001) is None
    assert read_callback_token("", t, now=1001) is None and read_callback_token(SECRET, None) is None and read_callback_token(SECRET, "junk") is None
    session = make_token(SECRET, "cbs", {"n": "n", "h": "hh"}, now=1000)
    assert read_token(SECRET, "cbs", session, now=1001) and read_callback_token(SECRET, session, now=1001) is None  # a session token is not a dial token
    assert read_token(SECRET, "cbs", t, now=1001) is None  # nor the other way round
    assert read_callback_token(SECRET, "x" * 5000) is None


def plan_for(m, key="tpl:card_testing"):
    alert = alerts.CallbackAlert(key=key, source="template", origin="template: card_testing", kind="fraud", title="t", detail="d", statement="s.", action="a.")
    return CallbackPlan(nonce="n1", household_id="hh_rivera", first_name="Marisol", caller_hash="abc", alert=alert, expires_at=0)


def test_both_tokens_are_single_use_and_work_in_order():
    clock = Clock()
    store = CallbackStore(SECRET, clock)
    dial = store.add(plan_for(None))
    assert len(store) == 1
    assert store.connect(make_token(SECRET, "cbs", {"n": "n1", "h": "hh_rivera"}, clock())) is None  # a session token cannot skip the webhook step
    got = store.answer(dial)
    assert got and got[0].household_id == "hh_rivera"
    assert store.answer(dial) is None  # the dial token worked once
    plan = store.connect(got[1])
    assert plan and plan.alert.key == "tpl:card_testing"
    assert store.connect(got[1]) is None and len(store) == 0  # the session token worked once, and the plan is gone


def test_a_plan_that_waits_longer_than_two_minutes_is_gone():
    clock = Clock()
    store = CallbackStore(SECRET, clock)
    dial = store.add(plan_for(None))
    clock.t += 121
    assert store.answer(dial) is None and len(store) == 0


# ---- the SignalWire request (mock HTTP) --------------------------------------------------------------------------------------------
def test_api_base_accepts_the_space_url_spellings_and_refuses_plain_http_for_real_hosts():
    assert api_base("example.signalwire.com") == "https://example.signalwire.com"
    assert api_base("https://example.signalwire.com/") == "https://example.signalwire.com"
    assert api_base("http://example.signalwire.com") == "https://example.signalwire.com"  # never send credentials in clear text
    assert api_base("http://127.0.0.1:9999") == "http://127.0.0.1:9999"  # a local mock server


async def test_dial_request_shape():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(method=req.method, url=str(req.url), auth=req.headers.get("authorization"), ctype=req.headers.get("content-type"), form={k: v[0] for k, v in parse_qs(req.content.decode()).items()})
        return httpx.Response(201, json={"sid": "CA123456", "status": "queued"})

    d = SignalWireDialer("example.signalwire.com", "proj-123", "tok-456", OUR, transport=httpx.MockTransport(handler))
    r = await d.call(NUMBER, "https://keystone.example/voice/twiml?cb=TOKEN", ring_secs=20)
    assert r == callback.DialResult(sid="CA123456", status="queued")
    assert seen["method"] == "POST" and seen["url"] == "https://example.signalwire.com/api/laml/2010-04-01/Accounts/proj-123/Calls.json"
    assert seen["auth"] == "Basic " + base64.b64encode(b"proj-123:tok-456").decode()
    assert seen["ctype"].startswith("application/x-www-form-urlencoded")
    assert seen["form"] == {"From": OUR, "To": NUMBER, "Url": "https://keystone.example/voice/twiml?cb=TOKEN", "Method": "POST", "Timeout": "20"}


async def test_answering_machine_detection_options_map_to_signalwire_fields():
    d = SignalWireDialer("example.signalwire.com", "p", "t", OUR)
    assert "MachineDetection" not in d.form(NUMBER, "u") and "Timeout" not in d.form(NUMBER, "u")
    assert d.form(NUMBER, "u", amd="enable")["MachineDetection"] == "Enable"
    assert d.form(NUMBER, "u", amd="detect_message_end")["MachineDetection"] == "DetectMessageEnd"


async def test_dial_errors_carry_status_and_code_but_never_the_number():
    def handler(req):
        return httpx.Response(400, json={"code": 21211, "message": f"The 'To' number {NUMBER} is not a valid phone number", "status": 400})

    d = SignalWireDialer("example.signalwire.com", "p", "t", OUR, transport=httpx.MockTransport(handler))
    with pytest.raises(DialError) as e:
        await d.call(NUMBER, "u")
    assert e.value.status == 400 and e.value.code == "21211" and "5555550123" not in str(e.value)

    def boom(req):
        raise httpx.ConnectError(f"cannot reach {NUMBER}")

    with pytest.raises(DialError) as e2:
        await SignalWireDialer("example.signalwire.com", "p", "t", OUR, transport=httpx.MockTransport(boom)).call(NUMBER, "u")
    assert e2.value.code == "ConnectError" and "5555550123" not in str(e2.value)
    with pytest.raises(DialError):
        await SignalWireDialer("", "", "", "").call(NUMBER, "u")


def test_against_a_real_socket_mock_signalwire_server():
    """The request over an actual HTTP connection to a local mock of the Compatibility API (nothing leaves this machine)."""
    got = {}

    class Mock(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["content-length"])).decode()
            got.update(path=self.path, auth=self.headers.get("authorization"), form={k: v[0] for k, v in parse_qs(body).items()})
            out = json.dumps({"sid": "CAmock0000000001", "status": "queued"}).encode()
            self.send_response(201)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        d = SignalWireDialer(f"http://127.0.0.1:{srv.server_address[1]}", "proj-123", "tok-456", OUR)
        r = asyncio.run(d.call(NUMBER, "https://keystone.example/voice/twiml?cb=T", ring_secs=20, amd="enable"))
    finally:
        srv.shutdown()
    assert r.sid == "CAmock0000000001"
    assert got["path"] == "/api/laml/2010-04-01/Accounts/proj-123/Calls.json" and got["auth"].startswith("Basic ")
    assert got["form"]["To"] == NUMBER and got["form"]["From"] == OUR and got["form"]["Method"] == "POST" and got["form"]["MachineDetection"] == "Enable"


# ---- scheduling on a fake clock ----------------------------------------------------------------------------------------------------
async def test_one_call_is_placed_after_the_delay_with_a_signed_url_and_the_number_is_dropped():
    m, clock, sleep = manager()
    sleep.gate = asyncio.Event()
    assert m.remember("CAcall1", NUMBER)
    assert m.call_ended(finished()) == "scheduled"
    assert m._numbers == {} and NUMBER not in str(m.__dict__.get("_numbers"))  # the number left the table when the call ended
    for _ in range(5):
        await asyncio.sleep(0)
    assert sleep.delays == [15.0] and m.dialer.calls == []  # waiting: nothing is dialled before VOICE_CALLBACK_SECS are up
    sleep.gate.set()
    await drain(m)
    assert len(m.dialer.calls) == 1 and clock.t == 1_000_015.0
    c = m.dialer.calls[0]
    assert c["to"] == NUMBER and c["ring_secs"] == 20 and c["amd"] == "off"
    parts = urlsplit(c["url"])
    assert (parts.scheme, parts.netloc, parts.path) == ("https", "keystone.example", "/voice/twiml")
    claims = read_callback_token(SECRET, parse_qs(parts.query)["cb"][0], now=clock.t)
    assert claims["h"] == "hh_rivera" and claims["a"].startswith(("tpl:", "alert:", "txn:", "forecast:")) and NUMBER not in c["url"] and "5555550123" not in c["url"]
    assert len(m.store) == 1 and m.placed == 1


def test_default_delay_is_fifteen_seconds_and_is_configurable(monkeypatch):
    for k in list(__import__("os").environ):
        if k.startswith("VOICE_CALLBACK"):
            monkeypatch.delenv(k, raising=False)
    assert config.load_settings().callback_secs == 15.0 and config.load_settings().callback_enabled is True
    monkeypatch.setenv("VOICE_CALLBACK_SECS", "7")
    monkeypatch.setenv("VOICE_CALLBACK_ENABLED", "0")
    monkeypatch.setenv("VOICE_CALLBACK_AMD", "bogus")
    s = config.load_settings()
    assert s.callback_secs == 7.0 and s.callback_enabled is False and s.callback_amd == "off"


async def test_only_a_phone_call_that_passed_the_pin_gets_a_callback():
    m, _, _ = manager()
    for sid, call, why in [
        ("A", finished("A", kind="webrtc"), "not_phone"),
        ("B", finished("B", unlocked=False), "never_unlocked"),
        ("C", finished("C", reason="error: start failed"), "errored"),
        ("D", finished("D", cb=SimpleNamespace()), "is_callback"),
    ]:
        m.remember(sid, NUMBER)
        assert m.call_ended(call) == why, sid
        assert m._numbers == {}, sid  # dropped whatever the outcome
    await drain(m)
    assert m.dialer.calls == [] and m.tasks == set()


async def test_once_per_call_and_a_caller_cooldown_and_an_hourly_cap():
    m, clock, _ = manager(S.with_overrides(callback_cooldown_secs=60, callback_max_per_hour=3))
    m.remember("CA1", NUMBER)
    assert m.call_ended(finished("CA1")) == "scheduled"
    assert m.call_ended(finished("CA1")) == "no_number"  # the number is gone: the same call cannot schedule twice
    m.remember("CA1", NUMBER)
    assert m.call_ended(finished("CA1")) == "already_scheduled"
    m.remember("CA2", NUMBER)
    assert m.call_ended(finished("CA2")) == "cooldown"  # the same caller again within a minute
    clock.t += 61
    m.remember("CA3", NUMBER)
    assert m.call_ended(finished("CA3")) == "scheduled"
    m.remember("CA4", OTHER)
    assert m.call_ended(finished("CA4")) == "scheduled"
    m.remember("CA5", "+15555550777")
    assert m.call_ended(finished("CA5")) == "hourly_cap"
    clock.t += 3600
    m.remember("CA6", "+15555550777")
    assert m.call_ended(finished("CA6")) == "scheduled"
    await drain(m)
    assert len(m.dialer.calls) == 4


async def test_off_unless_enabled_and_fully_configured():
    for over in ({"callback_enabled": False}, {"signalwire_api_token": ""}, {"signalwire_space_url": ""}, {"signalwire_number": ""}, {"shared_secret": ""}, {"transports": ["webrtc"]}, {"enabled": False}):
        m, _, _ = manager(S.with_overrides(**over))
        assert not m.enabled, over
        assert m.remember("CA1", NUMBER) is False and m._numbers == {}  # nothing is even remembered
        assert m.call_ended(finished("CA1")) == "disabled"
    assert manager()[0].enabled
    assert "SIGNALWIRE_API_TOKEN" in manager(S.with_overrides(signalwire_api_token=""))[0].status_line()


def test_only_dialable_numbers_are_remembered():
    m, _, _ = manager()
    for bad in ("", "anonymous", "266696687", "+1555", "5555550123", "+0123456789", OUR, "+1 555 555 0123"):
        assert m.remember("CA1", bad) is False, bad
    assert m.remember("CA1", NUMBER) and m.remember("CA2", OTHER)


async def test_a_remembered_number_expires_even_if_its_call_never_ends():
    m, clock, _ = manager()
    m.remember("CA1", NUMBER)
    clock.t += callback.NUMBER_TTL_SECS + 1
    m.remember("CA2", OTHER)  # any later call sweeps the old one
    assert list(m._numbers) == ["CA2"] and NUMBER.lstrip("+") not in callback.REDACTOR._exact


async def test_a_failed_dial_is_logged_without_the_number_and_never_retried():
    lines = []
    sink = logger.add(lambda mm: lines.append(str(mm)), level="DEBUG")
    try:
        callback.install_log_redaction()
        m, _, _ = manager(dialer=FakeDialer(fail=DialError(400, "21211", f"bad number {NUMBER}")))
        m.remember("CA1", NUMBER)
        m.call_ended(finished("CA1"))
        await drain(m)
        assert len(m.dialer.calls) == 1 and len(m.store) == 0 and m.placed == 0  # one attempt, the plan was thrown away
    finally:
        logger.remove(sink)
    text = "".join(lines)
    assert "callback not placed" in text and "21211" in text and "5555550123" not in text


class FlakyDialer(FakeDialer):
    """Fails the first `times` dials with `fail`, then places the call."""

    def __init__(self, fail: Exception, times: int = 1):
        super().__init__()
        self._fail, self._times = fail, times

    async def call(self, to, url, *, ring_secs=0, amd="off"):
        if self._times > 0:
            self._times -= 1
            self.calls.append({"to": to, "url": url, "ring_secs": ring_secs, "amd": amd})
            raise self._fail
        return await super().call(to, url, ring_secs=ring_secs, amd=amd)


@pytest.mark.parametrize("fail", [DialError(503, "service_unavailable"), DialError(429, "too_many_requests"), DialError(0, "ConnectError")])
async def test_a_refused_dial_is_retried_once_and_the_callback_still_happens(fail):
    m, _, sleep = manager(dialer=FlakyDialer(fail))
    m.remember("CA1", NUMBER)
    assert m.call_ended(finished("CA1")) == "scheduled"
    await drain(m)
    assert len(m.dialer.calls) == 2 and m.placed == 1 and len(m.store) == 1  # refused, then placed; the plan waits for the answer


@pytest.mark.parametrize("fail", [DialError(0, "ReadTimeout"), DialError(500, "internal"), DialError(400, "21211")])
async def test_a_dial_that_may_have_rung_or_can_never_work_is_not_retried(fail):
    m, _, _ = manager(dialer=FlakyDialer(fail))
    m.remember("CA1", NUMBER)
    m.call_ended(finished("CA1"))
    await drain(m)
    assert len(m.dialer.calls) == 1 and m.placed == 0 and len(m.store) == 0  # never ring twice


@pytest.mark.parametrize("fail", [DialError(503, "service_unavailable")])
async def test_a_second_refusal_gives_up(fail):
    m, _, _ = manager(dialer=FlakyDialer(fail, times=2))
    m.remember("CA1", NUMBER)
    m.call_ended(finished("CA1"))
    await drain(m)
    assert len(m.dialer.calls) == 2 and m.placed == 0 and len(m.store) == 0


# ---- alert selection inside the flow -----------------------------------------------------------------------------------------------
async def test_the_alert_comes_from_real_signals_and_a_used_one_is_not_repeated_straight_away():
    payload = {
        "household_id": "hh_rivera", "context": {"as_of": "2026-11-07", "city": "Dallas", "state": "TX", "accounts": [{"type": "credit_card", "nickname": "Rewards Visa", "last4": "4417", "balance": 1500}]},
        "candidates": [{"id": "txn:t1", "type": "scam_payment", "source": "rule", "severity": "critical", "kind": "scam", "title": "Possible scam payment to CVS", "detail": "d", "related_ids": ["t1"], "facts": {"amount": 500, "merchant": "CVS Pharmacy", "date": "2026-11-04"}, "priority": 85}],
    }
    w = FakeWorker(payload)
    m, _, _ = manager(S.with_overrides(callback_cooldown_secs=0), worker=w)
    first = await m.pick_alert("hh_rivera")
    assert first.source == "real" and first.key == "txn:t1" and "CVS Pharmacy" in first.statement
    second = await m.pick_alert("hh_rivera")  # same household a moment later: the real one was just used, so a template this time
    assert second.source == "template" and w.asked == ["hh_rivera", "hh_rivera"]


async def test_worker_down_means_a_template_not_a_missed_callback():
    m, _, _ = manager(worker=FakeWorker(error=RuntimeError("worker is down")))
    a = await m.pick_alert("hh_rivera")
    assert a.source == "template" and a.statement
    m.remember("CA1", NUMBER)
    assert m.call_ended(finished("CA1")) == "scheduled"
    await drain(m)
    assert len(m.dialer.calls) == 1


# ---- log redaction -----------------------------------------------------------------------------------------------------------------
def test_redactor_masks_the_numbers_held_in_memory_in_any_spelling_and_number_shapes():
    r = Redactor()
    r.add(NUMBER)
    for text in (f"caller {NUMBER} rang", "from 15555550123", "from 1 (555) 555-0123", "x +1 555 555 0123 y", "(555) 555-0123", "555-555-0123", "5555550123", "+442071838750"):
        out = r.redact(text)
        assert "[number]" in out and not re.search(r"\d{7,}", out), text
    assert r.redact("run_41_ab12 took 1500 ms, hash 0123456789abcdef01234567, score 742") == "run_41_ab12 took 1500 ms, hash 0123456789abcdef01234567, score 742"
    r.discard(NUMBER)
    assert r.redact("15555550123 again").count("[number]") == 1  # now only the number-shaped pattern catches it
    assert "[number]" not in Redactor().redact("sid CA1234567890abcdef1234567890abcdef, 12 turns")


async def test_no_log_line_in_the_whole_callback_flow_contains_the_number():
    lines = []
    sink = logger.add(lambda mm: lines.append(str(mm)), level="DEBUG")
    try:
        callback.install_log_redaction()
        m, _, _ = manager()
        m.remember("CA1", NUMBER)
        logger.info(f"somebody logged the raw number by mistake: {NUMBER}")  # even a careless log line is masked while the number is held
        m.call_ended(finished("CA1"))
        await drain(m)
        logger.info(f"later, a developer prints it again: {NUMBER}")  # no longer held, but number-shaped, so still masked
    finally:
        logger.remove(sink)
    text = "".join(lines)
    assert "callback scheduled" in text and "callback call placed" in text
    assert "5555550123" not in text and "555 555" not in text and NUMBER not in text
    assert callback.caller_hash("pepper", NUMBER)[:8] in text  # the salted hash is what identifies the caller


async def test_manager_to_dialer_to_mock_signalwire_end_to_end():
    """The scheduler with the REAL dialer talking to a mock SignalWire API: the request that would go out, token and all."""
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append({"url": str(req.url), "auth": req.headers["authorization"], "form": {k: v[0] for k, v in parse_qs(req.content.decode()).items()}})
        return httpx.Response(201, json={"sid": "CAfeedface00000000", "status": "queued"})

    clock = Clock()
    dialer = SignalWireDialer.from_settings(S, transport=httpx.MockTransport(handler))
    m = CallbackManager(S, dialer=dialer, worker=FakeWorker(), now=clock, sleep=FakeSleep(clock), rng=random.Random(2))
    m.remember("CAcall1", NUMBER)
    assert m.call_ended(finished()) == "scheduled"
    await drain(m)
    assert len(seen) == 1
    req = seen[0]
    assert req["url"] == "https://example.signalwire.com/api/laml/2010-04-01/Accounts/proj-123/Calls.json"
    assert req["auth"] == "Basic " + base64.b64encode(b"proj-123:tok-456").decode()
    f = req["form"]
    assert (f["From"], f["To"], f["Method"], f["Timeout"]) == (OUR, NUMBER, "POST", "20") and f["Url"].startswith("https://keystone.example/voice/twiml?cb=")
    token = parse_qs(urlsplit(f["Url"]).query)["cb"][0]
    got = m.store.answer(token)  # the very token that went to SignalWire opens the plan
    assert got and got[0].household_id == "hh_rivera" and got[0].first_name == "Marisol" and got[0].caller_hash == callback.caller_hash("pepper", NUMBER)
