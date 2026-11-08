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


async def test_five_digit_pin_submits_on_the_fifth_digit_not_the_fourth():
    gate, pins = make_gate([], [], pin_length=5)
    await run_test(gate, frames_to_send=[*keys("1234")], expected_down_frames=[])
    assert pins == [] and gate.locked is True  # four digits of a five-digit PIN are not an attempt
    unlocked = []
    gate, pins = make_gate([PinOutcome(ok=True, info={"household_id": "hh_rivera"})], unlocked, pin_length=5)
    await run_test(gate, frames_to_send=[*keys("12345")], expected_down_frames=[])
    assert pins == ["12345"] and unlocked == [{"household_id": "hh_rivera"}] and gate.locked is False


async def test_mixed_length_pins_accept_the_longest_and_hash_submits_a_shorter_one():
    gate, pins = make_gate([PinOutcome(ok=True, info={})], [], pin_length=5)
    await run_test(gate, frames_to_send=[*keys("1234#")], expected_down_frames=[])
    assert pins == ["1234"]  # '#' sends what was keyed, whatever its length


def test_pin_length_follows_the_configured_pins(monkeypatch):
    import config
    import prompts

    assert config.pin_lengths("12345:hh_rivera,56789:hh_nguyen:mem_x") == [5, 5]
    assert config.pin_lengths("123:hh,12345678901:hh,abcd:hh,1234") == []  # too short / too long / not digits / no household
    assert config.derive_pin_length("", "12345:hh_rivera,56789:hh_nguyen") == (5, False)
    assert config.derive_pin_length("", "1234:hh_a,56789:hh_b") == (5, True)  # differ: longest, '#' for the short one
    assert config.derive_pin_length("", "1234:hh_a, 5678:hh_b") == (4, False)
    assert config.derive_pin_length("6", "12345:hh_a") == (6, False)  # explicit PHONE_PIN_LENGTH wins
    assert config.derive_pin_length("", "") == (4, False) and config.derive_pin_length("x", "") == (4, False)
    for k in ("PHONE_PIN_LENGTH", "PHONE_PINS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("PHONE_PINS", "24680:hh_rivera,13579:hh_nguyen")
    s = config.load_settings()
    assert s.pin_length == 5 and s.pin_variable is False
    assert "five digit PIN" in prompts.disclosure_phone(s.pin_length, s.pin_variable)
    assert "then press pound" in prompts.disclosure_phone(5, True) and "four digit PIN" in prompts.disclosure_phone()
    assert prompts.disclosure_phone().startswith("Hi, I'm Brian, your personal finance assistant. Just so you know, I'm an AI") and prompts.disclosure_phone() == prompts.DISCLOSURE_PHONE
    monkeypatch.setenv("PHONE_PIN_LENGTH", "4")
    assert config.load_settings().pin_length == 4


async def test_only_the_digit_count_is_logged():
    from loguru import logger

    lines = []
    sink = logger.add(lambda m: lines.append(str(m)), level="INFO")
    try:
        gate, _ = make_gate([PinOutcome(ok=False, tries_left=2)], [], pin_length=5)
        await run_test(gate, frames_to_send=[*keys("24680")], expected_down_frames=[TTSSpeakFrame])
    finally:
        logger.remove(sink)
    text = "".join(lines)
    assert "5 digits keyed" in text and "24680" not in text
