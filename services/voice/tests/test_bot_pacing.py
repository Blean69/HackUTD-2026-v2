"""bot.py wiring that shapes how a turn sounds: the spoken-turn cap, turn-taking strategies and the one-filler-per-turn rule."""
import random
import re

from pipecat.frames.frames import LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame
from pipecat.tests.utils import run_test
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy, TurnAnalyzerUserTurnStopStrategy

import bot
import config
import prompts


def tokens(text: str) -> list[LLMTextFrame]:
    return [LLMTextFrame(t) for t in re.findall(r"\s*\S+", text)]


def spoken(down) -> str:
    return "".join(f.text for f in down if isinstance(f, LLMTextFrame))


async def test_a_rambling_reply_is_cut_at_a_sentence_end_before_the_voice():
    reply = "Right now your cash cushion is solid, which is great news for the whole family this month. You also have savings. The forecast never dips below zero. Anything else?"
    down, _ = await run_test(
        bot.LLMTap(max_words=12),
        frames_to_send=[LLMFullResponseStartFrame(), *tokens(reply), LLMFullResponseEndFrame()],
    )
    out = spoken(down)
    assert out.strip().endswith("this month.") and "savings" not in out
    assert any(isinstance(f, LLMFullResponseEndFrame) for f in down)  # the voice still gets its end-of-reply signal


async def test_a_short_reply_goes_through_untouched_and_the_cap_resets_each_reply():
    reply = "Pretty good, honestly. You've got a little over three months set aside."
    tap = bot.LLMTap(max_words=45)
    down, _ = await run_test(tap, frames_to_send=[LLMFullResponseStartFrame(), *tokens(reply), LLMFullResponseEndFrame(), LLMFullResponseStartFrame(), *tokens("Sure. Okay. Right. Done."), LLMFullResponseEndFrame()])
    out = spoken(down)
    assert out.startswith(reply) and "Sure. Okay. Right." in out and "Done" not in out  # reply 2 is capped at three sentences, reply 1 was not
    assert tap.spoke


def test_turn_taking_uses_smart_turn_and_an_optional_hold():
    s = config.Settings()
    stops = bot._stop_strategies(s)
    assert len(stops) == 1 and isinstance(stops[0], TurnAnalyzerUserTurnStopStrategy)
    assert stops[0]._turn_analyzer.params.stop_secs == 2.0 and s.vad_stop_secs == 0.2 and s.barge_in_words == 2
    held = bot._stop_strategies(s.with_overrides(turn_hold_secs=0.5))
    assert isinstance(held[0], TurnAnalyzerUserTurnStopStrategy) and isinstance(held[1], SpeechTimeoutUserTurnStopStrategy)
    plain = bot._stop_strategies(s.with_overrides(smart_turn=False))
    assert len(plain) == 1 and isinstance(plain[0], SpeechTimeoutUserTurnStopStrategy)


def test_hard_output_cap_defaults():
    s = config.Settings()
    assert s.llm_max_tokens <= 90 and s.turn_cap_words <= 50


def test_filler_choice_for_a_call_never_repeats():
    pick = prompts.FillerPicker(random.Random(3))
    seq = [pick.next() for _ in range(50)]
    assert all(a != b for a, b in zip(seq, seq[1:]))
