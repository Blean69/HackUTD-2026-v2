"""The last line of defence on what Brian SAYS: a sentence that would leak something never reaches the voice.

Brian is a prompt-driven model on a phone line, so anything a caller can talk him into is a candidate for a leak: his instructions, internal
ids, tool names, secrets, long digit strings (account numbers), links, and false claims that he moved or paid something. This guard checks
every sentence BEFORE it is spoken. The voice already waits for a whole sentence, so holding text back to a sentence boundary costs no
latency. A sentence that fails is dropped together with the rest of that reply, and the caller hears a fixed polite line instead.

Defence in depth, not the only layer: the prompt tells the model not to do any of this, the worker only ever hands the model a rounded,
household-scoped view of the data (phone/voice_view.ts), and the model never holds a secret to leak. Pure logic, no pipecat imports."""
from __future__ import annotations

import re

TOOL_NAMES = (
    "get_forecast", "get_obligations", "get_health_indicators", "get_accounts", "get_credit_score", "simulate_scenario", "goal_feasibility", "detect_scam_signals",
    "find_savings", "get_kids", "add_kid_chore", "add_to_kid_jar", "approve_kid_chore", "set_kid_goal",
    "get_goals", "change_goal", "save_what_if", "get_alerts", "mark_alert_handled", "get_proposals", "create_proposal",
)

_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("internal_id", re.compile(r"\b(?:hh|mem|acct|txn|obl|goal|run|job|prop|kt|scn|call)_[a-z0-9][a-z0-9_]{2,}\b", re.I)),
    ("tool_name", re.compile(r"\b(?:" + "|".join(TOOL_NAMES) + r")\b|\breply_hint\b", re.I)),
    ("secret", re.compile(r"\bsk-[A-Za-z0-9_-]{12,}|\bnvapi-[A-Za-z0-9_-]{12,}|\bbearer\s+[A-Za-z0-9._-]{16,}|\b[A-Fa-f0-9]{32,}\b|\b[A-Z][A-Z0-9]*_(?:SECRET|KEY|TOKEN|PINS?)\b|x-voice-secret", re.I)),
    ("link_or_email", re.compile(r"https?://|\bwww\.|[\w.+-]+@[\w-]+\.[\w.]+", re.I)),
    ("long_digits", re.compile(r"\b\d{3}-\d{2}-\d{4}\b|\b\d{9,}\b|\b(?:\d[ -]?){12,}\d\b")),
    ("action_claim", re.compile(r"\bI(?:'ve| have|'ll| will| can)\s+(?:just\s+|now\s+|go ahead and\s+)?(?:move|moved|transfer|transferred|send|sent|pay|paid|cancel|cancelled|canceled|wire|wired)\b(?!\s+on\b)", re.I)),
]

_SENTENCE_END = re.compile(r"(?<=[.!?])[\"')\]]*\s+")
_WORD = re.compile(r"[a-z0-9']+")
_BRIEF_MARK = "WHAT YOU KNOW RIGHT NOW"


def _shingles(text: str, n: int) -> set[tuple[str, ...]]:
    w = _WORD.findall(text.lower())
    return {tuple(w[i : i + n]) for i in range(len(w) - n + 1)}


class LeakGuard:
    """Feed streamed reply text in; get back only the whole sentences that are safe to speak."""

    def __init__(self, prompt: str = "", n: int = 9):
        self.n = n
        self._echo: set[tuple[str, ...]] = set()
        self.blocked: list[str] = []  # reasons, one per blocked reply (for the call's stats)
        self.set_prompt(prompt)
        self.reset()

    def set_prompt(self, prompt: str) -> None:
        """The instructions that must never be read back. The household notes after the marker are fair game: they are what Brian talks about."""
        self._echo = _shingles(prompt.split(_BRIEF_MARK)[0], self.n) if prompt else set()

    def reset(self) -> None:
        self._buf = ""
        self.tripped = False
        self.reason = ""

    def violation(self, sentence: str) -> str:
        """Why this sentence must not be spoken ("" = fine)."""
        for name, rx in _RULES:
            if rx.search(sentence):
                return name
        if self._echo and not self._echo.isdisjoint(_shingles(sentence, self.n)):
            return "prompt_echo"
        return ""

    def _trip(self, why: str) -> None:
        self.tripped = True
        self.reason = why
        self._buf = ""
        self.blocked.append(why)

    def feed(self, text: str) -> list[str]:
        """Add the next streamed piece. Returns complete, checked sentences (with their trailing space) ready for the voice; after a trip, nothing."""
        if self.tripped:
            return []
        self._buf += text
        out: list[str] = []
        while True:
            m = _SENTENCE_END.search(self._buf)
            if not m:
                return out
            sentence, self._buf = self._buf[: m.end()], self._buf[m.end() :]
            why = self.violation(sentence)
            if why:
                self._trip(why)
                return out
            out.append(sentence)

    def flush(self) -> list[str]:
        """The reply ended: check and release whatever is left."""
        if self.tripped or not self._buf:
            self._buf = ""
            return []
        rest, self._buf = self._buf, ""
        why = self.violation(rest)
        if why:
            self._trip(why)
            return []
        return [rest]
