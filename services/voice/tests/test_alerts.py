"""Alert selection for the callback: the household's real signals first, then a template filled from its accounts."""
import random
import re
from datetime import date

import pytest

import alerts
import prompts
from alerts import CallbackAlert, Ctx, select_alert, spoken_script, system_notes, template_alert
from speech import SpeechNormalizer

CTX = {
    "household_id": "hh_rivera", "family": "Rivera family", "as_of": "2026-11-07", "city": "Dallas", "state": "TX", "checking_balance": 4409,
    "accounts": [
        {"id": "acct_rivera_chk", "type": "checking", "nickname": "Joint Checking", "institution": "Keystone Bank", "last4": "5821", "balance": 4409},
        {"id": "acct_rivera_sav", "type": "savings", "nickname": "Emergency Fund", "institution": "Keystone Bank", "last4": "1177", "balance": 14200},
        {"id": "acct_rivera_card1", "type": "credit_card", "nickname": "Rewards Visa", "institution": "Cedar Springs", "last4": "4417", "balance": 1558, "credit_limit": 15000},
        {"id": "acct_rivera_card2", "type": "credit_card", "nickname": "Gas Rewards Mastercard", "institution": "Gulf & Plains", "last4": "9034", "balance": 2049},
    ],
    "obligations": [{"name": "Mortgage", "amount": 1840, "due_day": 1, "kind": "mortgage"}, {"name": "F-150 loan", "amount": 455, "due_day": 1, "kind": "loan"}, {"name": "Electric", "amount": 140, "due_day": 9, "kind": "utility"}],
}


def cand(**kw):
    base = {"id": "txn:t1", "type": "scam_payment", "source": "rule", "severity": "critical", "kind": "scam", "title": "Possible scam payment to CVS", "detail": "Gift card payments are the classic scam.", "related_ids": ["t1"], "facts": {}, "priority": 85}
    return {**base, **kw}


def payload(*cands, ctx=CTX):
    return {"household_id": "hh_rivera", "context": ctx, "candidates": list(cands)}


# ---- real signals come first ------------------------------------------------------------------------------------------------------
def test_the_highest_priority_real_signal_wins_over_any_template():
    p = payload(
        cand(id="txn:dup", type="duplicate", severity="warn", kind="data_quality", priority=50, facts={"amount": 43, "merchant": "Pizza Place", "date": "2026-11-05"}),
        cand(id="txn:t1", type="scam_payment", priority=85, facts={"amount": 500, "merchant": "CVS Pharmacy", "date": "2026-11-04", "account": "Joint Checking", "last4": "5821"}),
        cand(id="forecast:2026-11-13", type="overdraft", source="forecast", kind="obligation", priority=75, facts={"date": "2026-11-13", "shortfall": 340, "bills_due": 1840}),
    )
    a = select_alert(p, rng=random.Random(1))
    assert a.source == "real" and a.key == "txn:t1" and a.kind == "scam" and a.severity == "critical" and a.origin == "rule: scam_payment"
    assert "$500" in a.statement and "CVS Pharmacy" in a.statement and "November 4" in a.statement
    assert a.related_ids == ("t1",) and a.existing_alert_id == ""  # a derived signal is written as a NEW critical alert


def test_every_real_signal_type_is_spoken_in_one_or_two_short_sentences_with_plain_numbers():
    cases = {
        "card_testing": cand(id="txn:c", type="card_testing", kind="fraud", facts={"count": 6, "date": "2026-11-03", "account": "Visa", "last4": "4417"}),
        "scam_payment": cand(facts={"amount": 500, "merchant": "CVS Pharmacy", "date": "2026-11-04"}),
        "new_payee_transfer": cand(id="txn:p", type="new_payee_transfer", kind="fraud", facts={"amount": 2400, "merchant": "Online Transfer", "date": "2026-11-02", "overnight": True}),
        "duplicate": cand(id="txn:d", type="duplicate", severity="warn", kind="data_quality", facts={"amount": 43, "merchant": "Pizza Place", "date": "2026-11-05"}),
        "overdraft": cand(id="forecast:x", type="overdraft", kind="obligation", facts={"date": "2026-11-13", "shortfall": 340, "bills_due": 1800}),
        "credit_drop": cand(id="alert:c", type="credit_drop", severity="warn", kind="fraud", alert_id="rule:hh:c", title="Credit score dropped 28 points", detail="A new hard inquiry. The score is simulated."),
        "open_alert": cand(id="alert:o", type="open_alert", kind="fraud", alert_id="rule:hh:o", title="Possible card testing on Visa", detail="6 charges under $2 on one day."),
    }
    for name, c in cases.items():
        a = select_alert(payload(c), rng=random.Random(2))
        assert a.source == "real", name
        sentences = [x for x in re.split(r"(?<=[.!?])\s+", a.statement) if x]
        assert 1 <= len(sentences) <= 3 and len(a.statement.split()) <= 45 and a.action, name
        assert "{" not in a.statement and not re.search(r"\d+\.\d", a.statement), name  # no decimals read aloud
    assert "tiny charges" in select_alert(payload(cases["card_testing"])).statement
    assert "new payee" in select_alert(payload(cases["new_payee_transfer"])).statement
    assert "middle of the night" in select_alert(payload(cases["new_payee_transfer"])).statement
    assert "below zero on November 13" in select_alert(payload(cases["overdraft"])).statement


def test_an_open_critical_alert_is_reused_but_an_open_warn_one_gets_a_critical_row():
    crit = select_alert(payload(cand(id="alert:rule:hh:ct", type="open_alert", alert_id="rule:hh:ct", title="Card testing on Visa", detail="x", kind="fraud")))
    assert crit.existing_alert_id == "rule:hh:ct" and crit.severity == "critical"
    warn = select_alert(payload(cand(id="alert:rule:hh:w", type="open_alert", severity="warn", alert_id="rule:hh:w", title="Odd merchant", detail="x", kind="fraud")))
    assert warn.existing_alert_id == "" and warn.severity == "critical"  # the callback's own alert is critical either way


def test_a_real_signal_used_a_moment_ago_is_skipped_for_the_next_one_then_for_templates():
    p = payload(cand(id="txn:a", priority=90, facts={"amount": 500, "merchant": "A"}), cand(id="txn:b", priority=80, facts={"amount": 400, "merchant": "B"}))
    first = select_alert(p, rng=random.Random(3))
    second = select_alert(p, rng=random.Random(3), exclude={first.key})
    third = select_alert(p, rng=random.Random(3), exclude={first.key, second.key})
    assert (first.key, second.key, third.source) == ("txn:a", "txn:b", "template")


@pytest.mark.parametrize("bad", [None, {}, {"candidates": None}, {"candidates": "nope"}, {"candidates": [{"id": "x"}]}, {"candidates": [{"id": "x", "type": "mystery", "facts": {}}]}, {"candidates": [{"id": "y", "type": "scam_payment", "facts": {"amount": "lots"}}]}, {"context": "garbage", "candidates": []}])
def test_missing_or_broken_data_falls_back_to_a_template(bad):
    a = select_alert(bad, rng=random.Random(4), today=date(2026, 11, 7))
    assert a.source == "template" and a.key.startswith("tpl:") and a.statement and a.action and a.title and a.kind in alerts.KINDS


# ---- templates ---------------------------------------------------------------------------------------------------------------------
def test_there_are_seven_templates_with_the_right_alert_kinds():
    assert sorted(alerts.TEMPLATES) == sorted(["card_other_city", "new_payee_3am", "overdraft_two_bills", "credit_drop_inquiry", "gift_card_pattern", "double_charge", "card_testing"])
    kinds = {n: template_alert(Ctx.from_payload(payload(), random.Random(0)), random.Random(5), name=n).kind for n in alerts.TEMPLATES}
    assert kinds == {"card_other_city": "fraud", "new_payee_3am": "fraud", "overdraft_two_bills": "obligation", "credit_drop_inquiry": "credit", "gift_card_pattern": "scam", "double_charge": "data_quality", "card_testing": "fraud"}


def test_templates_are_filled_from_the_households_accounts_bills_and_dates():
    ctx = Ctx.from_payload(payload(), random.Random(0))
    assert ctx.today == date(2026, 11, 7) and ctx.checking_name == "Joint Checking" and ctx.has_savings and ctx.bills[0] == ("Mortgage", 1840)
    for seed in range(40):
        rng = random.Random(seed)
        card = template_alert(ctx, rng, name="card_other_city")
        assert re.search(r"ending (four four one seven|nine zero three four)", card.statement) and "Dallas" not in card.statement.split("ending")[0]
        assert re.search(r"\$\d{3} charge", card.statement) and 180 <= int(re.search(r"\$(\d{3}) charge", card.statement).group(1)) <= 890
        payee = template_alert(ctx, rng, name="new_payee_3am")
        assert "Joint Checking" in payee.statement and "three this morning" in payee.statement
        amt = int(re.search(r"\$([\d,]+) went out", payee.statement).group(1).replace(",", ""))
        assert 1500 <= amt <= 2700  # at most 60% of the 4,409 in checking
        od = template_alert(ctx, rng, name="overdraft_two_bills")
        m = re.search(r"below zero on (\w+) (\d+)", od.statement)
        assert (m.group(1), 11 <= int(m.group(2)) <= 16) == ("November", True) and "two bills, Mortgage and F-150 loan, land the same day" in od.statement
        assert "from savings" in od.action
        assert re.search(r"\$\d+ (together|charge)|tiny charges", template_alert(ctx, rng, name="gift_card_pattern").statement + template_alert(ctx, rng, name="card_testing").statement)


def test_templates_work_without_any_household_context_and_never_repeat_the_one_just_used():
    bare = Ctx.from_payload(None, random.Random(7), today=date(2026, 3, 1))
    for name in alerts.TEMPLATES:
        a = template_alert(bare, random.Random(7), name=name)
        assert a.statement and "None" not in a.statement + a.detail and "{" not in a.statement
    seen = set()
    used: set[str] = set()
    for i in range(7):
        a = template_alert(bare, random.Random(i), exclude=used)
        assert a.key not in used
        used.add(a.key)
        seen.add(a.key)
    assert len(seen) == 7
    assert template_alert(bare, random.Random(1), exclude={f"tpl:{n}" for n in alerts.TEMPLATES}).source == "template"  # all used: start over


def test_a_card_in_another_city_is_never_in_the_home_city():
    for city in ("Dallas", "Miami", "Chicago"):
        ctx = Ctx.from_payload(payload(ctx={**CTX, "city": city}), random.Random(0))
        for seed in range(30):
            assert city not in template_alert(ctx, random.Random(seed), name="card_other_city").title


# ---- what Brian says ---------------------------------------------------------------------------------------------------------------
def test_card_digits_names_and_gift_cards_are_said_the_way_a_person_says_them():
    assert alerts.say_digits("7994") == "seven nine nine four" and alerts.say_digits("0420") == "zero four two zero" and alerts.say_digits("x") == ""
    assert alerts.speakable("Zelle, T Bryant, new payee") == "Zelle T Bryant" and alerts.speakable("QuikTrip #1042") == "QuikTrip" and alerts.speakable("") == ""
    assert alerts.speakable("A" * 30 + " " + "B" * 30) == "A" * 30
    gift = select_alert(payload(cand(facts={"amount": 500, "merchant": "Kroger", "category": "gift_cards", "date": "2026-10-21"})))
    assert "five hundred" not in gift.statement and "$500 gift card purchase at Kroger on October 21" in gift.statement
    ct = select_alert(payload(cand(id="txn:c", type="card_testing", kind="fraud", facts={"count": 6, "date": "2026-11-03", "account": "Visa", "last4": "4417"})))
    assert "ending four four one seven" in ct.statement and "4417" not in ct.statement
    payee = select_alert(payload(cand(id="txn:p", type="new_payee_transfer", kind="fraud", facts={"amount": 4650, "merchant": "Zelle, T Bryant, new payee", "date": "2026-09-17", "overnight": True})))
    assert "went out to Zelle T Bryant on September 17 in the middle of the night, and it looks like a new payee." in payee.statement


def test_the_script_has_the_alert_the_recommendation_a_dashboard_line_only_if_posted_and_a_question():
    a = select_alert(payload(), rng=random.Random(1))
    ok, no = spoken_script(a, posted=True), spoken_script(a, posted=False)
    assert ok.startswith(a.statement) and a.action in ok and prompts.CALLBACK_DASHBOARD in ok and ok.endswith(prompts.CALLBACK_ASK)
    assert prompts.CALLBACK_DASHBOARD not in no and no.endswith(prompts.CALLBACK_ASK)  # never claims a dashboard entry that was not written
    assert prompts.CALLBACK_OPENING == "Hi, it's Brian again, sorry to call right back. I've got a critical alert on your account."


def test_the_spoken_text_survives_the_speech_normalizer_in_plain_words():
    norm = SpeechNormalizer("2026-11-07")
    a = template_alert(Ctx.from_payload(payload(), random.Random(0)), random.Random(11), name="overdraft_two_bills")
    said = norm.normalize(spoken_script(a, posted=True))
    assert "$" not in said and not re.search(r"\d", said) and "November" in said


def test_model_notes_carry_what_was_said_and_the_facts_and_forbid_inventing():
    a = select_alert(payload(cand(facts={"amount": 500, "merchant": "CVS Pharmacy", "date": "2026-11-04"})), rng=random.Random(1))
    notes = system_notes(a)
    assert a.statement in notes and "CVS Pharmacy" in notes and "only details you have" in notes and "cannot freeze a card" in notes
    assert "dashboard now" in system_notes(a, posted=True) and "dashboard now" not in system_notes(a, posted=False)
    p = prompts.system_prompt(family="Rivera family", first_name="Marisol", brief=["Cushion: about 3.3 months."], today="2026-11-07", channel="phone", callback_notes=notes)
    assert "THIS IS A CALLBACK" in p and "CVS Pharmacy" in p and p.index("THIS IS A CALLBACK") < p.index("WHAT YOU KNOW RIGHT NOW")
    assert "THIS IS A CALLBACK" not in prompts.system_prompt(family="Rivera family", first_name="", brief=[], today="2026-11-07")


def test_the_api_payload_is_what_the_worker_route_takes():
    a = select_alert(payload(cand(facts={"amount": 500, "merchant": "CVS"})), rng=random.Random(1))
    body = a.api_payload()
    assert set(body) == {"kind", "title", "detail", "related_ids", "existing_alert_id", "origin"} and body["kind"] == "scam" and body["related_ids"] == ["t1"]
    assert isinstance(a, CallbackAlert)
