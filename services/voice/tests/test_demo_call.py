"""The demo call: the in-app "try a call" buttons can ring ONE configured phone (DEMO_PHONE) and read an alert aloud. The browser never
sends or sees the number; it is off unless DEMO_PHONE is set; one call per 45 s."""
import random

import pytest
from fastapi.testclient import TestClient

import callback
import config
import server
from callback import CallbackManager, SignalWireDialer

DEMO = "+15555550142"  # fictional
S = config.Settings(
    shared_secret="s", public_hostname="localhost", caller_hash_salt="pepper", nvidia_api_key="k",
    signalwire_space_url="example.signalwire.com", signalwire_project_id="proj", signalwire_api_token="tok", signalwire_number="+15555550100",
    demo_phone=DEMO,
)


class TwimlDialer(SignalWireDialer):
    def __init__(self, s=S, fail: Exception | None = None):
        super().__init__(s.signalwire_space_url, s.signalwire_project_id, s.signalwire_api_token, s.signalwire_number)
        self.calls, self.fail, self.next_status = [], fail, "ringing"

    async def call_twiml(self, to, twiml, *, ring_secs=25):
        self.calls.append({"to": to, "twiml": twiml})
        if self.fail:
            raise self.fail
        return callback.DialResult(sid="CA00000000000000000000000000demo1", status="queued")

    async def status(self, sid):
        return self.next_status


class NoWorker:
    async def alert_candidates(self, household_id):
        return None  # worker unavailable: a template alert is read


def client(s=S, dialer=None):
    d = dialer or TwimlDialer(s)
    cb = CallbackManager(s, dialer=d, worker=NoWorker(), rng=random.Random(3))
    return TestClient(server.create_app(s, callbacks=cb)), d


def test_rings_only_the_configured_number_reads_an_alert_and_never_echoes_the_number():
    c, d = client()
    r = c.post("/api/demo_call", json={"household_id": "hh_rivera", "to": "+15550001111"})  # a "to" from the browser is ignored
    assert r.status_code == 200 and r.json() == {"ok": True, "status": "ringing"}  # the real status after SignalWire took it
    assert len(d.calls) == 1 and d.calls[0]["to"] == DEMO
    tw = d.calls[0]["twiml"]
    assert tw.startswith("<Response>") and "I&#x27;m an AI" not in tw and "I'm an AI" in tw and "Open the app" in tw
    assert DEMO not in r.text and DEMO not in c.get("/health").text and c.get("/health").json()["demo_call"] is True


def test_one_call_per_two_minutes():
    c, d = client()
    assert c.post("/api/demo_call", json={"household_id": "hh_rivera"}).status_code == 200
    assert c.post("/api/demo_call", json={"household_id": "hh_rivera"}).status_code == 429
    assert len(d.calls) == 1


def test_off_without_a_demo_number_and_bad_requests_are_refused():
    off = S.with_overrides(demo_phone="")
    c, d = client(off)
    assert c.post("/api/demo_call", json={"household_id": "hh_rivera"}).status_code == 404 and c.get("/health").json()["demo_call"] is False
    c2, _ = client(S.with_overrides(demo_phone="not-a-number"))
    assert c2.post("/api/demo_call", json={"household_id": "hh_rivera"}).status_code == 404
    c3, d3 = client()
    assert c3.post("/api/demo_call", json={}).status_code == 400 and d3.calls == []


def test_a_refused_dial_is_a_502_and_does_not_burn_the_cooldown():
    c, d = client(dialer=TwimlDialer(fail=callback.DialError(403, "21219", "unverified")))
    assert c.post("/api/demo_call", json={"household_id": "hh_rivera"}).status_code == 502
    d.fail = None
    assert c.post("/api/demo_call", json={"household_id": "hh_rivera"}).status_code == 200


def test_a_call_the_carrier_refuses_at_once_is_reported_as_not_ok():
    d = TwimlDialer()
    d.next_status = "failed"
    c, _ = client(dialer=d)
    r = c.post("/api/demo_call", json={"household_id": "hh_rivera"})
    assert r.status_code == 200 and r.json() == {"ok": False, "status": "failed"}
