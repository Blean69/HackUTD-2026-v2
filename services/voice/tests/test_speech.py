import pytest

from speech import pre_normalize, speech_transform


@pytest.mark.parametrize(
    "text,expected",
    [
        ("A $35k car", "thirty-five thousand dollars"),
        ("About $1,200 a month", "one thousand, two hundred dollars"),
        ("saving 9% of income", "nine percent"),
        ("That is $39,655.40 at the low", "thirty-nine thousand, six hundred and fifty-five dollars and forty cents"),
        ("Rent is due on 2026-11-24", "November twenty-fourth"),
        ("over 12 months", "twelve months"),
    ],
)
async def test_numbers_become_words(text, expected):
    out = await speech_transform(text)
    assert expected in out
    assert not any(c.isdigit() for c in out), out


async def test_markdown_and_odd_punctuation_are_cleaned():
    out = await speech_transform("**Good news**—your month‑by‑month payment is “manageable”.\n\n")
    assert "*" not in out and "‑" not in out and "—" not in out
    assert out.startswith("Good news") and "month-by-month" in out
    assert "\n" not in out


def test_k_and_m_suffix():
    assert pre_normalize("$2.5k") == "$2,500"
    assert pre_normalize("$1m") == "$1,000,000"
    assert pre_normalize("2026-12") == "December twenty twenty-six"
