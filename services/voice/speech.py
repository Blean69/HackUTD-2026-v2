"""Text -> what the TTS should say. The NIM card says input text must be normalized, and models write "$35,000" and "2026-11-14".
pipecat's VoiceFormatter expands currency, percentages, numbers and acronyms; we add "$35k" and ISO dates first."""
from __future__ import annotations

import re

from num2words import num2words

from pipecat.utils.text.transforms.voice_formatter import VoiceFormatter

_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
_K = re.compile(r"\$\s?(\d+(?:\.\d+)?)\s?([kKmM])\b")
_ISO = re.compile(r"\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b")
_MONTH_YEAR = re.compile(r"\b(20\d{2})-(0[1-9]|1[0-2])\b")
_YEAR = re.compile(r"\b(20\d{2})\b")


def _k(m: re.Match) -> str:
    mult = 1_000 if m.group(2).lower() == "k" else 1_000_000
    return f"${round(float(m.group(1)) * mult):,}"


def _iso(m: re.Match) -> str:
    month = _MONTHS[int(m.group(2)) - 1]
    return f"{month} {num2words(int(m.group(3)), to='ordinal')}"


def _month_year(m: re.Match) -> str:
    return f"{_MONTHS[int(m.group(2)) - 1]} {_year_words(int(m.group(1)))}"


def _year_words(y: int) -> str:
    return num2words(y, to="year")


_DASHES = str.maketrans({"\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": ", ", "\u2212": "-", "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u00a0": " ", "\u2026": "..."})


def pre_normalize(text: str) -> str:
    text = text.translate(_DASHES)
    text = _K.sub(_k, text)
    text = _ISO.sub(_iso, text)
    text = _MONTH_YEAR.sub(_month_year, text)
    text = _YEAR.sub(lambda m: _year_words(int(m.group(1))), text)
    return text


_formatter = VoiceFormatter(
    strip_markdown=True,
    expand_phone_numbers=False,
    normalize_acronyms=False,
    expand_currency=True,
    expand_numbers=True,
    expand_percentages=True,
    expand_units=False,
    email_to_speech=False,
    normalize_dates=False,
)


async def speech_transform(text: str, text_type: str = "sentence") -> str:
    """A pipecat TextTransform: register as text_transforms=[("*", speech_transform)] on the TTS service."""
    out = await _formatter(pre_normalize(text), text_type)
    return re.sub(r"\s+", " ", out).strip()
