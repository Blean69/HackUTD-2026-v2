"""Prompt invariants, the one-time disclosure, fillers and the spoken-turn cap."""
import random
import re

import pytest

import prompts
from pacing import SentenceCap

BRIEF = [
    "Household: Rivera family, Dallas, TX. Today is 2026-11-07.",
    "Cushion: about 3.3 months of spending covered by cash (watch).",
    "Keep an eye on: Liquidity runway. $40,109 in checking and savings covers 3.3 months of about $12,186 a month in spending.",
    "Keep an eye on: Savings rate (3 mo). $13,363 a month in (deposits) vs $12,186 out leaves $1,177 a month, 8.8% of income.",
    "Doing well: Debt-to-income, Credit utilization.",
    "Next 90 days: cash starts near $40,182, ends near $42,837; the lowest point is about $39,655 on 2026-11-24.",
]


def prompt(**kw):
    args = dict(family="Rivera family", first_name="Marisol", brief=BRIEF, today="2026-11-07", channel="web")
    args.update(kw)
    return prompts.system_prompt(**args)


def test_prompt_asks_for_short_spoken_turns():
    p = prompt()
    assert "one or two short sentences" in p and "about 25 words" in p and "One idea per turn" in p and "name only the one or two that matter" in p
    assert "read aloud" in p and "SAY out loud" in p


def test_prompt_bans_what_sounds_robotic():
    p = prompt()
    for must in ("never \"liquidity runway\"", "no lists, markdown, bullets, emoji, brackets or dashes", "Never say tool names or ids", "cushion", "bills coming up"):
        assert must.lower() in p.lower().replace("Plain sentences only: ", "") or must.lower() in p.lower(), must
    assert "Never invent a number" in p and "I'm not sure" in p
    assert "ONE short question" in p
    assert "cuts in" in p
    assert "stressful" in p and "gentle" in p
    assert "goodbye" in p


def test_prompt_teaches_spoken_numbers():
    p = prompt()
    for example in ("a little over five months", "about thirty thousand dollars", "close to seven percent", "December first"):
        assert example in p


def test_prompt_has_good_and_bad_examples_and_they_are_short():
    p = prompt()
    goods = re.findall(r"^Good: (.+)$", p, re.M)
    bads = re.findall(r"^Bad: (.+)$", p, re.M)
    assert len(goods) >= 5 and len(bads) >= 3
    assert all(len(g.split()) <= 30 for g in goods), [g for g in goods if len(g.split()) > 30]
    assert not any(c in "".join(goods) for c in "$%*#_—")  # the good examples are themselves spoken-style


def test_examples_cannot_be_parroted_as_facts():
    """The old prompt's examples (4 months, 11%, $3,000 in bills) were repeated back to callers as if they were real, and a first draft of
    this one had the model recite its example bills. Good examples are fill-in-the-blank, hold no figures, and the prompt says so."""
    p = prompt()
    examples = p.split("EXAMPLES")[1].split("WHAT YOU KNOW RIGHT NOW")[0]
    assert "never copy an example's words or figures" in examples and "<angle brackets>" in examples
    goods = re.findall(r"^Good: (.+)$", examples, re.M)
    assert goods and all(not re.search(r"\d", g) for g in goods)
    for real in ("three months", "nine percent", "forty thousand", "thirty-five thousand", "twelve thousand", "rent", "twelfth", "twenty-fourth", "electric", "car payment"):
        assert real not in "\n".join(goods).lower(), real


def test_prompt_keeps_identity_tools_and_honesty():
    p = prompt()
    assert "Marisol from the Rivera family" in p and "in the browser" in p
    assert "AI, not a person and not a licensed advisor" in p
    for tool in ("get_forecast", "get_obligations", "get_health_indicators", "get_accounts", "simulate_scenario", "goal_feasibility", "detect_scam_signals"):
        assert tool in p
    assert "financed true ONLY" in p and "write NO text in that turn" in p
    assert "by phone" in prompt(channel="phone")
    assert "someone from the Rivera family" in prompt(first_name="")


def test_brief_is_humanized_before_the_model_reads_it():
    p = prompt()
    know = p.split("WHAT YOU KNOW RIGHT NOW")[1]
    assert "a little over three months" in know and "about forty thousand dollars" in know
    assert "November twenty-fourth" in know
    assert not re.search(r"\d", know.split("\n", 1)[1]), know  # no digits left to read aloud
    assert "Liquidity runway" not in know and "Debt-to-income" not in know and "utilization" not in know.lower()
    assert "Cushion" in know


def test_prompt_size_stays_modest():
    assert len(prompt().split()) < 1100  # a 3B-active model follows a short prompt better (raised from 1000 for the humor examples)


def test_disclosure_is_brief_natural_and_complete():
    for line in (prompts.DISCLOSURE_WEB, prompts.DISCLOSURE_PHONE):
        low = line.lower()
        assert line.startswith("Hi, I'm Brian, your personal finance assistant.") and "i'm an ai" in low and "keystone" not in low  # named, and never implied human
        assert len(line.split()) <= 40 and "—" not in line
    assert "PIN" in prompts.DISCLOSURE_PHONE and "PIN" not in prompts.DISCLOSURE_WEB
    assert prompts.DISCLOSURE_WEB.endswith("?")


def test_fixed_lines_are_plain_speech():
    lines = [v for k, v in vars(prompts).items() if k.isupper() and isinstance(v, str) and k != "FILLERS"]
    assert len(lines) >= 12
    for line in lines:
        assert not re.search(r"[*_#—\U0001F300-\U0001FAFF]", line), line
        assert line.rstrip().endswith((".", "?", "!")), line


# ---- fillers -----------------------------------------------------------------------------------------------------------------------------
def test_fillers_are_two_to_five_words_and_varied():
    assert len(prompts.FILLERS) >= 6 and len(set(prompts.FILLERS)) == len(prompts.FILLERS)
    for f in prompts.FILLERS:
        assert 2 <= len(f.split()) <= 5, f
        assert "sec" not in f.lower().replace("second", "")  # the ASR hears Magpie's "sec" as "sexy"
        assert not re.search(r"[*_#—\d]", f)
    assert len({prompts.filler() for _ in range(80)}) > 1


@pytest.mark.parametrize("seed", range(8))
def test_filler_picker_never_repeats_back_to_back(seed):
    pick = prompts.FillerPicker(random.Random(seed))
    seq = [pick.next() for _ in range(200)]
    assert all(a != b for a, b in zip(seq, seq[1:]))
    assert set(seq) == set(prompts.FILLERS)


def test_filler_picker_with_a_single_filler_still_answers():
    assert prompts.FillerPicker(pool=["One moment."]).next() == "One moment."


# ---- the spoken-turn cap -------------------------------------------------------------------------------------------------------------
def feed(cap: SentenceCap, text: str) -> str:
    """Stream `text` as token-like chunks; return what was let through."""
    out = []
    for tok in re.findall(r"\s*\S+", text):
        if cap.allow(tok):
            out.append(tok)
    return "".join(out)


def test_short_replies_pass_untouched():
    cap = SentenceCap(max_words=45)
    t = "Pretty good, honestly. You've got a little over three months set aside."
    assert feed(cap, t) == t and not cap.closed


def test_rambling_stops_at_the_first_sentence_end_after_the_cap():
    cap = SentenceCap(max_words=12, max_sentences=9)
    t = "Right now your cash cushion is solid, which is great news for the whole family this month. You also have savings. The forecast never dips below zero. Anything else?"
    out = feed(cap, t)
    assert out.endswith("this month.") and "savings" not in out and cap.closed
    assert feed(cap, " More text.") == ""  # nothing after the cap, until the next reply


def test_never_more_than_three_sentences():
    cap = SentenceCap(max_words=999)
    out = feed(cap, "One. Two. Three. Four. Five.")
    assert out == "One. Two. Three."


def test_a_decimal_point_is_not_a_sentence_end():
    cap = SentenceCap(max_words=3, max_sentences=9)
    out = feed(cap, "It is 3. 5 months of cover for you and the family. Done.")
    assert "Done" not in out and "family." in out


def test_reset_starts_a_new_reply():
    cap = SentenceCap(max_words=3, max_sentences=1)
    feed(cap, "Stop now. Please.")
    assert cap.closed
    cap.reset()
    assert not cap.closed and cap.words == 0 and cap.allow("Hello there.")
