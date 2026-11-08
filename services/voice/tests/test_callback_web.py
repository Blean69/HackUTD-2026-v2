"""The in-app callback (docs/contracts.md section 13): Brian rings in the app, and answering opens a browser call in callback mode.
Same alert choice and opening as the phone callback, and no phone number anywhere."""
import random

import config
from callback import CallbackManager, CallbackPlan

S = config.Settings(shared_secret="voice-shared-secret", public_hostname="keystone.example", caller_hash_salt="pepper", nvidia_api_key="k")

PAYLOAD = {
    "household_id": "hh_rivera",
    "context": {"as_of": "2026-11-07", "city": "Dallas", "state": "TX", "accounts": [{"type": "credit_card", "nickname": "Rewards Visa", "last4": "4417", "balance": 1500}]},
    "candidates": [
        {"id": "txn:t1", "type": "scam_payment", "source": "rule", "severity": "critical", "kind": "scam", "title": "Possible scam payment to CVS", "detail": "d", "related_ids": ["t1"], "facts": {"amount": 500, "merchant": "CVS Pharmacy", "date": "2026-11-04"}, "priority": 85},
        {"id": "alert:scam:nguyen1", "alert_id": "scam:nguyen1", "type": "open_alert", "source": "alert", "severity": "critical", "kind": "scam", "title": "Possible scam call linked to $2,000 in recent payments", "detail": "Gift cards", "related_ids": [], "facts": {}, "priority": 40},
    ],
}


class FakeWorker:
    def __init__(self, payload=None):
        self.payload = payload

    async def alert_candidates(self, household_id):
        return self.payload


def make(payload=PAYLOAD):
    return CallbackManager(S, worker=FakeWorker(payload), rng=random.Random(1))


def test_the_in_app_callback_is_on_by_default_and_needs_no_phone_line():
    assert config.Settings().callback_web is True
    assert S.signalwire_number == "" and not make().enabled  # the phone dialer is not configured, yet the app callback works


async def test_a_ring_about_an_alert_opens_the_call_about_that_alert_even_if_another_signal_ranks_higher():
    plan = await make().web_plan("hh_rivera", "Marisol Rivera", prefer_alert_id="scam:nguyen1")
    assert isinstance(plan, CallbackPlan) and plan.household_id == "hh_rivera" and plan.first_name == "Marisol"
    assert plan.alert.existing_alert_id == "scam:nguyen1" and "scam" in plan.alert.kind


async def test_without_a_preferred_alert_it_picks_like_the_phone_callback_does():
    plan = await make().web_plan("hh_rivera", "Marisol")
    assert plan.alert.key == "txn:t1" and plan.alert.source == "real"


async def test_an_unknown_preferred_alert_falls_back_instead_of_failing():
    plan = await make().web_plan("hh_rivera", "Marisol", prefer_alert_id="alert-that-is-gone")
    assert plan.alert.statement


async def test_worker_down_still_gives_a_template_call_and_a_guest_has_no_first_name():
    plan = await make(payload=None).web_plan("hh_rivera", "Guest 218")
    assert plan.alert.source == "template" and plan.first_name == "" and plan.caller_hash == "web"


async def test_the_plan_never_carries_a_phone_number():
    plan = await make().web_plan("hh_rivera", "Marisol")
    assert "+" not in repr(plan.caller_hash) and plan.caller_hash == "web"
