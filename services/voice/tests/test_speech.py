"""The spoken-text normalizer: whatever the model writes must come out as words a person would say."""
import re

import pytest

import speech
from speech import SpeechNormalizer, normalize_for_speech, say_approx, say_int, say_money, say_year, speech_transform

N = SpeechNormalizer("2026-11-07")  # the demo's "today"


def say(text: str) -> str:
    return N.normalize(text)


# ---- money --------------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "text,expected",
    [
        ("A $35k car", "A thirty-five thousand dollar car."),  # modifier: singular "dollar"
        ("We'd pay $35,000 for it", "We'd pay thirty-five thousand dollars for it."),
        ("About $1,200 a month", "About twelve hundred dollars a month."),
        ("$39,655.40 at the low", "about forty thousand dollars at the low."),
        ("The lowest point is $39,655", "The lowest point is about forty thousand dollars."),
        ("Cash of $40,109", "Cash of about forty thousand dollars."),
        ("Spending is $12,186 a month", "Spending is about twelve thousand dollars a month."),
        ("Rent is $1,850", "Rent is one thousand eight hundred fifty dollars."),  # round $50s stay exact
        ("The payment is $612/mo", "The payment is six hundred twelve dollars a month."),
        ("Water is $88", "Water is eighty-eight dollars."),
        ("It was $12.40", "It was about twelve dollars."),
        ("Just $0.99", "Just ninety-nine cents."),
        ("$1 only", "one dollar only."),
        ("$7,744 in bills", "about seventy-seven hundred dollars in bills."),
        ("$2.5k", "twenty-five hundred dollars."),
        ("$1.5M house", "one and a half million dollars house."),
        ("$1.2 million", "one point two million dollars."),
        ("$250,000", "two hundred fifty thousand dollars."),
        ("$1,000,000", "one million dollars."),
        ("-$500 today", "minus five hundred dollars today."),
        ("35000 dollars", "thirty-five thousand dollars."),
        ("2,400 USD", "twenty-four hundred dollars."),
        ("about $39,655", "about forty thousand dollars."),  # no "about about"
        ("roughly $39,655", "roughly forty thousand dollars."),
    ],
)
def test_money_is_said_like_a_person(text, expected):
    assert say(text) == expected


def test_no_doubled_hedges():
    out = say("about $39,655 and nearly $7,744")
    assert "about about" not in out and "nearly about" not in out


def test_money_ranges():
    assert say("Between $1,000-$1,500 a month") == "Between one thousand to fifteen hundred dollars a month."
    assert say("$1,000 to $1,500") == "one thousand to fifteen hundred dollars."
    assert say("$50k-$60k") == "fifty thousand to sixty thousand dollars."


# ---- percentages, months, decimals ----------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "text,expected",
    [
        ("saving 8.8% of income", "saving close to nine percent of income."),
        ("saving 9%", "saving nine percent."),
        ("97.7% of the goal", "about ninety-eight percent of the goal."),
        ("12.5% growth", "twelve and a half percent growth."),
        ("3.2% interest", "a little over three percent interest."),
        ("0.4% fee", "less than one percent fee."),
        ("100% sure", "one hundred percent sure."),
        ("0% risk", "zero percent risk."),
        ("about 8.8%", "about nine percent."),
        ("almost 97.7%", "almost ninety-eight percent."),
        ("8.8 percent", "close to nine percent."),
        ("-4.5%", "minus four and a half percent."),
        ("10-15% of income", "ten to fifteen percent of income."),
        ("6.2% APR", "a little over six percent A P R."),
    ],
)
def test_percentages(text, expected):
    assert say(text) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("3.3 months of spending", "a little over three months of spending."),
        ("3.7 months", "close to four months."),
        ("3.5 months", "three and a half months."),
        ("3.0 months", "three months."),
        ("about 3.3 months", "about three months."),
        ("over 3.3 months", "over three months."),
        ("under 3.2 months", "under three and a half months."),
        ("nearly 12.4 years", "nearly twelve and a half years."),
        ("2.5 years", "two and a half years."),
        ("34.6 days", "about thirty-five days."),
        ("3-4 months", "three to four months."),
        ("a 5-year loan", "a five-year loan."),
    ],
)
def test_decimals_with_units(text, expected):
    assert say(text) == expected


def test_plain_decimals_and_numbers():
    assert say("version 2.5") == "version two point five."
    assert say("-1.25 points") == "minus one point two five points."
    assert say("I have 12 cards") == "I have twelve cards."
    assert say("1,200 transactions") == "twelve hundred transactions."
    assert say("007") == "zero zero seven."
    assert say("3/4 of it") == "three quarters of it."
    assert say("about 1/2.") == "about one half."


# ---- dates, times, years --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "text,expected",
    [
        ("Due 2026-11-24", "Due November twenty-fourth."),
        ("Due 2026-12-01.", "Due December first."),
        ("Due 2027-03-15", "Due March fifteenth, twenty twenty-seven."),
        ("In 2026-12 we start", "In December we start."),
        ("In 2028-06 we finish", "In June twenty twenty-eight we finish."),
        ("Due Nov 24", "Due November twenty-fourth."),
        ("Due December 1st, 2027", "Due December first, twenty twenty-seven."),
        ("Due on 11/24", "Due on November twenty-fourth."),
        ("Signed 3/5/2027", "Signed March fifth, twenty twenty-seven."),
        ("on the 24th", "on the twenty-fourth."),
        ("the 1st and the 22nd", "the first and the twenty-second."),
        ("24 March", "March twenty-fourth."),
        ("by June 2028", "by June twenty twenty-eight."),
        ("in 2008", "in two thousand eight."),
        ("in 1999", "in nineteen ninety-nine."),
        ("2026-2028", "twenty twenty-six to twenty twenty-eight."),
    ],
)
def test_dates_and_years(text, expected):
    assert say(text) == expected


def test_the_year_is_dropped_only_for_the_current_year():
    assert SpeechNormalizer("2027-01-02").normalize("Due 2027-03-15") == "Due March fifteenth."
    assert SpeechNormalizer("2026-11-07").normalize("Due 2027-03-15") == "Due March fifteenth, twenty twenty-seven."
    assert SpeechNormalizer("not a date").today is not None  # falls back to the real date, never raises


@pytest.mark.parametrize(
    "text,expected",
    [
        ("at 3:30pm", "at three thirty p m."),
        ("at 3:30 PM", "at three thirty p m."),
        ("at 9am", "at nine a m."),
        ("at 7:05 a.m.", "at seven oh five a m."),
        ("at 14:05", "at two oh five p m."),
        ("at 00:00", "at midnight."),
        ("at 12:00", "at noon."),
        ("at 9:45", "at nine forty-five."),
    ],
)
def test_times(text, expected):
    assert say(text) == expected


# ---- abbreviations -------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "text,expected",
    [
        ("Your DTI is fine", "Your debt to income is fine."),
        ("Check the APR", "Check the A P R."),
        ("a 401(k) and an IRA", "a four oh one k and an I R A."),
        ("e.g. a car", "for example, a car."),
        ("5% vs. 7%", "five percent versus seven percent."),
        ("cash & savings", "cash and savings."),
        ("w/ a loan", "with a loan."),
        ("approx. 3 months", "about three months."),
        ("OK then", "okay then."),
        ("the F-150 loan", "the F one fifty loan."),
        ("Mr. Rivera", "Mister Rivera."),
        ("#1 priority", "number one priority."),
    ],
)
def test_abbreviations(text, expected):
    assert say(text) == expected


# ---- markup, emoji, dashes, ids ------------------------------------------------------------------------------------------------------------
def test_markdown_is_stripped():
    assert say("**Good news**: your _month_ is `fine`.") == "Good news: your month is fine."
    assert say("[the report](https://x.com/r) is ready") == "the report is ready."
    assert say("# Heading\n- one\n- two\n1. three\n> four") == "Heading. one. two. three. four."
    assert say("See https://example.com/a?b=1 now") == "See now."
    assert say("Mail me@example.com please") == "Mail please."
    assert say("```code block``` text") == "text."
    for ch in "*_#`>~|[]":
        assert ch not in say(f"a {ch} b {ch}c{ch} d"), ch


def test_emoji_are_dropped():
    assert say("Great news 🎉 you're set 😀👍") == "Great news you're set."
    assert say("☎ call us ✅") == "call us."
    assert say("😀") == ""


def test_em_dashes_become_commas():
    out = say("That's solid — but watch it – really")
    assert "—" not in out and "–" not in out and out == "That's solid, but watch it, really."
    assert say("a--b") == "a, b."
    assert say("this - that") == "this, that."
    assert say("Wait... let me think") == "Wait, let me think."
    assert say("word—word") == "word, word."


def test_ids_never_reach_the_voice():
    for text in (
        "Household hh_rivera is fine",
        "Run run_48_tukl finished",
        "The tool get_forecast failed",
        "acct-12ab and txn-99 done",
        "id 3f2504e0-4f68-4b1b-9c1e-0242ac130003 ok",
        "key deadbeef12345678 ok",
        "hh_rivera_main",
    ):
        out = say(text)
        assert "_" not in out and not re.search(r"hh|run_|acct|txn|3f25|deadbeef", out, re.I), (text, out)
    assert say("hh_rivera") == ""


def test_italics_with_underscores_keep_their_words():
    assert say("this is _really_ good and __very__ nice") == "this is really good and very nice."


def test_stage_directions_and_audio_tags_are_never_spoken():
    assert say("Okay [laughs] sure thing") == "Okay sure thing."
    assert say("[warmly] Hi there") == "Hi there."
    assert say("Fine *sighs* then") == "Fine then."


def test_line_breaks_are_sentence_breaks():
    assert say("Line one\nLine two.\n\nLine three") == "Line one. Line two. Line three."


# ---- general properties --------------------------------------------------------------------------------------------------------------------
CORPUS = [
    "Your cash cushion covers about 3.3 months of spending and you're saving roughly 8.8% of income. That's solid — but keep an eye on the liquidity runway.",
    "Cash starts near $40,182, ends near $42,837; lowest is about $39,655 on 2026-11-24.",
    "A $35,000 car financed with $3,500 down at 7.5% APR over 60 months is $612/mo.",
    "**Rent** $1,850 on the 1st, water $88 on the 9th, Disney+ $14 on 11/9.",
    "You need $60,000 by 2028-06-01: that's $1,432.18 a month for 41.9 months.",
    "At 3:30pm on Dec 1st, 2027 (that's 12/1/27).",
    "Savings rate (3 mo): 8.8%, DTI 32%, utilization 17.4%.",
]


@pytest.mark.parametrize("text", CORPUS)
def test_no_digit_or_symbol_survives(text):
    out = say(text)
    assert not any(c.isdigit() for c in out), out
    assert not re.search(r"[$%#*_—–]", out), out
    assert out.endswith((".", "!", "?")) and "  " not in out


def test_the_production_reply_comes_out_human():
    out = say("Let me check. Your cash cushion covers about 3.3 months of spending and you're saving roughly 8.8% of income. That's solid — but keep an eye on the liquidity runway.")
    assert "about three months" in out and "roughly nine percent" in out and "—" not in out
    assert not any(c.isdigit() for c in out)


def test_empty_and_symbol_only_inputs():
    assert say("") == "" and say("   ") == "" and say("...") == "" and say("**") == "" and say("\n") == ""
    assert N.normalize(None) == ""  # type: ignore[arg-type]


def test_already_spoken_text_is_left_alone():
    t = "Pretty good, honestly. You've got a little over three months set aside."
    assert say(t) == t
    assert say(say("It was about $39,655 on 2026-11-24")) == say("It was about $39,655 on 2026-11-24")


def test_never_raises_on_garbage():
    for t in ("$", "%", "-", "$$$$", "9999999999999999999999 dollars", "1/0", "0/0", "2026-02-31", "13/45/2026", "$.5", "1.2.3.4", "\u0000\u0001", "a" * 5000):
        say(t)


# ---- helpers ---------------------------------------------------------------------------------------------------------------------------------
def test_number_helpers():
    assert say_int(1200) == "twelve hundred" and say_int(35000) == "thirty-five thousand" and say_int(1850) == "one thousand eight hundred fifty"
    assert say_int(0) == "zero" and say_int(-5) == "minus five" and say_int(100) == "one hundred" and say_int(2000) == "two thousand"
    assert say_year(2026) == "twenty twenty-six" and say_year(2008) == "two thousand eight" and say_year(2000) == "two thousand"
    assert say_approx(3.3) == "a little over three" and say_approx(8.8) == "close to nine" and say_approx(3.5) == "three and a half"
    assert say_approx(3.3, hedged="floor") == "three" and say_approx(3.3, hedged="ceil") == "three and a half"
    assert say_money(39655.4) == "about forty thousand dollars" and say_money(39655.4, hedged="round") == "forty thousand dollars"


async def test_pipecat_text_transform_entry_points():
    assert await N.transform("Saving 8.8%", "sentence") == "Saving close to nine percent."
    assert await speech_transform("About $35k") == "About thirty-five thousand dollars."
    assert normalize_for_speech("Due 2026-12-24", today="2026-11-07") == "Due December twenty-fourth."
    assert speech.SpeechNormalizer().today is not None
