"""The scripted client's recording path: the bot's WebRTC track arrives as interleaved stereo, and a WAV made by treating that as mono
plays at half speed an octave low."""
import importlib.util
import wave
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("aiortc")
from av import AudioFrame  # noqa: E402

_spec = importlib.util.spec_from_file_location("webrtc_client_tool", Path(__file__).resolve().parents[1] / "tools" / "webrtc_client.py")
client = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(client)

RATE = 48000


def _tone(n: int, hz: float = 440.0) -> np.ndarray:
    t = np.arange(n) / RATE
    return (np.sin(2 * np.pi * hz * t) * 8000).astype(np.int16)


def _packed_stereo_frame(mono: np.ndarray) -> AudioFrame:
    inter = np.repeat(mono, 2).reshape(1, -1)  # L R L R ...
    f = AudioFrame.from_ndarray(inter, format="s16", layout="stereo")
    f.sample_rate = RATE
    return f


def test_packed_stereo_frame_is_deinterleaved_not_doubled():
    mono = _tone(960)
    out = client.frame_to_mono(_packed_stereo_frame(mono))
    assert out.shape == (960,), "a 20 ms stereo frame must give 960 mono samples, not 1920"
    assert np.array_equal(out, mono)


def test_planar_stereo_and_mono_frames():
    mono = _tone(960)
    planar = AudioFrame.from_ndarray(np.stack([mono, mono]), format="s16p", layout="stereo")
    assert np.array_equal(client.frame_to_mono(planar), mono)
    one = AudioFrame.from_ndarray(mono.reshape(1, -1), format="s16", layout="mono")
    assert np.array_equal(client.frame_to_mono(one), mono)


def test_different_channels_are_averaged():
    left, right = np.full(8, 1000, dtype=np.int16), np.full(8, 3000, dtype=np.int16)
    out = client.downmix(np.stack([left, right], axis=1).reshape(1, -1), channels=2, planar=False)
    assert np.all(out == 2000)


def test_recorded_clip_lasts_as_long_as_the_audio_played(tmp_path):
    """50 frames x 20 ms = 1 s of stereo audio must be a 1.0 s mono WAV at the frame's own sample rate, with the pitch unchanged."""
    frames = [_packed_stereo_frame(_tone(960)) for _ in range(50)]
    pcm = np.concatenate([client.frame_to_mono(f) for f in frames])
    path = tmp_path / "bot.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(frames[0].sample_rate); w.writeframes(pcm.tobytes())
    with wave.open(str(path), "rb") as w:
        assert w.getnframes() / w.getframerate() == pytest.approx(1.0, abs=0.001)
        back = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    # 440 Hz tone: count positive-going zero crossings in 1 s ~ 440 (an octave low would give ~220)
    crossings = int(np.sum((back[:-1] < 0) & (back[1:] >= 0)))
    assert 420 <= crossings <= 460
