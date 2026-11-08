"""Input noise suppression for the caller's audio, ahead of the VAD, the turn detector and the ASR.

Pipecat 1.15 ships RNNoise (`pipecat.audio.filters.rnnoise_filter.RNNoiseFilter`, a small recurrent network, via the `pyrnnoise` wheel, extra
`pipecat-ai[rnnoise]`; the old `NoisereduceFilter` is gone). It resamples to 48 kHz internally, so it works on both transports; measured here
at about 5 percent of one core per live call for either the browser's 16 kHz audio or the phone's 8 kHz audio, and about 10 ms of delay.

VOICE_NOISE_FILTER
  auto (default)   on for the browser Talk call (WebRTC), off on the phone line. Phone audio is already narrow-band and carrier-processed; turn the
                   filter on there (`on` or `phone`) only after listening to a test call.
  on | rnnoise     both transports
  webrtc | phone   only that transport
  off | 0          neither
If the library is missing (an image built before the requirement was added) the call simply runs without it, with one warning in the log."""
from __future__ import annotations

import importlib.util
from typing import Any

from loguru import logger

ON = {"on", "1", "true", "yes", "rnnoise", "all", "both"}
OFF = {"off", "0", "false", "no", "none", "disabled", ""}


def noise_filter_mode(raw: str, *, phone: bool) -> str:
    """"rnnoise" or "off" for this transport, from the VOICE_NOISE_FILTER value."""
    v = (raw or "auto").strip().lower()
    if v in OFF:
        return "off"
    if v in ON:
        return "rnnoise"
    if v == "webrtc":
        return "off" if phone else "rnnoise"
    if v == "phone":
        return "rnnoise" if phone else "off"
    return "off" if phone else "rnnoise"  # auto, and anything unrecognised


def available() -> bool:
    return importlib.util.find_spec("pyrnnoise") is not None


def build_noise_filter(raw: str, *, phone: bool) -> tuple[Any | None, str]:
    """(a fresh filter for ONE call or None, a label for logs/stats: "rnnoise" | "off" | "off (pyrnnoise missing)")."""
    if noise_filter_mode(raw, phone=phone) == "off":
        return None, "off"
    if not available():
        logger.warning("VOICE_NOISE_FILTER wants RNNoise but pyrnnoise is not installed (pip install 'pipecat-ai[rnnoise]'): running without the noise filter")
        return None, "off (pyrnnoise missing)"
    from pipecat.audio.filters.rnnoise_filter import RNNoiseFilter

    return RNNoiseFilter(), "rnnoise"
