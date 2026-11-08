"""Barge-in that does not fire on Brian's own voice or on room noise, and hold-to-talk (push-to-talk) from the browser.

The problem (seen in the browser Talk call and Table Mode): the speaker's sound reaches the microphone, the ASR transcribes Brian's own words,
and a start strategy that interrupts on "any two words" cuts him off mid-sentence; a cough or a second voice in the room does the same.
Three server-side guards, all in this module except the noise filter (noise.py):

  1. Echo-aware barge-in. While Brian is speaking, and for `grace_secs` after, a would-be interruption whose transcript FUZZILY MATCHES what
     he said in the last seconds is dropped (the aggregation is reset, no turn starts, he keeps talking). Matching is an in-order alignment
     (longest common subsequence) of the heard words against the spoken words, with each word compared fuzzily so an ASR-garbled echo
     ("spend" for "spending", "saving" for "savings") still counts. Real interruptions share a few common words with what he just said but
     almost never an in-order 60% of their words from one passage, so they pass.
  2. More words on the browser: `barge_in_words_webrtc` (3) instead of the phone's 2.
  3. Hold-to-talk. The browser sends RTVI client messages `{type: "ptt", state: enabled | disabled | pressed | released}` and `{type: "interrupt"}`
     (contract: docs/contracts.md section 8). While hold-to-talk is on, speech does not interrupt Brian by itself (the person's mic is closed
     except while the button is held); `pressed` while he talks is a deliberate barge-in and interrupts him at once; `released` ends the person's
     turn immediately, so he answers as soon as the transcript is in instead of waiting for silence detection and Smart Turn."""
from __future__ import annotations

import re
import time
from collections import deque
from collections.abc import Awaitable, Callable
from difflib import SequenceMatcher
from typing import Any

from loguru import logger

from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.turns.user_start.min_words_user_turn_start_strategy import MinWordsUserTurnStartStrategy
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy

from turns import HesitationAwareStop

# ---- word matching --------------------------------------------------------------------------------------------------------------------------
_WORD = re.compile(r"[a-z0-9']+")
STOPWORDS = frozenset(
    "a an the and or but if so of to in on at for with by from as is are was were be been am it its it's i i'm you you're your yours we our they them he she "
    "this that these those there here do does did have has had can could will would just not no yes oh um uh".split()
)
# short answers that are a real interruption even when Brian happened to say the same word
CONVERSATIONAL = frozenset("yes no yeah yep nope okay ok sure stop wait hold thanks thank please what huh sorry hello hey bye goodbye".split())


def tokens(text: str) -> list[str]:
    """Lower-case words with punctuation gone ("$1,500" -> "1", "500": digits matter little, and the ASR writes numbers its own way)."""
    return _WORD.findall((text or "").lower().replace("\u2019", "'"))


def same_word(a: str, b: str) -> bool:
    """Equal, or close enough to be the same spoken word after an ASR slip (edit similarity >= 0.75, only for words of 4+ letters)."""
    if a == b:
        return True
    if min(len(a), len(b)) < 4:
        return False
    if a[:3] != b[:3] and a[-3:] != b[-3:]:
        return False
    return SequenceMatcher(None, a, b).ratio() >= 0.75


def alignment(heard: list[str], spoken: list[str]) -> list[str]:
    """The heard words that line up IN ORDER with the spoken words (longest common subsequence under `same_word`)."""
    m, n = len(heard), len(spoken)
    if not m or not n:
        return []
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m - 1, -1, -1):
        for j in range(n - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if same_word(heard[i], spoken[j]) else max(dp[i + 1][j], dp[i][j + 1])
    out, i, j = [], 0, 0
    while i < m and j < n:
        if same_word(heard[i], spoken[j]) and dp[i][j] == dp[i + 1][j + 1] + 1:
            out.append(heard[i])
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return out


def echo_score(heard: str, spoken: str) -> float:
    """Share of the heard words that line up in order with the spoken text (0..1)."""
    h, s = tokens(heard), tokens(spoken)
    return len(alignment(h, s)) / len(h) if h else 0.0


def is_echo(heard: str, spoken: str, threshold: float = 0.6) -> bool:
    """True when `heard` looks like Brian's own recent speech coming back through the microphone.

    A) at least two words, and `threshold` of them line up in order with the spoken words, at least one of them a content word
       (a run of "the", "is", "you" proves nothing);
    B) one or two words, every one of them a word he said within his last dozen words and not a conversational answer
       ("yes", "stop", "wait"): the tail of his sentence reaching the ASR just after he stopped."""
    h = tokens(heard)
    if not h or not tokens(spoken) or threshold <= 0:
        return False
    s = tokens(spoken)
    if len(h) >= 2:
        matched = alignment(h, s)
        return len(matched) >= 2 and len(matched) / len(h) >= threshold and any(w not in STOPWORDS for w in matched)
    tail = s[-12:]
    return all(w not in CONVERSATIONAL and w not in STOPWORDS and any(same_word(w, t) for t in tail) for w in h)


class SpokenLog:
    """What the voice has been sent to say, newest last, for the last `keep_secs` (post-normalization: the words an echo would be transcribed as)."""

    def __init__(self, keep_secs: float = 25.0, now: Callable[[], float] = time.monotonic):
        self.keep_secs, self._now = keep_secs, now
        self._items: deque[tuple[float, str]] = deque(maxlen=60)

    def add(self, text: str) -> None:
        if text and text.strip():
            self._items.append((self._now(), text.strip()))

    def recent(self) -> str:
        t = self._now()
        return " ".join(x for at, x in self._items if t - at <= self.keep_secs)

    def clear(self) -> None:
        self._items.clear()


# ---- the shared control ---------------------------------------------------------------------------------------------------------------------
class BargeControl:
    """One per call. Holds the hold-to-talk state, what Brian said lately, and the strategies it steers."""

    def __init__(self, *, echo_overlap: float = 0.6, grace_secs: float = 1.0, now: Callable[[], float] = time.monotonic):
        self.echo_overlap, self.grace_secs, self.now = echo_overlap, grace_secs, now
        self.spoken = SpokenLog(now=now)
        self.ptt_enabled = False
        self.ptt_pressed = False
        self.bot_speaking = False
        self.stops: list[Any] = []
        self.interrupt: Callable[[], Awaitable[None]] | None = None  # wired by VoiceCall: stop Brian talking right now
        self.on_echo: Callable[[str], None] | None = None  # wired by VoiceCall: a trace note (rate limited there)
        self.stats = {"echo_dropped": 0, "ptt_presses": 0, "ptt_releases": 0, "ptt_voice_ignored": 0, "interrupts": 0}

    async def client_message(self, mtype: str, data: Any) -> str:
        """An RTVI client message from the browser. Returns what was done ("" = not ours / not understood). Never raises."""
        try:
            state = str((data or {}).get("state", "")).lower() if isinstance(data, dict) else ""
            if mtype == "ptt" and state in ("enabled", "disabled", "pressed", "released"):
                if state == "enabled":
                    self.ptt_enabled, self.ptt_pressed = True, False
                elif state == "disabled":
                    self.ptt_enabled = self.ptt_pressed = False
                elif state == "pressed":
                    self.ptt_enabled, self.ptt_pressed = True, True  # a press implies hold-to-talk is on even if "enabled" was never sent
                    self.stats["ptt_presses"] += 1
                    for stop in self.stops:
                        stop.clear_release()
                    if self.bot_speaking:
                        await self._interrupt()  # pressing while Brian talks is a deliberate barge-in
                else:
                    self.ptt_pressed = False
                    self.stats["ptt_releases"] += 1
                    for stop in self.stops:
                        await stop.force_end()  # the person is done: answer as soon as the transcript is in
                return f"ptt:{state}"
            if mtype == "interrupt":
                if self.bot_speaking:
                    await self._interrupt()
                return "interrupt"
        except Exception as e:  # a bad message must not take a call down
            logger.warning(f"client message {mtype!r} failed: {type(e).__name__}: {e}")
        return ""

    async def _interrupt(self) -> None:
        self.stats["interrupts"] += 1
        if self.interrupt:
            await self.interrupt()


# ---- strategies ----------------------------------------------------------------------------------------------------------------------------
class EchoAwareStart(MinWordsUserTurnStartStrategy):
    """MinWords start (a transcript of `min_words` words interrupts Brian; one word starts a turn when he is quiet) plus the echo guard
    and the hold-to-talk rules. Everything else is the stock strategy."""

    def __init__(self, *, min_words: int, barge: BargeControl, **kwargs: Any):
        super().__init__(min_words=min_words, **kwargs)
        self.barge = barge
        self._bot_stopped_at: float | None = None

    async def handle_user_turn_started(self):
        await super().handle_user_turn_started()
        self.barge.bot_speaking = False  # the interruption that comes with a turn start stops him

    async def _handle_bot_started_speaking(self, frame):
        await super()._handle_bot_started_speaking(frame)
        self.barge.bot_speaking = True

    async def _handle_bot_stopped_speaking(self, frame):
        await super()._handle_bot_stopped_speaking(frame)
        self.barge.bot_speaking = False
        self._bot_stopped_at = self.barge.now()

    def _in_echo_window(self) -> bool:
        return self._bot_speaking or (self._bot_stopped_at is not None and self.barge.now() - self._bot_stopped_at <= self.barge.grace_secs)

    async def _handle_transcription(self, frame: TranscriptionFrame | InterimTranscriptionFrame):
        b = self.barge
        text = frame.text or ""
        if b.ptt_enabled and not b.ptt_pressed and self._bot_speaking:
            # hold-to-talk: the mic is closed unless the button is held, so speech that still arrives while he talks is not a deliberate interruption
            b.stats["ptt_voice_ignored"] += 1
            await self.trigger_reset_aggregation()
            return
        if self._in_echo_window() and b.echo_overlap > 0 and is_echo(text, b.spoken.recent(), b.echo_overlap):
            b.stats["echo_dropped"] += 1
            logger.info(f"ignored an echo of Brian's own voice ({len(tokens(text))} words)")
            if b.on_echo:
                b.on_echo(text)
            await self.trigger_reset_aggregation()
            return
        min_words = 1 if b.ptt_pressed else (self._min_words if self._bot_speaking else 1)
        if len(text.split()) >= min_words:
            await self.report_user_turn_started()
        else:
            await self.trigger_reset_aggregation()


class _ForcedEnd:
    """Mixin for a stop strategy: `force_end()` (hold-to-talk released) ends the turn now instead of waiting for silence detection."""

    _released = False

    def clear_release(self) -> None:
        self._released = False


class PttAwareStop(_ForcedEnd, HesitationAwareStop):
    """Smart Turn + hesitation hold (HesitationAwareStop), plus: when the person lets go of the talk button the turn is complete.
    The turn ends as soon as there is a transcript: at once if one is already in, otherwise on the next one (no Smart Turn, no silence wait)."""

    async def force_end(self) -> None:
        self._released = True
        self._turn_complete = True
        if self._hold_task:  # an unfinished-sentence hold does not apply to a button release
            await self.task_manager.cancel_task(self._hold_task)
            self._hold_task = None
        if self._text:
            self._transcript_finalized = True
            if self._timeout_task:
                await self.task_manager.cancel_task(self._timeout_task)
                self._timeout_task = None
            await self.report_user_turn_stopped()

    async def _handle_transcription(self, frame):
        if self._released:
            self._turn_complete = True
            self._text = frame.text
            self._transcript_finalized = True
            if self._timeout_task:
                await self.task_manager.cancel_task(self._timeout_task)
                self._timeout_task = None
            await self.report_user_turn_stopped()
            return
        await super()._handle_transcription(frame)

    async def handle_user_turn_stopped(self):
        self._released = False
        await super().handle_user_turn_stopped()


class PttAwareTimeout(_ForcedEnd, SpeechTimeoutUserTurnStopStrategy):
    """The optional "also wait this long after the last word" strategy (VOICE_TURN_HOLD_SECS / the phone default): a button release satisfies it too."""

    async def force_end(self) -> None:
        self._released = True
        await self.report_user_turn_stopped()
