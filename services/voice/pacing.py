"""Backstops that keep a spoken turn short even when the model forgets the prompt.

The prompt asks for one or two sentences (about 30 words). `VOICE_LLM_MAX_TOKENS` is the hard stop at the API, but a token limit cuts a
sentence in half, which sounds worse than rambling. SentenceCap is the polite version: once a turn has said `max_words` words it lets the
current sentence finish and drops everything after it. Pure logic, no pipecat imports, so it is unit-tested directly."""
from __future__ import annotations

import re

_END = re.compile(r"""[.!?]["')\]]*\s*$""")
_DIGIT_DOT = re.compile(r"\d\.$")


class SentenceCap:
    def __init__(self, max_words: int = 45, max_sentences: int = 3):
        self.max_words = max_words
        self.max_sentences = max_sentences
        self.reset()

    def reset(self) -> None:
        self.words = 0
        self.sentences = 0
        self.closed = False
        self._in_word = False

    def allow(self, chunk: str) -> bool:
        """Feed the next streamed piece of the reply; True = pass it on to the voice, False = drop it (the turn has said enough)."""
        if self.closed:
            return False
        for ch in chunk:
            if ch.isspace():
                self._in_word = False
            elif not self._in_word:
                self._in_word = True
                self.words += 1
        stripped = chunk.rstrip()
        if stripped and _END.search(stripped) and not _DIGIT_DOT.search(stripped):
            self.sentences += 1
            if self.words >= self.max_words or self.sentences >= self.max_sentences:
                self.closed = True  # this chunk ends the last sentence we let through
        return True
