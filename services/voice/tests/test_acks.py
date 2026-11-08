"""Pre-rendered acknowledgements: rendered once per voice, never repeated back to back, never on top of other speech, never delaying the answer."""
import asyncio
import random

import acks
import bot
from acks import AckPicker, Clip
from config import Settings
from pipecat.frames.frames import TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.tests.utils import run_test
from tts import TTSChoice

PCM = b"\x01\x00" * 4800  # 0.2 s at 24 kHz
CLIPS = [Clip("Mm-hm.", PCM, 24000), Clip("Got it.", PCM, 24000), Clip("Okay.", PCM * 2, 24000)]


def test_picker_never_repeats_back_to_back():
    p = AckPicker(random.Random(5))
    seq = [p.pick(CLIPS).text for _ in range(60)]
    assert all(a != b for a, b in zip(seq, seq[1:])) and len(set(seq)) == 3
    assert AckPicker().pick([]) is None
    assert AckPicker().pick(CLIPS[:1]).text == "Mm-hm."  # a bank of one still works


async def test_player_passes_everything_else_through_untouched():
    from pipecat.frames.frames import LLMTextFrame

    audio = TTSAudioRawFrame(audio=PCM, sample_rate=24000, num_channels=1)
    down, _ = await run_test(bot.AckPlayer(), frames_to_send=[TTSStartedFrame(), audio, LLMTextFrame("x"), TTSStoppedFrame()])
    assert [type(f) for f in down] == [TTSStartedFrame, TTSAudioRawFrame, LLMTextFrame, TTSStoppedFrame]  # the voice reaches the caller


async def test_real_speech_is_reported_but_an_acknowledgement_is_not():
    heard = []
    player = bot.AckPlayer(on_speech=lambda: heard.append(1))
    frames = []

    async def grab(frame, direction=None):
        frames.append(frame)

    player.push_frame = grab
    await player.play(Clip("Okay.", PCM, 24000))  # context ack-1: not the answer
    assert heard == []
    await run_test(bot.AckPlayer(on_speech=lambda: heard.append(1)), frames_to_send=[TTSAudioRawFrame(audio=PCM, sample_rate=24000, num_channels=1, context_id="reply-1")])
    assert heard == [1]


async def test_player_puts_the_clip_on_the_wire_between_start_and_stop():
    player = bot.AckPlayer()
    frames = []

    async def grab(frame, direction=None):
        frames.append(frame)

    player.push_frame = grab
    await player.play(Clip("Okay.", PCM * 2, 24000))  # 0.4 s -> two 200 ms frames
    assert isinstance(frames[0], TTSStartedFrame) and isinstance(frames[-1], TTSStoppedFrame)
    audio = [f for f in frames if isinstance(f, TTSAudioRawFrame)]
    assert len(audio) == 2 and all(f.sample_rate == 24000 and f.num_channels == 1 for f in audio) and sum(len(f.audio) for f in audio) == len(PCM) * 2


def make_call(**over):
    from bot import CallInit, VoiceCall

    call = VoiceCall(Settings(nvidia_api_key="k", llm_api_key="k", **over), CallInit(call_id="c1", kind="webrtc", transport_label="webrtc", household_id="hh"), transport=None)
    played = []

    async def play(clip):
        played.append(clip.text)

    call._ack.play = play
    call._ack_clips = list(CLIPS)
    return call, played


async def test_ack_plays_once_when_nothing_else_is_going_on_and_replaces_the_tool_filler(monkeypatch):
    monkeypatch.setattr(bot, "ACK_DELAY_SECS", 0.0)
    call, played = make_call()
    await call._maybe_ack()
    assert len(played) == 1 and call._filled is True and call._ack_until > 0 and call.stats["acks"] == 1  # _filled: the tool filler will not stack on it


async def test_ack_is_skipped_when_speech_is_already_on_the_way(monkeypatch):
    monkeypatch.setattr(bot, "ACK_DELAY_SECS", 0.0)
    for setup in (lambda c: setattr(c, "_bot_audible", True), lambda c: setattr(c._tap, "spoke", True), lambda c: setattr(c, "_filled", True), lambda c: setattr(c, "_ack_clips", [])):
        call, played = make_call()
        setup(call)
        await call._maybe_ack()
        assert played == []


async def test_the_watchdog_is_not_fooled_by_an_acknowledgement():
    import time

    call, _ = make_call()
    call._reply_watchdog = asyncio.create_task(asyncio.sleep(30))
    call._ack_until = time.monotonic() + 5  # the thing that just became audible is an ack
    call._on_bot_audible()
    assert not call._reply_watchdog.done() and call._bot_audible  # still watching: the real answer has not started
    call._ack_until = 0.0  # real speech
    call._on_bot_audible()
    assert call._reply_watchdog is None  # cancelled
    # and the answer's own audio (seen after the TTS) stands the watchdog down even while the ack's "bot speaking" state is still open
    call._ack_until = time.monotonic() + 5
    call._reply_watchdog = asyncio.create_task(asyncio.sleep(30))
    call._on_real_speech()
    assert call._reply_watchdog is None


async def test_clips_are_rendered_once_per_voice_and_cached(monkeypatch):
    calls = []

    async def fake_eleven(client, s, choice, line, gate):
        calls.append(line)
        return Clip(line, PCM, choice.sample_rate)

    monkeypatch.setattr(acks, "_render_eleven", fake_eleven)
    monkeypatch.setattr(acks, "_cache", {})
    s = Settings(elevenlabs_api_key="k")
    a = TTSChoice("elevenlabs", "eleven_v4_turbo", "voiceA", 24000)
    first = await acks.ensure_clips(s, a)
    second = await acks.ensure_clips(s, a)
    assert first is second and len(calls) == len(acks.ACK_LINES)  # rendered once
    await acks.ensure_clips(s, TTSChoice("elevenlabs", "eleven_v4_turbo", "voiceA", 8000))  # the phone rate is its own bank
    await acks.ensure_clips(s, TTSChoice("elevenlabs", "eleven_v4_turbo", "voiceB", 24000))  # and so is another voice
    assert len(calls) == 3 * len(acks.ACK_LINES) and acks.cached(a) == first
    assert not any(t.endswith("]") or "[" in t for t in acks.ACK_LINES)  # plain words: no audio tags that could be read out loud


async def test_a_failed_render_leaves_an_empty_bank_not_a_crash(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("down")

    monkeypatch.setattr(acks, "_render_eleven", boom)
    monkeypatch.setattr(acks, "_cache", {})
    assert await acks.ensure_clips(Settings(elevenlabs_api_key="k"), TTSChoice("elevenlabs", "m", "v", 24000)) == []
