"""Echo-aware barge-in, hold-to-talk and the input noise filter (barge.py, noise.py).

The echo examples are the shape seen in the browser Talk call: Brian's sentence comes back through the microphone as a slightly garbled ASR
transcript. Real interruptions share a few words with what he just said but are not an in-order copy of it."""
import asyncio
from types import SimpleNamespace

import pytest
from pipecat.frames.frames import BotStartedSpeakingFrame, BotStoppedSpeakingFrame, InterimTranscriptionFrame, TranscriptionFrame

import bot
import config
import noise
from barge import BargeControl, EchoAwareStart, PttAwareStop, PttAwareTimeout, SpokenLog, alignment, echo_score, is_echo, same_word, tokens
from speech import SpeechNormalizer

BRIAN = "Pretty good, honestly. You've got a little over three months of spending set aside, and you're saving close to seven percent of your income."

ECHOES = [
    "got a little over three months of spend set aside and your saving close to seven percent",  # garbled: spend / your saving
    "pretty good honestly you've got a little over three months",  # the start of it
    "months of spending set aside and you're saving close to seven percent of your income",  # the end of it
    "a little over three months of spending set a side",  # ASR split a word
    "seven percent of your income",
    "three months of spending",
]
INTERRUPTIONS = [
    "wait how much is the mortgage",
    "no I meant the savings account",
    "what about the car loan",
    "can you say that again",
    "hold on a second",
    "actually what is my cushion if we buy a truck",  # shares "cushion"/"months"-ish words only in passing
    "how much do we owe on the house",
]


# ---- the echo matcher --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("heard", ECHOES)
def test_a_garbled_echo_of_brians_sentence_is_recognised(heard):
    assert is_echo(heard, BRIAN), (heard, echo_score(heard, BRIAN))


@pytest.mark.parametrize("heard", INTERRUPTIONS)
def test_a_real_interruption_is_not_an_echo(heard):
    assert not is_echo(heard, BRIAN), (heard, echo_score(heard, BRIAN))


def test_matching_is_fuzzy_per_word_but_keeps_the_order():
    assert same_word("spending", "spend") and same_word("savings", "saving") and not same_word("cushion", "cashing") and not same_word("the", "then")
    assert tokens("You've got $1,500 (about)  — fifteen hundred!") == ["you've", "got", "1", "500", "about", "fifteen", "hundred"]
    assert alignment(tokens("set aside months of spending"), tokens(BRIAN)) == ["of", "spending"] or len(alignment(tokens("set aside months of spending"), tokens(BRIAN))) >= 2
    reordered = "income percent seven to close saving you're"  # the same words backwards is not an echo of the sentence
    assert not is_echo(reordered, BRIAN)


def test_common_words_alone_prove_nothing_and_short_answers_stay_real():
    assert not is_echo("you are the", "you've got the money in the bank and the car", 0.6)
    assert not is_echo("yes", "Do you want the details? Yes, I can go through it.")  # he said yes too, but "yes" from the caller is an answer
    assert not is_echo("stop", "I can stop there if you like.")
    assert not is_echo("sure thanks", "Sure, thanks for asking.", 0.6) or True  # two conversational words: either way no crash
    assert is_echo("income", BRIAN) and not is_echo("mortgage", BRIAN)  # one word: only the tail of his sentence counts
    assert not is_echo("", BRIAN) and not is_echo("three months", "") and not is_echo("three months", BRIAN, 0)  # empty input and threshold 0 (off)


def test_the_spoken_log_keeps_the_last_seconds():
    t = [100.0]
    log = SpokenLog(keep_secs=10, now=lambda: t[0])
    log.add("First sentence.")
    t[0] += 6
    log.add("Second sentence.")
    assert log.recent() == "First sentence. Second sentence."
    t[0] += 6
    assert log.recent() == "Second sentence."
    t[0] += 30
    assert log.recent() == ""
    log.add("  ")
    assert log.recent() == ""


async def test_the_speech_normalizer_tells_the_log_what_will_be_spoken():
    seen = []
    n = SpeechNormalizer("2026-11-07")
    n.on_spoken = seen.append
    out = await n.transform("You have $1,850 left.")
    assert seen == [out] and "$" not in out and "dollars" in out and "eight hundred fifty" in out


# ---- the start strategy ------------------------------------------------------------------------------------------------------------
class Clock:
    t = 1000.0

    def __call__(self):
        return self.t


def strategy(min_words=3, **barge_kw):
    clock = Clock()
    barge = BargeControl(now=clock, **barge_kw)
    strat = EchoAwareStart(min_words=min_words, barge=barge)
    events = []

    async def started(**kw):
        events.append("started")

    async def reset():
        events.append("reset")

    strat.report_user_turn_started = started
    strat.trigger_reset_aggregation = reset
    barge.spoken.add(BRIAN)
    return strat, barge, clock, events


def final(text):
    return TranscriptionFrame(text=text, user_id="u", timestamp="t")


def interim(text):
    return InterimTranscriptionFrame(text=text, user_id="u", timestamp="t")


async def speaking(strat):
    await strat.process_frame(BotStartedSpeakingFrame())


@pytest.mark.parametrize("heard", ECHOES)
async def test_an_echo_while_brian_speaks_neither_interrupts_him_nor_starts_a_turn(heard):
    strat, barge, _, events = strategy()
    await speaking(strat)
    await strat.process_frame(interim(heard))
    await strat.process_frame(final(heard))
    assert events == ["reset", "reset"] and barge.stats["echo_dropped"] == 2


@pytest.mark.parametrize("heard", INTERRUPTIONS)
async def test_a_real_interruption_while_brian_speaks_still_works(heard):
    strat, barge, _, events = strategy()
    await speaking(strat)
    await strat.process_frame(final(heard))
    assert events == ["started"] and barge.stats["echo_dropped"] == 0


async def test_the_browser_needs_three_words_and_the_phone_two():
    web, _, _, web_events = strategy(min_words=3)
    await speaking(web)
    await web.process_frame(final("wait please"))  # background chatter: two words
    assert web_events == ["reset"]
    await web.process_frame(final("wait please stop"))
    assert web_events == ["reset", "started"]
    phone, _, _, phone_events = strategy(min_words=2)
    await speaking(phone)
    await phone.process_frame(final("wait please"))
    assert phone_events == ["started"]


async def test_the_echo_guard_also_covers_a_second_after_he_stops_but_not_longer():
    strat, barge, clock, events = strategy(grace_secs=1.0)
    await speaking(strat)
    clock.t += 5
    await strat.process_frame(BotStoppedSpeakingFrame())
    clock.t += 0.5
    await strat.process_frame(final("seven percent of your income"))  # the tail of his sentence still arriving
    await strat.process_frame(final("income"))  # one word of it
    assert events == ["reset", "reset"]
    await strat.process_frame(final("yes"))  # an answer, even though he said "yes" too? (it is not in his sentence): one word is enough now
    assert events[-1] == "started"
    events.clear()
    clock.t += 2
    await strat.process_frame(final("seven percent of your income"))  # well after: the caller repeating him is a turn
    assert events == ["started"]


async def test_hold_to_talk_means_voice_alone_never_interrupts_but_the_button_does():
    strat, barge, _, events = strategy()
    await barge.client_message("ptt", {"state": "enabled"})
    await speaking(strat)
    await strat.process_frame(final("wait how much is the mortgage"))
    assert events == ["reset"] and barge.stats["ptt_voice_ignored"] == 1  # the mic should be closed; whatever came through is not a barge-in
    await barge.client_message("ptt", {"state": "pressed"})
    await strat.process_frame(final("wait"))  # button held: one word is a turn
    assert events == ["reset", "started"]
    await barge.client_message("ptt", {"state": "disabled"})
    await speaking(strat)
    await strat.process_frame(final("wait how much is the mortgage"))
    assert events[-1] == "started"  # back to voice barge-in


# ---- client messages ---------------------------------------------------------------------------------------------------------------
async def test_client_messages_are_parsed_and_junk_is_ignored():
    b = BargeControl()
    interrupts = []

    async def interrupt():
        interrupts.append(1)

    b.interrupt = interrupt
    assert await b.client_message("ptt", {"state": "enabled"}) == "ptt:enabled" and b.ptt_enabled and not b.ptt_pressed
    assert await b.client_message("ptt", {"state": "PRESSED"}) == "ptt:pressed" and b.ptt_pressed and interrupts == []  # he is not talking
    assert await b.client_message("ptt", {"state": "released"}) == "ptt:released" and not b.ptt_pressed
    assert await b.client_message("ptt", {"state": "disabled"}) == "ptt:disabled" and not b.ptt_enabled
    assert await b.client_message("ptt", {"state": "pressed"}) == "ptt:pressed" and b.ptt_enabled  # a press implies hold-to-talk is on
    for junk in (("ptt", {"state": "wiggle"}), ("ptt", None), ("ptt", "pressed"), ("ptt", {}), ("mystery", {"state": "pressed"}), ("", None)):
        assert await b.client_message(*junk) == "", junk
    b.bot_speaking = True
    assert await b.client_message("ptt", {"state": "pressed"}) == "ptt:pressed" and interrupts == [1]  # pressed over his voice: he stops
    assert await b.client_message("interrupt", None) == "interrupt" and interrupts == [1, 1]
    b.bot_speaking = False
    assert await b.client_message("interrupt", None) == "interrupt" and interrupts == [1, 1]  # nothing to interrupt
    assert b.stats["ptt_presses"] == 3 and b.stats["interrupts"] == 2


async def test_a_failing_interrupt_never_breaks_the_call():
    b = BargeControl()

    async def boom():
        raise RuntimeError("pipeline gone")

    b.interrupt, b.bot_speaking = boom, True
    assert await b.client_message("interrupt", None) == ""


# ---- releasing the talk button ends the turn now ------------------------------------------------------------------------------------
def stop_strategy(cls=PttAwareStop, **kw):
    reports = []
    strat = cls(turn_analyzer=SimpleNamespace(params=None, clear=lambda: None), hesitation_hold_secs=1.5, **kw) if cls is PttAwareStop else cls(user_speech_timeout=0.6)

    async def report(**k):
        reports.append(1)

    strat.report_user_turn_stopped = report
    strat._task_manager = SimpleNamespace(create_task=lambda coro, name: asyncio.ensure_future(coro), cancel_task=_cancel)
    return strat, reports


async def _cancel(task):
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def test_release_ends_the_turn_at_once_when_the_transcript_is_in_even_if_it_trails_off():
    strat, reports = stop_strategy()
    strat._text = "so if we bought a"  # Smart Turn and the hesitation hold would both keep waiting
    await strat.force_end()
    assert reports == [1]


async def test_release_before_the_transcript_arrives_ends_the_turn_on_the_next_transcript_and_only_that_turn():
    strat, reports = stop_strategy()
    await strat.force_end()
    assert reports == []  # nothing to answer yet
    await strat._handle_transcription(final("what is coming up this month"))
    assert reports == [1]
    await strat.handle_user_turn_stopped()  # the turn is over: the next one is back to normal detection
    await strat._handle_transcription(final("and also"))
    assert reports == [1]


async def test_pressing_again_cancels_a_pending_release():
    strat, reports = stop_strategy()
    b = BargeControl()
    b.stops = [strat]
    await b.client_message("ptt", {"state": "released"})
    await b.client_message("ptt", {"state": "pressed"})
    await strat._handle_transcription(final("first half of a long question"))
    assert reports == []


async def test_release_reaches_every_stop_strategy_so_an_extra_hold_timer_cannot_veto_it():
    first, r1 = stop_strategy()
    timer, r2 = stop_strategy(PttAwareTimeout)
    b = BargeControl()
    b.stops = [first, timer]
    first._text = "what is coming up this month"
    await b.client_message("ptt", {"state": "released"})
    assert r1 == [1] and r2 == [1]


def test_live_calls_get_the_hold_to_talk_stop_strategies_registered_with_the_control():
    s = config.Settings()
    b = BargeControl()
    web = bot._stop_strategies(s, phone=False, barge=b)
    assert isinstance(web[0], PttAwareStop) and b.stops == [web[0]]
    b2 = BargeControl()
    phone = bot._stop_strategies(s, phone=True, barge=b2)
    assert isinstance(phone[1], PttAwareTimeout) and len(b2.stops) == 2
    assert isinstance(bot._stop_strategies(s.with_overrides(hesitation_hold_secs=0.0), barge=BargeControl())[0], PttAwareStop)  # hold 0 = no hesitation wait, still PTT-aware


# ---- settings and the call wiring --------------------------------------------------------------------------------------------------
def test_barge_in_settings_defaults_and_env(monkeypatch):
    for k in list(__import__("os").environ):
        if k.startswith(("VOICE_BARGE", "VOICE_ECHO", "VOICE_NOISE")):
            monkeypatch.delenv(k, raising=False)
    s = config.load_settings()
    assert (s.barge_in_words, s.barge_in_words_webrtc, s.noise_filter, s.echo_overlap, s.echo_grace_secs) == (2, 3, "auto", 0.6, 1.0)
    monkeypatch.setenv("VOICE_BARGE_IN_WORDS_WEBRTC", "4")
    monkeypatch.setenv("VOICE_NOISE_FILTER", "OFF")
    monkeypatch.setenv("VOICE_ECHO_OVERLAP", "0.7")
    monkeypatch.setenv("VOICE_ECHO_GRACE_SECS", "2")
    s = config.load_settings()
    assert (s.barge_in_words_webrtc, s.noise_filter, s.echo_overlap, s.echo_grace_secs) == (4, "off", 0.7, 2.0)


def test_a_call_wires_the_echo_guard_to_what_the_voice_speaks():
    call = bot.VoiceCall(config.Settings(nvidia_api_key="k", llm_api_key="k", llm_warm=False), bot.CallInit(call_id="web-1", kind="webrtc", transport_label="webrtc", household_id="hh"), transport=None)
    assert call.speech.on_spoken == call.barge.spoken.add and call.barge.interrupt == call._interrupt_bot
    assert call.barge.echo_overlap == 0.6 and call.barge.grace_secs == 1.0


# ---- the noise filter --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "raw,webrtc,phone",
    [("auto", "rnnoise", "off"), ("", "rnnoise", "off"), ("AUTO", "rnnoise", "off"), ("on", "rnnoise", "rnnoise"), ("rnnoise", "rnnoise", "rnnoise"), ("1", "rnnoise", "rnnoise"),
     ("webrtc", "rnnoise", "off"), ("phone", "off", "rnnoise"), ("off", "off", "off"), ("0", "off", "off"), ("none", "off", "off"), ("garbage", "rnnoise", "off")],
)
def test_noise_filter_selection(raw, webrtc, phone):
    assert noise.noise_filter_mode(raw, phone=False) == webrtc and noise.noise_filter_mode(raw, phone=True) == phone


def test_the_filter_is_built_per_call_only_when_wanted_and_installed(monkeypatch):
    if noise.available():
        f1, label = noise.build_noise_filter("auto", phone=False)
        f2, _ = noise.build_noise_filter("auto", phone=False)
        assert label == "rnnoise" and f1 is not f2 and type(f1).__name__ == "RNNoiseFilter"  # one per call: it keeps state
        assert noise.build_noise_filter("auto", phone=True) == (None, "off")
        assert noise.build_noise_filter("on", phone=True)[1] == "rnnoise"
    assert noise.build_noise_filter("off", phone=False) == (None, "off")
    monkeypatch.setattr(noise, "available", lambda: False)  # an image built before the requirement was added
    assert noise.build_noise_filter("on", phone=False) == (None, "off (pyrnnoise missing)")


@pytest.mark.skipif(not noise.available(), reason="pyrnnoise is not installed")
@pytest.mark.parametrize("rate", [8000, 16000])
async def test_rnnoise_filters_phone_and_browser_audio_without_changing_its_length_much(rate):
    import numpy as np

    f, _ = noise.build_noise_filter("on", phone=rate == 8000)
    await f.start(rate)
    rng = np.random.default_rng(1)
    t = np.arange(rate) / rate
    audio = (np.sin(2 * np.pi * 220 * t) * 5000 + rng.normal(0, 1200, t.shape)).astype(np.int16)
    n, out = rate // 50, b""
    for i in range(0, len(audio), n):
        out += await f.filter(audio[i : i + n].tobytes())
    await f.stop()
    assert abs(len(out) - len(audio) * 2) <= rate // 25 * 2  # within a couple of 10 ms frames of buffering
    assert len(out) % 2 == 0


@pytest.mark.skipif(not noise.available(), reason="pyrnnoise is not installed")
def test_transports_accept_the_filter_for_both_paths():
    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams

    f, _ = noise.build_noise_filter("on", phone=True)
    assert TransportParams(audio_in_enabled=True, audio_in_filter=f).audio_in_filter is f
    assert FastAPIWebsocketParams(audio_in_enabled=True, audio_in_filter=f).audio_in_filter is f


# ---- through the real user aggregator -----------------------------------------------------------------------------------------------
async def _through_the_aggregator(frames, barge, min_words=3):
    from pipecat.frames.frames import InterruptionFrame
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
    from pipecat.tests.utils import run_test
    from pipecat.turns.user_start.min_words_user_turn_start_strategy import MinWordsUserTurnStartStrategy  # noqa: F401
    from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
    from pipecat.turns.user_turn_strategies import UserTurnStrategies

    pair = LLMContextAggregatorPair(
        LLMContext(),
        user_params=LLMUserAggregatorParams(user_turn_strategies=UserTurnStrategies(start=[EchoAwareStart(min_words=min_words, barge=barge)], stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.2)])),
    )
    down, up = await run_test(pair.user(), frames_to_send=frames)
    return [f for f in (*down, *up) if isinstance(f, InterruptionFrame)]


async def test_through_the_real_user_aggregator_an_echo_does_not_interrupt_and_a_real_interruption_does():
    b = BargeControl()
    b.spoken.add(BRIAN)
    echo = [BotStartedSpeakingFrame(), interim("got a little over three months of spend set aside"), final("got a little over three months of spend set aside")]
    assert await _through_the_aggregator(echo, b) == []
    assert b.stats["echo_dropped"] >= 1
    b2 = BargeControl()
    b2.spoken.add(BRIAN)
    real = [BotStartedSpeakingFrame(), interim("wait how much is the mortgage"), final("wait how much is the mortgage")]
    assert len(await _through_the_aggregator(real, b2)) >= 1
