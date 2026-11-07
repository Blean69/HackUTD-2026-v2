from pipecat.audio.dtmf.types import KeypadEntry
from pipecat.frames.frames import EndTaskFrame, InputAudioRawFrame, InputDTMFFrame, TextFrame, TTSSpeakFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import run_test

import prompts
from pin_gate import PinGate, PinOutcome


def keys(s: str):
    return [InputDTMFFrame(button=KeypadEntry(c)) for c in s]


def audio():
    return InputAudioRawFrame(audio=b"\x00" * 320, sample_rate=8000, num_channels=1)


def make_gate(results, unlocked, locked_reasons=None, pin_length=4):
    seq = iter(results)
    pins = []

    async def verify(pin):
        pins.append(pin)
        return next(seq)

    async def on_unlocked(info):
        unlocked.append(info)

    async def on_locked(reason):
        (locked_reasons if locked_reasons is not None else []).append(reason)

    return PinGate(verify=verify, on_unlocked=on_unlocked, on_locked=on_locked, pin_length=pin_length), pins


async def test_correct_pin_unlocks_and_nothing_is_heard_before():
    unlocked = []
    gate, pins = make_gate([PinOutcome(ok=True, info={"household_id": "hh_rivera"})], unlocked)
    # the first audio frame (before the PIN) is swallowed and the keypad digits never travel on; audio after unlocking passes
    await run_test(gate, frames_to_send=[audio(), *keys("1234"), audio(), TextFrame(text="after")], expected_down_frames=[InputAudioRawFrame, TextFrame])
    assert pins == ["1234"] and unlocked == [{"household_id": "hh_rivera"}]
    assert gate.locked is False


async def test_audio_is_dropped_while_locked_and_passes_after():
    gate, _ = make_gate([PinOutcome(ok=True, info={})], [])
    gate.locked = True
    down, _ = await run_test(gate, frames_to_send=[audio(), audio()], expected_down_frames=[])
    assert down == []


async def test_wrong_pin_speaks_a_retry_and_third_failure_hangs_up():
    reasons = []
    gate, pins = make_gate([PinOutcome(ok=False, tries_left=2), PinOutcome(ok=False, tries_left=1), PinOutcome(ok=False, tries_left=0, locked=True)], [], reasons)
    down, up = await run_test(gate, frames_to_send=[*keys("1111"), *keys("2222"), *keys("3333")], expected_down_frames=[TTSSpeakFrame, TTSSpeakFrame, TTSSpeakFrame], expected_up_frames=[EndTaskFrame])
    assert pins == ["1111", "2222", "3333"]
    assert [f.text for f in down] == [prompts.PIN_RETRY, prompts.PIN_LAST_TRY, prompts.PIN_LOCKED]
    assert reasons == ["pin_failed"] and gate.locked is True


async def test_hash_submits_early_star_clears_and_non_digits_are_ignored():
    gate, pins = make_gate([PinOutcome(ok=False, tries_left=2)], [], pin_length=6)
    await run_test(gate, frames_to_send=[*keys("12"), *keys("*"), *keys("90#"), *keys("#")], expected_down_frames=[TTSSpeakFrame])
    assert pins == ["90"]  # "*" cleared "12"; "#" sent "90"; the lone "#" did nothing


async def test_worker_down_during_pin_check_ends_politely():
    reasons = []

    async def verify(pin):
        raise RuntimeError("boom")

    async def nop(info):
        pass

    async def on_locked(r):
        reasons.append(r)

    gate = PinGate(verify=verify, on_unlocked=nop, on_locked=on_locked)
    down, up = await run_test(gate, frames_to_send=keys("1234"), expected_down_frames=[TTSSpeakFrame], expected_up_frames=[EndTaskFrame])
    assert down[0].text == prompts.PIN_UNAVAILABLE and reasons and reasons[0].startswith("error")
