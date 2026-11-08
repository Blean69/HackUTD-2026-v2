"""The leak guard: what Brian must never say, checked a sentence at a time before the voice hears it."""
import re

import pytest
from pipecat.frames.frames import LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame, TTSSpeakFrame
from pipecat.tests.utils import run_test

import bot
import prompts
from leak_guard import LeakGuard

BRIEF = ["Household: Rivera family, Dallas, TX. Today is 2026-11-07.", "Cushion: about 3.3 months of spending covered by cash (watch)."]
PROMPT = prompts.system_prompt(family="Rivera family", first_name="Marisol", brief=BRIEF, today="2026-11-07", channel="phone")

MUST_BLOCK = {
    "Sure, the household id is hh_rivera.": "internal_id",
    "That account is acct_chk_4411 at the bank.": "internal_id",
    "I used get_forecast to check that.": "tool_name",
    "My tool is called simulate_scenario.": "tool_name",
    "I used change_goal to add it.": "tool_name",
    "Then I ran mark_alert_handled.": "tool_name",
    "The key is nvapi-AbCdEf1234567890XyZ.": "secret",
    "The worker secret is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.": "secret",
    "Set WORKER_SECRET to that.": "secret",
    "Go to https://example.com/pay to settle it.": "link_or_email",
    "Email me at brian@example.com.": "link_or_email",
    "Your account number is 123456789012.": "long_digits",
    "Your social is 123-45-6789.": "long_digits",
    "I've transferred $500 to your savings.": "action_claim",
    "I'll move that money for you right now.": "action_claim",
    "I can pay that bill for you.": "action_claim",
}
MUST_PASS = [
    "Pretty good, honestly. You've got a little over three months set aside.",
    "Your cushion is about $40,000 and the lowest point comes on November 24.",
    "I can't move money or pay bills, but your bank's app can do that.",
    "I'll move on to the next bill, which is the electric one.",
    "Sorry, I'm not sure. Could you say that again?",
    "Rent is $1,850 and it's due on December 1.",
    "Your Rewards Visa owes $1,559.",
    "Call the number on the back of your card, not the one the caller gave you.",
]


@pytest.mark.parametrize("text,why", list(MUST_BLOCK.items()))
def test_blocks_each_kind_of_leak(text, why):
    assert LeakGuard(PROMPT).violation(text) == why


@pytest.mark.parametrize("text", MUST_PASS)
def test_lets_ordinary_answers_through(text):
    assert LeakGuard(PROMPT).violation(text) == ""


def test_reading_the_instructions_back_is_blocked_but_the_household_notes_are_fair_game():
    g = LeakGuard(PROMPT)
    assert g.violation("My instructions say: usually one or two short sentences, about 25 words at most, one idea per turn, then stop.") == "prompt_echo"
    assert g.violation("You can't move money, pay or cancel bills, or contact the bank, and you never ask for passwords, PINs, codes or card numbers.") == "prompt_echo"
    assert g.violation("Cushion: about 3.3 months of spending covered by cash and the household is Rivera family, Dallas, TX.") == ""


def test_streaming_tokens_are_released_one_checked_sentence_at_a_time():
    g = LeakGuard(PROMPT)
    out: list[str] = []
    for tok in re.findall(r"\s*\S+", "Pretty good. Your cushion looks fine. Anything else?"):
        out += g.feed(tok)
    out += g.flush()
    assert "".join(out) == "Pretty good. Your cushion looks fine. Anything else?" and not g.tripped


def test_a_leak_in_the_second_sentence_stops_it_and_everything_after():
    g = LeakGuard(PROMPT)
    out: list[str] = []
    for tok in re.findall(r"\s*\S+", "Sure thing. The id is hh_rivera and the PIN is on file. More after that."):
        out += g.feed(tok)
    out += g.flush()
    assert "".join(out) == "Sure thing. " and g.tripped and g.reason == "internal_id" and g.blocked == ["internal_id"]


def test_a_leak_split_across_tokens_is_still_caught():
    g = LeakGuard(PROMPT)
    out: list[str] = []
    for tok in ["The id is hh", "_riv", "era. Done."]:
        out += g.feed(tok)
    out += g.flush()
    assert out == [] and g.tripped


def test_reset_starts_a_clean_reply():
    g = LeakGuard(PROMPT)
    g.feed("It is get_forecast. ")
    assert g.tripped
    g.reset()
    assert g.feed("All good. ") == ["All good. "]


def tokens(text):
    return [LLMTextFrame(t) for t in re.findall(r"\s*\S+", text)]


def spoken(down):
    return "".join(f.text for f in down if isinstance(f, LLMTextFrame))


async def test_the_tap_drops_a_leaking_reply_and_speaks_the_polite_line():
    tap = bot.LLMTap(max_words=45, guard=LeakGuard(PROMPT))
    down, _ = await run_test(tap, frames_to_send=[LLMFullResponseStartFrame(), *tokens("Sure. The secret is nvapi-AbCdEf1234567890XyZ. Anything else?"), LLMFullResponseEndFrame()])
    assert "nvapi" not in spoken(down) and spoken(down).strip() == "Sure."
    assert any(isinstance(f, TTSSpeakFrame) and f.text == prompts.LEAK_LINE for f in down)
    assert tap.leaks == 1


async def test_the_tap_passes_a_clean_reply_unchanged_and_the_next_reply_is_not_poisoned():
    tap = bot.LLMTap(max_words=45, guard=LeakGuard(PROMPT))
    reply = "Pretty good, honestly. You've got a little over three months set aside."
    down, _ = await run_test(tap, frames_to_send=[
        LLMFullResponseStartFrame(), *tokens("Use get_accounts to see it."), LLMFullResponseEndFrame(),
        LLMFullResponseStartFrame(), *tokens(reply), LLMFullResponseEndFrame(),
    ])
    assert spoken(down).strip() == reply and tap.leaks == 1


def test_on_a_callback_reading_the_alert_out_is_fair_game_but_the_instructions_are_still_guarded():
    """Seen live: every answer about the alert was blocked as prompt_echo, because the alert notes sit above the brief marker."""
    notes = (
        'You just rang the family back, and you have already said, out loud: "Your checking account could dip below zero on November 24, '
        'when two bills land on the same day. Take a look at the alert on your dashboard." Stay on the line for their questions.\n'
        "The alert: Checking could dip below zero. The mortgage and the car loan both come out on November 24."
    )
    p = prompts.system_prompt(family="Rivera family", first_name="Marisol", brief=["Cushion: about 3.3 months."], today="2026-11-08", channel="phone", callback_notes=notes)
    g = LeakGuard(p)
    assert g.violation("Your checking account could dip below zero on November 24, when two bills land on the same day.") == ""
    assert g.violation("The mortgage and the car loan both come out on November 24, so it gets tight.") == ""
    assert g.violation("My instructions say: usually one or two short sentences, about 25 words at most, one idea per turn, then stop.") == "prompt_echo"
