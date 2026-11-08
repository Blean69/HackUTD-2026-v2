"""Spoken-text normalizer: whatever the model wrote -> what a person would say out loud, just before the text reaches the TTS.

The prompt asks the model to write numbers as words already ("a little over three months"), but a 3B-active model still slips: "$39,655.40",
"8.8%", "2026-11-24", "**bold**", an em dash, an emoji, a stray id like `hh_rivera`. Reading those aloud is what makes a voice agent sound
like a machine, so this module is the safety net. It is deterministic, has no model or network calls, and runs per sentence.

What it does, in order:
  1. strips markup and noise: markdown, links, emoji, ids (anything with an underscore, uuids, hex blobs, `hh-12`), URLs
  2. dashes and ellipses become commas (no em dashes reach the voice), line breaks become sentence breaks
  3. dates ("2026-11-24", "11/24", "Nov 24", "24th"), times ("3:30pm", "14:05"), ranges ("3-4 months", "$1,000-$1,500")
  4. money with human rounding ("$39,655.40" -> "about forty thousand dollars", "$1,850" stays exact), percentages ("8.8%" -> "close to
     nine percent"), decimals with units ("3.3 months" -> "a little over three months"), years, ordinals, plain numbers
  5. common abbreviations ("/mo", "APR", "e.g.", "vs.", "w/")
  6. punctuation tidy-up so the TTS gets clean sentences ending in a full stop

It is registered as a pipecat TextTransform (`text_transforms=[("*", normalizer.transform)]`): the transform only changes the text sent
to the TTS, the conversation context keeps what the model wrote."""
from __future__ import annotations

import math
import re
from collections.abc import Callable
from datetime import date

from num2words import num2words

_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
_MONTH_NUM = {m.lower(): i + 1 for i, m in enumerate(_MONTHS)}
_MONTH_NUM.update({"jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12})
_MONTH_RE = r"(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)"

# words that already say "this is approximate": we do not stack our own hedge on top of them. "over" keeps the number from rounding up,
# "under" keeps it from rounding down, the rest round to the nearest whole (or half).
_HEDGES_FLOOR = ("over", "above", "more than", "at least", "just over", "a little over", "a bit over")
_HEDGES_CEIL = ("under", "below", "less than", "at most", "up to", "just under")
_HEDGES_ROUND = ("about", "around", "roughly", "nearly", "almost", "approximately", "close to", "just", "some", "only")
_UNITS = r"(?:months?|years?|weeks?|days?|hours?|minutes?|times|x|mos?|yrs?|wks?)"
_DASH = r"[-‐-―−]"

# ---- character level -------------------------------------------------------------------------------------------------------------
_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U00002B00-\U00002BFF\U0001F1E6-\U0001F1FF\U0000FE0F\U0000200D\U000020E3"
    "\U00002300-\U000023FF\U000025A0-\U000025FF\U00002022\U000000B7\U00002605\U00002606]+"
)
_ZERO_WIDTH = re.compile("[​‌⁠﻿­]")
_QUOTES = str.maketrans({"‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"', "„": '"', " ": " ", " ": " ", " ": " ", " ": " "})

# ---- markdown and ids ------------------------------------------------------------------------------------------------------------
_FENCE = re.compile(r"```.*?```", re.S)
_LINK = re.compile(r"!?\[([^\]]*)\]\((?:[^)\s]*)\)")
_URL = re.compile(r"\b(?:https?://|www\.)\S+", re.I)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
_HTML = re.compile(r"</?[A-Za-z][^>]{0,80}>")
_STAGE_TAG = re.compile(r"\[(?:[A-Za-z][A-Za-z ,'-]{1,30})\]|\*[A-Za-z][A-Za-z ]{1,20}\*(?=\s|$)")  # "[laughs]", "[pause]", "*sighs*": TTS cues, never spoken
_HEADING = re.compile(r"(?m)^\s{0,3}#{1,6}\s+")
_QUOTE_LINE = re.compile(r"(?m)^\s{0,3}>+\s?")
_BULLET = re.compile(r"(?m)^\s*(?:[-*+•●◦‣]|\d{1,2}[.)])\s+")
_RULE = re.compile(r"(?m)^\s*(?:[-*_=]{3,})\s*$")
_EMPHASIS = re.compile(r"(\*\*|__|~~|\*|`)")
_UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
_HEX_BLOB = re.compile(r"\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{10,}\b")
_UNDERSCORE_ID = re.compile(r"(?<!\w)\w*_\w*(?!\w)")
_UNDERSCORE_EMPHASIS = re.compile(r"(?<!\w)(_{1,2})(?=\S)([^_\n]+?)\1(?!\w)")
_PREFIXED_ID = re.compile(r"\b(?:hh|acct|txn|tx|run|usr|mem|obl|job|msg|sess|call)-[A-Za-z0-9][A-Za-z0-9-]*\b", re.I)

# ---- numbers ---------------------------------------------------------------------------------------------------------------------
_NUM = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"
_ISO_DATE = re.compile(r"\b(\d{4})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b")
_ISO_MONTH = re.compile(r"\b(20\d{2})-(0[1-9]|1[0-2])\b(?!-)")
_SLASH_DATE_YEAR = re.compile(r"\b(0?[1-9]|1[0-2])/(0?[1-9]|[12]\d|3[01])/(\d{4}|\d{2})\b")
_SLASH_DATE_CUE = re.compile(r"\b(on|by|before|after|until|till|through|since|due|from|of)\s+(0?[1-9]|1[0-2])/(0?[1-9]|[12]\d|3[01])\b(?![/\d])", re.I)
_MONTH_DAY = re.compile(rf"\b({_MONTH_RE})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\b(?:,?\s+(\d{{4}})\b)?", re.I)
_DAY_MONTH = re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({_MONTH_RE})\b\.?(?:,?\s+(\d{{4}})\b)?", re.I)
_ORDINAL = re.compile(r"\b(\d{1,3})(st|nd|rd|th)\b", re.I)
_TIME_AMPM = re.compile(r"\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([ap])\.?\s?m\b\.?", re.I)
_TIME_24 = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s?[ap]\.?m)(?![:\d])")
# Names the voice gets wrong, respelled for the TTS only (logs and transcripts keep the real spelling). Checked with ElevenLabs
# speech-to-text: "Brianotron" came back as "Brianatron" ("bre-anna-tron"); "Bryan-o-tron" comes back as "Brianotron".
_SAY_AS = ((re.compile(r"\bBrianotron\b", re.I), "Bryan-o-tron"),)
_PHONE = re.compile(r"(?<![\d$])(?:\+?1[-. ])?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?!\d)")
_MONEY_RANGE = re.compile(rf"(-?)\$\s?({_NUM})(?:\s?([kKmM])\b)?\s?(?:{_DASH}\s?\$?|\bto\s+\$)\s?({_NUM})(?:\s?([kKmM])\b)?")
_MONEY_WORD = re.compile(rf"(-?)\$\s?({_NUM})(?:\s?(?:([kKmM])\b|(thousand|million|billion|grand)\b))?(?:\s(?:USD|dollars?|bucks)\b)?", re.I)
_USD_AFTER = re.compile(rf"\b({_NUM})\s?(?:USD|US dollars)\b", re.I)
_DOLLARS_AFTER = re.compile(rf"\b({_NUM})\s(dollars?|bucks)\b", re.I)
_PERCENT_RANGE = re.compile(rf"(-?)\b(\d+(?:\.\d+)?)\s?{_DASH}\s?(\d+(?:\.\d+)?)\s?(?:%|percent\b)", re.I)
_PERCENT = re.compile(rf"(-?)(\d+(?:\.\d+)?)\s?(?:%|percent\b)", re.I)
_RANGE = re.compile(rf"(?<![\w$.,/-])(\d{{1,3}}(?:,\d{{3}})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?{_DASH}\s?(\d{{1,3}}(?:,\d{{3}})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\w-])")
_DECIMAL_UNIT = re.compile(rf"(?<![\w.,$])(-?\d+\.\d+)(?=\s?{_UNITS}\b)", re.I)
_FRACTION = re.compile(r"(?<![\w/.])(\d{1,2})/(\d{1,2})(?![\w/])(?!\.\d)")
_YEAR = re.compile(r"(?<![\w$.,/-])((?:19|20)\d{2})(?![\w,.]?\d|%|\s?(?:dollars?|bucks|people|k\b|a\s+month|a\s+year|per\b|each\b|/))")
_NUMBER = re.compile(rf"(?<![\w.])(-?)({_NUM})(?![\w])")
_HASH_NUM = re.compile(r"#\s?(\d+)\b")
_MODEL_NUM = re.compile(r"\b([A-Za-z]{1,3})-(\d{2,4})\b")

_FRACTIONS = {(1, 2): "one half", (1, 3): "one third", (2, 3): "two thirds", (1, 4): "a quarter", (3, 4): "three quarters"}

_ABBREV = [
    (re.compile(r"\be\.g\.,?", re.I), "for example,"),
    (re.compile(r"\bi\.e\.,?", re.I), "that is,"),
    (re.compile(r"\betc\.(?=\s*[A-Z]|\s*$)", re.I), "and so on."),
    (re.compile(r"\betc\.", re.I), "and so on"),
    (re.compile(r"\bvs\.?(?=\s)", re.I), "versus"),
    (re.compile(r"\bapprox\.?(?=\s)", re.I), "about"),
    (re.compile(r"\bw/o\b", re.I), "without"),
    (re.compile(r"\bw/(?=\s)", re.I), "with"),
    (re.compile(r"\bMr\.", re.I), "Mister"),
    (re.compile(r"\bMrs\.", re.I), "Missus"),
    (re.compile(r"\bMs\.", re.I), "Miss"),
    (re.compile(r"\bDr\.(?=\s+[A-Z])"), "Doctor"),
    (re.compile(r"\bavg\.?(?=\s)", re.I), "average"),
    (re.compile(r"\best\.(?=\s+\w)", re.I), "estimated"),
    (re.compile(r"\bmgmt\b", re.I), "management"),
    (re.compile(r"\byrs?\.?(?=\W|$)", re.I), "years"),
    (re.compile(r"\bmos\.?(?=\W|$)", re.I), "months"),
    (re.compile(r"\bwks\.?(?=\W|$)", re.I), "weeks"),
]
_PER = [
    (re.compile(r"\s?/\s?(?:mo|month)\b\.?", re.I), " a month"),
    (re.compile(r"\s?/\s?(?:yr|year)\b\.?", re.I), " a year"),
    (re.compile(r"\s?/\s?(?:wk|week)\b\.?", re.I), " a week"),
    (re.compile(r"\s?/\s?day\b", re.I), " a day"),
    (re.compile(r"\bper\s+mo\b\.?", re.I), "per month"),
    (re.compile(r"\bper\s+yr\b\.?", re.I), "per year"),
]
_ACRONYMS = {  # spelled out letter by letter, or replaced by plain words
    "APR": "A P R", "APY": "A P Y", "IRA": "I R A", "HSA": "H S A", "FSA": "F S A", "ATM": "A T M", "AI": "A I", "ID": "I D", "SSN": "S S N",
    "ETF": "E T F", "CEO": "C E O", "FAQ": "F A Q", "IRS": "I R S", "FDIC": "F D I C", "NSF": "N S F", "ACH": "A C H", "CPI": "C P I",
    "GDP": "G D P", "PDF": "P D F", "SMS": "S M S", "USA": "U S A", "US": "U S", "DTI": "debt to income", "USD": "dollars", "OK": "okay",
    "ASAP": "as soon as possible", "FYI": "F Y I", "HELOC": "hee lock", "FICO": "fy co", "ARM": "A R M", "CD": "C D", "CDs": "C Ds",
}
_ACRONYM_RE = re.compile(r"\b(" + "|".join(sorted(map(re.escape, _ACRONYMS), key=len, reverse=True)) + r")\b")
_RETIREMENT = re.compile(r"\b(401|403|457)\s?\(([kKbB])\)")
_RETIREMENT_WORDS = {"401": "four oh one", "403": "four oh three", "457": "four fifty seven"}


# ---- number words ----------------------------------------------------------------------------------------------------------------
def say_int(n: int) -> str:
    """12 -> "twelve", 1200 -> "twelve hundred", 35000 -> "thirty-five thousand", 1850 -> "one thousand eight hundred fifty"."""
    if n < 0:
        return "minus " + say_int(-n)
    if 1100 <= n < 10000 and n % 100 == 0 and n % 1000 != 0:
        return num2words(n // 100) + " hundred"
    return _plain(num2words(n))


def _plain(words: str) -> str:
    return words.replace(",", "").replace(" and ", " ")


def say_ordinal(n: int) -> str:
    return _plain(num2words(n, to="ordinal"))


def say_year(y: int) -> str:
    if 2000 <= y <= 2009:
        return "two thousand" + ("" if y == 2000 else " " + num2words(y - 2000))
    return _plain(num2words(y, to="year"))


def say_digits(s: str) -> str:
    return " ".join("zero" if c == "0" else num2words(int(c)) for c in s if c.isdigit())


def _float(s: str) -> float:
    return float(s.replace(",", ""))


def _hedged(text: str, pos: int) -> str:
    """"" when nothing before the number hedges it, else "floor" / "ceil" / "round"."""
    before = text[:pos].rstrip().lower().rstrip(",")
    for names, mode in ((_HEDGES_FLOOR, "floor"), (_HEDGES_CEIL, "ceil"), (_HEDGES_ROUND, "round")):
        if any(before == h or before.endswith(" " + h) for h in names):
            return mode
    return ""


_NOT_A_NOUN = frozenset(
    "a an the per in on at for of to and or but that which who whom whose we you i they it he she from by with if when as so is are was were will would "
    "could should can may might has have had does did do not be been being left more less than then there here this these those our your my their".split()
)
_DETERMINER = re.compile(r"(?:^|\s)(?:a|an|the|this|that|another|any|each|every|one|our|your|my)\s*$", re.I)
_NEXT_WORD = re.compile(r"\s+([A-Za-z][A-Za-z'-]*)")


def _is_modifier(text: str, start: int, end: int) -> bool:
    """True for "a $35k car": a determiner right before the amount and a noun right after it, so the unit is singular."""
    if not _DETERMINER.search(text[:start]):
        return False
    nxt = _NEXT_WORD.match(text, end)
    return bool(nxt) and nxt[1].lower() not in _NOT_A_NOUN


def say_approx(x: float, *, hedged: str | bool = "") -> str:
    """A number with a unit after it, said the way people round it: 3.3 -> "a little over three", 8.8 -> "close to nine", 3.5 -> "three
    and a half", 12.4 -> "a little over twelve". `hedged` ("round", "floor", "ceil" or True): the sentence already says "about" /
    "over" / "under", so just round the number the right way and add no hedge of our own."""
    sign = "minus " if x < 0 else ""
    x = abs(x)
    mode = "round" if hedged is True else hedged
    whole, frac = int(math.floor(x)), x - math.floor(x)
    if x >= 20:  # big enough that decimals are noise
        r = int(round(x))
        return sign + ("" if mode or abs(x - r) < 0.05 else "about ") + say_int(r)
    if mode:
        if mode == "floor":
            r = math.floor(x * 2) / 2
        elif mode == "ceil":
            r = math.ceil(x * 2) / 2
        elif frac < 0.35:
            r = whole
        elif frac < 0.65:
            r = whole + 0.5
        else:
            r = whole + 1
        return sign + (say_int(int(r)) if r == int(r) else say_int(int(r)) + " and a half")
    if frac < 0.05:
        return sign + say_int(whole)
    if frac < 0.35:
        return sign + "a little over " + say_int(whole)
    if frac < 0.65:
        exact = abs(frac - 0.5) < 0.005
        return sign + ("" if exact else "about ") + say_int(whole) + " and a half"
    if frac < 0.95:
        return sign + "close to " + say_int(whole + 1)
    return sign + say_int(whole + 1)


def say_decimal(x: float) -> str:
    """Plain decimal with no unit: 2.5 -> "two point five"; long tails are cut to two places."""
    sign = "minus " if x < 0 else ""
    x = abs(round(x, 2))
    whole, _, rest = f"{x:.2f}".partition(".")
    rest = rest.rstrip("0")
    return sign + say_int(int(whole)) + (" point " + say_digits(rest) if rest else "")


def _round_money(a: float) -> tuple[float, bool]:
    """Human rounding for a dollar amount: (rounded value, whether it is approximate)."""
    if a >= 10_000:
        step = 1000
    elif a >= 1_000:
        # amounts people state exactly (1,850 rent, 2,400, 1,200) stay; odd ones go to the nearest hundred
        step = 1 if a == int(a) and a % 50 == 0 else 100
    else:
        step = 1
    r = round(a / step) * step
    return float(r), abs(r - a) > 0.005


def money_core(amount: float, *, hedged: str | bool = "", large_unit: str | None = None) -> tuple[str, str]:
    """(words, noun) for a dollar amount: (39655.4) -> ("about forty thousand", "dollars"). `large_unit` is "million"/"billion"/"thousand"
    when the amount is already scaled ("1.5 million")."""
    sign = "minus " if amount < 0 else ""
    a = abs(amount)
    hedge = "" if hedged else "about "
    if large_unit or a >= 1_000_000:
        unit = large_unit or ("billion" if a >= 1e9 else "million")
        v = a if large_unit else a / {"million": 1e6, "billion": 1e9}[unit]
        v = round(v, 1)
        approx = abs(v - (a if large_unit else a / {"million": 1e6, "billion": 1e9}[unit])) > 0.005
        if v == int(v):
            words = say_int(int(v))
        elif abs(v - int(v) - 0.5) < 1e-9:
            words = say_int(int(v)) + " and a half"
        else:
            words = say_int(int(v)) + " point " + say_digits(f"{v:.1f}".split(".")[1])
        return sign + (hedge if approx else "") + words + " " + unit, "dollars"
    if a < 1:
        cents = int(round(a * 100))
        return (sign + "zero", "dollars") if cents == 0 else (sign + say_int(cents), "cent" if cents == 1 else "cents")
    r, approx = _round_money(a)
    return sign + (hedge if approx else "") + say_int(int(r)), "dollar" if r == 1 else "dollars"


def say_money(amount: float, *, hedged: str | bool = "", large_unit: str | None = None) -> str:
    words, noun = money_core(amount, hedged=hedged, large_unit=large_unit)
    return f"{words} {noun}"


# ---- the normalizer --------------------------------------------------------------------------------------------------------------
def say_as(text: str) -> str:
    """The text as the voice should hear it (only the TTS gets this; see _SAY_AS)."""
    for rx, spoken in _SAY_AS:
        text = rx.sub(spoken, text)
    return text


class SpeechNormalizer:
    """`today` decides which dates need a year: "November twenty-fourth" this year, "March twenty twenty-eight" later."""

    def __init__(self, today: date | str | None = None):
        self.today = today  # type: ignore[assignment]
        self.on_spoken: "Callable[[str], None] | None" = None  # told what is about to be spoken (barge.SpokenLog: the echo guard compares against it)

    @property
    def today(self) -> date:
        return self._today or date.today()

    @today.setter
    def today(self, value: date | str | None) -> None:
        if isinstance(value, str):
            try:
                value = date.fromisoformat(value[:10])
            except ValueError:
                value = None
        self._today = value

    # pipecat TextTransform signature
    async def transform(self, text: str, text_type: str = "sentence") -> str:
        out = self.normalize(text)
        if self.on_spoken and out:
            try:
                self.on_spoken(out)
            except Exception:  # pragma: no cover - a log must never break speech
                pass
        return say_as(out)

    def normalize(self, text: str) -> str:
        t = self._strip_markup(text or "")
        t = self._dashes(t)
        t = self._dates(t)
        t = self._times(t)
        t = self._numbers(t)
        t = self._abbreviations(t)
        return self._tidy(t)

    # 1 + 2 -----------------------------------------------------------------------------------------------------------------------
    def _strip_markup(self, t: str) -> str:
        t = t.translate(_QUOTES)
        t = _ZERO_WIDTH.sub("", t)
        t = _FENCE.sub(" ", t)
        t = _LINK.sub(r"\1", t)
        t = _URL.sub(" ", t)
        t = _EMAIL.sub(" ", t)
        t = _HTML.sub(" ", t)
        t = _STAGE_TAG.sub(" ", t)
        t = _RULE.sub(" ", t)
        t = _HEADING.sub("", t)
        t = _QUOTE_LINE.sub("", t)
        t = _BULLET.sub("", t)
        t = _EMOJI.sub(" ", t)
        t = _UNDERSCORE_EMPHASIS.sub(r"\2", t)  # _italic_ and __bold__ keep their words; hh_rivera does not match (no leading underscore)
        t = _UUID.sub(" ", t)
        t = _PREFIXED_ID.sub(" ", t)
        t = _UNDERSCORE_ID.sub(" ", t)
        t = _HEX_BLOB.sub(" ", t)
        t = _EMPHASIS.sub("", t)
        t = t.replace("|", ", ")
        # line breaks are sentence breaks (unless the line already ended with punctuation)
        t = re.sub(r"(?<=[A-Za-z0-9\"')\]%$])[ \t]*\r?\n+[ \t]*", ". ", t)
        t = re.sub(r"\s*\r?\n+\s*", " ", t)
        return t

    def _dashes(self, t: str) -> str:
        t = t.replace("…", "...")
        t = re.sub(r"\s*\.{3,}\s*", ", ", t)
        # ranges are handled with the numbers; here only dashes used as punctuation (em/en dash, spaced hyphen, double hyphen)
        t = re.sub(r"\s*[–—―]\s*(?!\d)", ", ", t)
        t = re.sub(r"(?<=\D)\s*[–—―]\s*(?=\d)", ", ", t)
        t = re.sub(r"(\S)\s+-{1,2}\s+(\S)", lambda m: m[0] if (m[1].isdigit() and (m[2].isdigit() or m[2] == "$")) else f"{m[1]}, {m[2]}", t)
        t = re.sub(r"(?<=\w)--+(?=\w)", ", ", t)
        t = t.replace("→", ", ").replace("->", ", ").replace("=>", ", ")
        return t

    # 3 ---------------------------------------------------------------------------------------------------------------------------
    def _year_suffix(self, year: int | None) -> str:
        if year is None or year == self.today.year:
            return ""
        return " " + say_year(year)

    def _dates(self, t: str) -> str:
        def iso(m: re.Match) -> str:
            y, mo, d = int(m[1]), int(m[2]), int(m[3])
            return f"{_MONTHS[mo - 1]} {say_ordinal(d)}{',' + self._year_suffix(y) if self._year_suffix(y) else ''}"

        def iso_month(m: re.Match) -> str:
            y, mo = int(m[1]), int(m[2])
            return f"{_MONTHS[mo - 1]}{self._year_suffix(y)}"

        def slash_year(m: re.Match) -> str:
            mo, d, y = int(m[1]), int(m[2]), int(m[3])
            y = y + 2000 if y < 100 else y
            ys = self._year_suffix(y)
            return f"{_MONTHS[mo - 1]} {say_ordinal(d)}{',' + ys if ys else ''}"

        def slash_cue(m: re.Match) -> str:
            return f"{m[1]} {_MONTHS[int(m[2]) - 1]} {say_ordinal(int(m[3]))}"

        def month_day(m: re.Match) -> str:
            mo = _MONTH_NUM[m[1].lower()]
            d = int(m[2])
            if not 1 <= d <= 31:
                return m[0]
            y = int(m[3]) if m[3] else None
            ys = self._year_suffix(y)
            return f"{_MONTHS[mo - 1]} {say_ordinal(d)}{',' + ys if ys else ''}"

        def day_month(m: re.Match) -> str:
            d = int(m[1])
            if not 1 <= d <= 31:
                return m[0]
            mo = _MONTH_NUM[m[2].lower()]
            ys = self._year_suffix(int(m[3])) if m[3] else ""
            return f"{_MONTHS[mo - 1]} {say_ordinal(d)}{',' + ys if ys else ''}"

        t = _ISO_DATE.sub(iso, t)
        t = _ISO_MONTH.sub(iso_month, t)
        t = _SLASH_DATE_YEAR.sub(slash_year, t)
        t = _SLASH_DATE_CUE.sub(slash_cue, t)
        t = _MONTH_DAY.sub(month_day, t)
        t = _DAY_MONTH.sub(day_month, t)
        t = _ORDINAL.sub(lambda m: say_ordinal(int(m[1])), t)
        return t

    def _times(self, t: str) -> str:
        def hm(h: int, mi: int) -> str:
            if mi == 0:
                return say_int(h)
            return (f"{say_int(h)} oh {say_int(mi)}" if mi < 10 else f"{say_int(h)} {say_int(mi)}")

        def ampm(m: re.Match) -> str:
            h, mi = int(m[1]), int(m[2] or 0)
            return hm(h, mi) + f" {m[3].lower()} m"

        def h24(m: re.Match) -> str:
            h, mi = int(m[1]), int(m[2])
            if h == 0 and mi == 0:
                return "midnight"
            if h == 12 and mi == 0:
                return "noon"
            if h > 12:
                return hm(h - 12, mi) + " p m"
            if h == 0:
                return hm(12, mi) + " a m"
            return hm(h, mi)

        t = _TIME_AMPM.sub(ampm, t)
        return _TIME_24.sub(h24, t)

    # 4 ---------------------------------------------------------------------------------------------------------------------------
    def _numbers(self, t: str) -> str:
        t = _RETIREMENT.sub(lambda m: f"{_RETIREMENT_WORDS[m[1]]} {m[2].lower()}", t)
        t = _PHONE.sub(lambda m: say_digits(re.sub(r"^\+?1[-. ]", "", m[0])), t)
        t = _HASH_NUM.sub(lambda m: f"number {say_int(int(m[1]))}", t)
        t = _MODEL_NUM.sub(lambda m: f"{m[1]} {self._model_digits(m[2])}", t)
        t = re.sub(r"<\s?(?=[\d$])", "under ", t)
        t = re.sub(r">\s?(?=[\d$])", "over ", t)
        t = t.replace("\u2264", "at most ").replace("\u2265", "at least ").replace("\u2248", "about ")
        t = t.replace("~$", "about $").replace("~", "about ")

        def money_range(m: re.Match) -> str:
            sign = -1 if m[1] else 1
            a = sign * self._scaled(m[2], m[3], m[5])
            b = self._scaled(m[4], m[5], m[3])
            wa, na = money_core(a)
            wb, nb = money_core(b)
            return f"{wa} to {wb} {nb}" if na == nb else f"{wa} {na} to {wb} {nb}"

        def pct_range(m: re.Match) -> str:
            return f"{self._plain_num(m[2])} to {self._plain_num(m[3])} percent"

        t = _MONEY_RANGE.sub(money_range, t)
        t = _PERCENT_RANGE.sub(pct_range, t)

        def money(m: re.Match) -> str:
            sign = -1 if m[1] else 1
            unit = (m[4] or "").lower()
            suffix = (m[3] or "").lower()
            hedged = _hedged(m.string, m.start())
            v = _float(m[2])
            if suffix == "k" or unit in ("thousand", "grand"):
                amount = sign * v * 1000
            elif suffix == "m" or unit == "million":
                amount = sign * v * 1_000_000 if v >= 1 else sign * v
            elif unit == "billion":
                amount = sign * v * 1e9
            else:
                amount = sign * v
            words, noun = money_core(amount, hedged=hedged)
            if noun == "dollars" and not words.startswith(("about", "minus")) and _is_modifier(m.string, m.start(), m.end()):
                noun = "dollar"  # "a $35k car" -> "a thirty-five thousand dollar car"
            return f"{words} {noun}"

        t = _MONEY_WORD.sub(money, t)
        t = _USD_AFTER.sub(lambda m: say_money(_float(m[1]), hedged=_hedged(m.string, m.start())), t)
        t = _DOLLARS_AFTER.sub(lambda m: say_money(_float(m[1]), hedged=_hedged(m.string, m.start())) if "." in m[1] or _float(m[1]) >= 1000 else m[0], t)
        t = _PERCENT.sub(lambda m: self._pct_words(_float(m[2]) * (-1 if m[1] else 1), _hedged(m.string, m.start())) + " percent", t)
        t = _RANGE.sub(lambda m: f"{m[1]} to {m[2]}", t)
        t = _DECIMAL_UNIT.sub(lambda m: say_approx(_float(m[1]), hedged=_hedged(m.string, m.start())), t)
        t = _FRACTION.sub(lambda m: _FRACTIONS.get((int(m[1]), int(m[2])), f"{say_int(int(m[1]))} out of {say_int(int(m[2]))}"), t)
        t = _YEAR.sub(lambda m: say_year(int(m[1])), t)

        def number(m: re.Match) -> str:
            raw = m[2]
            val = _float(raw)
            sign = -1 if m[1] else 1
            if "." in raw:
                return say_decimal(sign * val)
            if len(raw) > 1 and raw.startswith("0") and "," not in raw:  # 007, 0042: read the digits
                return say_digits(raw)
            return say_int(sign * int(val))

        return _NUMBER.sub(number, t)

    @staticmethod
    def _model_digits(d: str) -> str:
        """Product numbers are said in pairs: 150 -> "one fifty", 2500 -> "twenty five hundred"."""
        if len(d) == 2:
            return say_int(int(d))
        if len(d) == 3:
            return say_int(int(d[0])) + " " + (say_int(int(d[1:])) if d[1] != "0" else "oh " + say_int(int(d[2])) if d[2] != "0" else "hundred")
        return say_int(int(d[:2])) + " " + (say_int(int(d[2:])) if d[2:] != "00" else "hundred")

    @staticmethod
    def _plain_num(raw: str) -> str:
        return say_approx(float(raw), hedged=True) if "." in raw else say_int(int(raw))

    def _pct_words(self, x: float, hedged: bool) -> str:
        if x == int(x):
            return say_int(int(x))
        if abs(x) < 1:
            return "less than one" if abs(x) < 0.5 else ("about one" if not hedged else "one")
        return say_approx(x, hedged=hedged)

    @staticmethod
    def _scaled(num: str, suffix: str | None, other: str | None) -> float:
        s = (suffix or other or "").lower()
        return _float(num) * {"k": 1_000, "m": 1_000_000, "": 1}[s]

    # 5 ---------------------------------------------------------------------------------------------------------------------------
    def _abbreviations(self, t: str) -> str:
        for rx, rep in _PER:
            t = rx.sub(rep, t)
        for rx, rep in _ABBREV:
            t = rx.sub(rep, t)
        t = _ACRONYM_RE.sub(lambda m: _ACRONYMS[m[1]], t)
        t = re.sub(r"\s*&\s*", " and ", t)
        t = t.replace("@", " at ")
        t = re.sub(r"(?<=\s)\+(?=\s)", " plus ", t)
        t = t.replace("%", " percent").replace("$", " dollars ")
        return t

    # 6 ---------------------------------------------------------------------------------------------------------------------------
    def _tidy(self, t: str) -> str:
        t = re.sub(r"\(\s*\)|\[\s*\]", " ", t)
        t = re.sub(r"\s*[\(\[\{]\s*", ", ", t)  # a parenthetical is a spoken aside
        t = re.sub(r"\s*[\)\]\}]\s*", ", ", t)
        t = re.sub(r"[\*_#^\\<>=•·●]+", " ", t)
        t = t.replace(";", ",")
        t = re.sub(r"\s+", " ", t)
        t = re.sub(r"\s+([,.!?:])", r"\1", t)
        t = re.sub(r"([,:])(\s*[,:])+", r"\1", t)
        t = re.sub(r"([,:])\s*([.!?])", r"\2", t)
        t = re.sub(r"([.!?])\s*,", r"\1", t)
        t = re.sub(r"\.{2,}", ".", t)
        t = re.sub(r"([!?])\1+", r"\1", t)
        t = re.sub(r"([.!?])\s*\.", r"\1", t)
        t = re.sub(r"^[\s,.;:!?\-]+", "", t)
        t = re.sub(r"[\s,;:\-]+$", "", t)
        t = re.sub(r",(?=[A-Za-z])", ", ", t)
        t = t.strip()
        if not any(c.isalnum() for c in t):
            return ""
        if t[-1] not in ".!?":
            t += "."
        return t


_default = SpeechNormalizer()


def normalize_for_speech(text: str, today: date | str | None = None) -> str:
    n = _default if today is None else SpeechNormalizer(today)
    return n.normalize(text)


async def speech_transform(text: str, text_type: str = "sentence") -> str:
    """Module-level TextTransform (uses the real current date). The bot uses its own SpeechNormalizer so dates follow the demo's `as_of`."""
    return _default.normalize(text)
