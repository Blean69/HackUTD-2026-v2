"""DTMF PIN gate for the phone path. Until the PIN verifies, no caller audio reaches the ASR or the LLM and no household data is loaded.

Keypad digits arrive as InputDTMFFrame (TwilioFrameSerializer turns Twilio/SignalWire `dtmf` events into them). Four digits (or '#')
submit; '*' clears. Three wrong tries and the call ends."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from pipecat.frames.frames import EndTaskFrame, Frame, InputAudioRawFrame, InputDTMFFrame, TTSSpeakFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

import prompts


@dataclass
class PinOutcome:
    ok: bool
    tries_left: int = 0
    locked: bool = False
    unavailable: bool = False
    info: dict[str, Any] = field(default_factory=dict)


class PinGate(FrameProcessor):
    def __init__(
        self,
        *,
        verify: Callable[[str], Awaitable[PinOutcome]],
        on_unlocked: Callable[[dict[str, Any]], Awaitable[None]],
        on_locked: Callable[[str], Awaitable[None]] | None = None,
        pin_length: int = 4,
        max_tries: int = 3,
        **kwargs: Any,
    ):
        super().__init__(**kwargs)
        self._verify = verify
        self._on_unlocked = on_unlocked
        self._on_locked = on_locked
        self._pin_length = pin_length
        self._max_tries = max_tries
        self._digits = ""
        self._tries = 0
        self.locked = True
        self._finished = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if self.locked and direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, InputDTMFFrame):
                await self._digit(str(frame.button.value))
                return
            if isinstance(frame, InputAudioRawFrame):
                return  # nothing the caller says is heard before the PIN checks out
        await self.push_frame(frame, direction)

    async def _say(self, text: str) -> None:
        await self.push_frame(TTSSpeakFrame(text, append_to_context=False))

    async def _digit(self, d: str) -> None:
        if self._finished:
            return
        if d == "*":
            self._digits = ""
            return
        if d == "#":
            if self._digits:
                await self._submit()
            return
        if not d.isdigit():
            return
        self._digits += d
        if len(self._digits) >= self._pin_length:
            await self._submit()

    async def _submit(self) -> None:
        pin, self._digits = self._digits, ""
        self._tries += 1
        try:
            out = await self._verify(pin)
        except Exception as e:
            logger.warning(f"PIN check failed: {e}")
            out = PinOutcome(ok=False, unavailable=True, locked=True)
        if out.ok:
            self.locked = False
            self._finished = True
            await self._on_unlocked(out.info)
            return
        if out.unavailable:
            await self._end(prompts.PIN_UNAVAILABLE, "error: worker unreachable during PIN check")
        elif out.locked or self._tries >= self._max_tries or out.tries_left <= 0:
            await self._end(prompts.PIN_LOCKED, "pin_failed")
        else:
            await self._say(prompts.PIN_LAST_TRY if out.tries_left == 1 else prompts.PIN_RETRY)

    async def _end(self, line: str, reason: str) -> None:
        self._finished = True
        await self._say(line)
        if self._on_locked:
            await self._on_locked(reason)
        await self.push_frame(EndTaskFrame(), FrameDirection.UPSTREAM)
