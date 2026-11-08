"""Batches trace events (heard / said / notes) and POSTs them to the worker every 500 ms or on demand.
Events that happen before the run exists (the PIN gate) are held and sent once set_run() is called."""
from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Any

from loguru import logger

from worker_client import WorkerClient, WorkerError

MAX_PENDING = 200


class TraceReporter:
    def __init__(self, client: WorkerClient, flush_secs: float = 0.5):
        self._client = client
        self._flush_secs = flush_secs
        self._run_id: str | None = None
        self._pending: deque[dict[str, Any]] = deque(maxlen=MAX_PENDING)
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self.sent = 0

    @property
    def run_id(self) -> str | None:
        return self._run_id

    def set_run(self, run_id: str) -> None:
        self._run_id = run_id

    def add(self, kind: str, **fields: Any) -> None:
        self._pending.append({"kind": kind, **{k: v for k, v in fields.items() if v is not None}})

    # convenience
    def heard(self, text: str, asr_ms: float | None = None) -> None:
        self.add("heard", text=text, asr_ms=_ms(asr_ms), model="nemotron-asr-streaming", provider="nvidia")

    def said(self, text: str, *, model: str, asr_ms=None, llm_ms=None, tts_ms=None, v2v_ms=None, tokens_in=None, tokens_out=None, interrupted=False, voice="", tts_model=None, tts_provider=None) -> None:
        self.add("said", text=text, model=model, provider="nvidia", asr_ms=_ms(asr_ms), llm_ms=_ms(llm_ms), tts_ms=_ms(tts_ms), v2v_ms=_ms(v2v_ms), tokens_in=tokens_in, tokens_out=tokens_out, interrupted=interrupted or None, tts_voice=voice, tts_model=tts_model, tts_provider=tts_provider)

    def note(self, title: str, **data: Any) -> None:
        self.add("note", title=title, data=data or None)

    def error(self, title: str, **data: Any) -> None:
        self.add("error", title=title, data=data or None)

    async def flush(self) -> None:
        if not self._run_id or not self._pending:
            return
        async with self._lock:
            batch = [self._pending.popleft() for _ in range(min(len(self._pending), 50))]
            if not batch:
                return
            try:
                await self._client.trace(self._run_id, batch)
                self.sent += len(batch)
            except WorkerError as e:
                logger.warning(f"trace batch of {len(batch)} dropped: {e}")

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self._flush_secs)
            try:
                await self.flush()
            except Exception as e:  # never let tracing take a call down
                logger.warning(f"trace flush failed: {e}")

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="trace-reporter")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        for _ in range(5):  # drain what is left
            if not self._pending:
                break
            await self.flush()


def _ms(secs: float | None) -> int | None:
    """Metrics arrive in seconds; the worker wants milliseconds."""
    return None if secs is None else max(0, round(secs * 1000))


def now() -> float:
    return time.monotonic()
