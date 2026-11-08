"""The callback call inside VoiceCall: starts a callback run (already unlocked), puts the alert on the dashboard through the worker, THEN says it;
a normal call that passes the PIN is marked unlocked (that is what makes a callback possible); goodbyes mention the ring-back."""
import random
from types import SimpleNamespace

import pytest
from pipecat.frames.frames import TTSSpeakFrame

import alerts
import bot
import prompts
from bot import CallInit, VoiceCall
from callback import CallbackPlan
from config import Settings
from worker_client import WorkerError


class FakeClient:
    def __init__(self, alert_error: Exception | None = None, alert_result=None):
        self.started, self.alerts, self.alert_error, self.alert_result = [], [], alert_error, alert_result or {"ok": True, "alert_id": "callback:hh_rivera:tel-CA1", "written": True}

    async def start(self, **body):
        self.started.append(body)
        return {"run_id": "run_9_abcd", "family": "Rivera family", "first_name": body.get("first_name", ""), "brief": ["Cushion: about 3 months."], "as_of": "2026-11-07"}

    async def tools(self):
        return []

    async def callback_alert(self, run_id, alert):
        self.alerts.append((run_id, alert))
        if self.alert_error:
            raise self.alert_error
        return self.alert_result

    async def trace(self, *a, **k):
        return {}

    async def end(self, *a, **k):
        return {}

    async def aclose(self):
        pass


class FakePipeline:
    def __init__(self):
        self.frames = []

    async def queue_frame(self, f):
        self.frames.append(f)

    async def queue_frames(self, fs):
        self.frames.extend(fs)

    def spoken(self):
        return [f.text for f in self.frames if isinstance(f, TTSSpeakFrame)]


def make(callback=None, client=None, **init_over):
    bot._tools_cache = None  # the module-level tool cache must not leak between tests
    init = CallInit(call_id="tel-CA1", kind="phone", transport_label="signalwire", call_sid="CA1", callback=callback, caller="callback" if callback else "new", household_id=callback.household_id if callback else "", **init_over)
    call = VoiceCall(Settings(nvidia_api_key="k", llm_api_key="k", llm_warm=False), init, transport=None, client=client or FakeClient())
    call.worker = FakePipeline()
    return call


def plan(alert=None):
    alert = alert or alerts.select_alert(None, rng=random.Random(1), today=None)
    return CallbackPlan(nonce="n1", household_id="hh_rivera", first_name="Marisol", caller_hash="abc", alert=alert, expires_at=0)


async def test_the_callback_starts_a_callback_run_posts_the_alert_then_says_it():
    p = plan()
    client = FakeClient()
    call = make(p, client)
    await call._activate_callback()
    start = client.started[0]
    assert start["callback"] is True and start["caller"] == "callback" and start["household_id"] == "hh_rivera" and start["first_name"] == "Marisol" and start["transport"] == "signalwire"
    assert client.alerts == [("run_9_abcd", p.alert.api_payload())]  # written through the worker against the callback's own run
    assert call.worker.spoken() == [alerts.spoken_script(p.alert, posted=True)]
    assert prompts.CALLBACK_DASHBOARD in call.worker.spoken()[0] and p.alert.statement in call.worker.spoken()[0] and p.alert.action in call.worker.spoken()[0]
    system = call.context.messages[0]["content"]
    assert "THIS IS A CALLBACK" in system and p.alert.statement in system and "Rivera family" in system
    assert call.unlocked and call.household_id == "hh_rivera" and call.run_id == "run_9_abcd"


async def test_if_the_alert_cannot_be_written_brian_does_not_claim_it_is_on_the_dashboard():
    p = plan()
    call = make(p, FakeClient(alert_error=WorkerError(500, "internal_error", "boom")))
    await call._activate_callback()
    said = call.worker.spoken()[0]
    assert p.alert.statement in said and prompts.CALLBACK_DASHBOARD not in said and said.endswith(prompts.CALLBACK_ASK)
    assert any(e.get("kind") == "error" for e in call.reporter._pending)  # and the trace says why
    ok_false = make(p, FakeClient(alert_result={"ok": False, "written": False}))
    await ok_false._activate_callback()
    assert prompts.CALLBACK_DASHBOARD not in ok_false.worker.spoken()[0]


async def test_a_reused_open_critical_alert_counts_as_on_the_dashboard():
    a = alerts.select_alert({"candidates": [{"id": "alert:rule:hh:ct", "type": "open_alert", "severity": "critical", "alert_id": "rule:hh:ct", "kind": "fraud", "title": "Card testing on Visa", "detail": "x", "priority": 90, "facts": {}}]})
    client = FakeClient(alert_result={"ok": True, "alert_id": "rule:hh:ct", "written": False, "reused": True})
    call = make(plan(a), client)
    await call._activate_callback()
    assert client.alerts[0][1]["existing_alert_id"] == "rule:hh:ct" and prompts.CALLBACK_DASHBOARD in call.worker.spoken()[0]


async def test_if_the_run_cannot_start_the_callback_ends_without_saying_the_alert():
    class Down(FakeClient):
        async def start(self, **body):
            raise WorkerError(503, "spacetime_unavailable")

    call = make(plan(), Down())
    await call._activate_callback()
    assert call.end_reason.startswith("error: start failed") and call.client.alerts == []
    assert call.worker.spoken() == [prompts.PIN_UNAVAILABLE]  # an apology and a hang-up (the EndFrame follows it)


async def test_a_normal_call_that_passes_the_pin_is_marked_unlocked_for_a_possible_callback():
    client = FakeClient()
    call = make(None, client, may_ring_back=True)
    assert call.unlocked is False and call.household_id == ""
    await call._on_pin_ok({"household_id": "hh_rivera", "first_name": "Marisol", "member_id": "m1"})
    assert call.unlocked and call.household_id == "hh_rivera" and call.first_name == "Marisol"
    assert "callback" not in client.started[0]  # an ordinary run
    assert prompts.RING_BACK in call.context.messages[0]["content"]  # the model is told to say it when he says goodbye
    assert call.worker.spoken() == [prompts.UNLOCKED.format(family="Rivera family")]


async def test_a_call_that_never_passes_the_pin_stays_locked():
    call = make(None)
    await call._on_pin_locked("pin_failed")
    assert call.unlocked is False and call.end_reason == "pin_failed"


def test_goodbyes_mention_the_ring_back_only_when_a_callback_can_follow():
    assert prompts.RING_BACK in prompts.idle_bye(True) and prompts.RING_BACK in prompts.max_call_bye(True)
    assert prompts.idle_bye(False) == prompts.IDLE_BYE and prompts.max_call_bye(False) == prompts.MAX_CALL_BYE
    with_hint = prompts.system_prompt(family="Rivera family", first_name="", brief=[], today="2026-11-07", channel="phone", may_ring_back=True)
    without = prompts.system_prompt(family="Rivera family", first_name="", brief=[], today="2026-11-07", channel="phone")
    assert "might ring them right back" in with_hint and prompts.RING_BACK in with_hint and "ring them right back" not in without
    assert prompts.CALLBACK_OPENING.startswith("Hi, it's Brian again from your Brianotron app")


async def test_a_callback_call_has_no_pin_gate_and_its_goodbyes_do_not_promise_another_callback():
    call = make(plan())
    assert call.init.may_ring_back is False and call.init.callback is not None
    await call._activate_callback()
    assert prompts.RING_BACK not in call.context.messages[0]["content"]
