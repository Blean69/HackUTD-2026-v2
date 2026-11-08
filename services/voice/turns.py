"""Turn-taking helpers: do not end the caller's turn on a hesitation.

Smart Turn v3 judges the SOUND of a pause. A rambling caller ("so if we, uh... bought a car, and, um...") produced pauses it called
complete, which split one question into four turns that each interrupted the previous LLM call. The transcript tells what the sound cannot:
a turn whose last words are a filler ("uh", "um", "so", "like") or a dangling connective ("and", "the", "because") is not finished.
HesitationAwareStop keeps Smart Turn as the judge but, when the last words look unfinished, waits `hesitation_hold_secs` more for the caller
to carry on; new speech cancels the wait. A normal finished sentence is not delayed at all."""
from __future__ import annotations

import asyncio
import re

from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import TurnAnalyzerUserTurnStopStrategy

# words a finished question does not end on
UNFINISHED_WORDS = frozenset(
    "uh uhh um umm er err erm ah hmm hm mm mmm so like and but or because cause then if the a an my our your their i we well maybe basically actually "
    "kind sort you-know i-mean".split()
)
_TRAILING = re.compile(r"[\s\.…]*$")
_WORD = re.compile(r"[a-z']+")


def ends_with_hesitation(text: str) -> bool:
    """True when the transcript trails off: ends in a filler or dangling word, a comma, a dash or an ellipsis."""
    t = (text or "").strip().lower()
    if not t:
        return False
    if t.endswith((",", "-", "—", "…", "...", ";", ":")):
        return True
    words = _WORD.findall(t)
    if not words:
        return False
    if words[-1] in UNFINISHED_WORDS:
        return True
    return len(words) >= 2 and f"{words[-2]}-{words[-1]}" in UNFINISHED_WORDS


class HesitationAwareStop(TurnAnalyzerUserTurnStopStrategy):
    def __init__(self, *, hesitation_hold_secs: float = 1.5, **kwargs):
        super().__init__(**kwargs)
        self.hesitation_hold_secs = hesitation_hold_secs
        self._hold_task: asyncio.Task | None = None
        self._held = False

    async def _discard_pending_end_of_turn(self):
        self._held = False
        if self._hold_task:
            await self.task_manager.cancel_task(self._hold_task)
            self._hold_task = None
        await super()._discard_pending_end_of_turn()

    async def _maybe_report_user_turn_stopped(self):
        if self.hesitation_hold_secs > 0 and self._turn_complete and self._text and not self._held and ends_with_hesitation(self._text):
            if self._hold_task is None:
                self._hold_task = self.task_manager.create_task(self._hold(), f"{self}::_hesitation_hold")
            return
        await super()._maybe_report_user_turn_stopped()

    async def _hold(self):
        try:
            await asyncio.sleep(self.hesitation_hold_secs)
        except asyncio.CancelledError:
            return
        self._hold_task = None
        self._held = True
        await TurnAnalyzerUserTurnStopStrategy._maybe_report_user_turn_stopped(self)
