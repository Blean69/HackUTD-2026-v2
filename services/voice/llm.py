"""The voice LLM: Nemotron through OpenAI-compatible endpoints, thinking off, with hedged requests and a provider failover chain.

Why this exists. NVIDIA's hosted endpoint sometimes parks ONE request for tens of seconds with no error (seen on a live call: a 38.6 s
first token, while the next request, after the tool result, took 0.2 s). Pipecat's own `retry_on_timeout` cannot help: it wraps only
`client.chat.completions.create()`, which returns as soon as the HTTP headers arrive, long before the first token. So the stall sat
inside the stream and nothing ever re-issued the request.

What happens now, per request (all times from the moment the request starts; defaults in config.py):

  0.0 s   request #1 to provider A (nvidia_lightning)
  1.5 s   VOICE_LLM_HEDGE_SECS  no first token yet: an identical request #2 to A. First one to yield a token wins, the other is cancelled
                                and its connection closed. Only the winner's chunks ever reach the pipeline, so there is no duplicate
                                audio and no duplicate tool call.
  4.0 s   VOICE_LLM_RETRY_SECS  still nothing: the next provider B (brev, then nvidia_nano) joins the race (A's requests keep running).
  8.0 s   VOICE_LLM_TIMEOUT_SECS hard cap: A's requests are dropped. A is "cooling" for VOICE_LLM_COOLDOWN_SECS and tried last, so a
                                dead endpoint costs one slow turn, not every turn.

An error (HTTP 4xx/5xx, connection refused) from every request of a provider moves on to the next provider at once. If every provider
fails the caller hears the apology line instead of silence. Every model in the chain is a Nemotron; the one that really answered is
reported (`served`, and the `said` trace event).

What counts as "answered" (VOICE_LLM_HEDGE_UNTIL, default `sentence`). The hosted endpoint also stalls AFTER the first token: on a local
run the first token came at 2.8 s and the first sentence reached the voice 6.7 s later (ElevenLabs "text aggregation time: 6.67 s"), because
the voice speaks nothing until it holds a whole sentence. So a request wins when its stream has delivered its first speakable unit: a
finished sentence, about 16 words, the end of the reply, or the end of a tool call (a tool runs only once its arguments are complete).
That costs nothing, since the voice waits for the same boundary, and it makes the hedge cover a mid-sentence stall as well as a first-token
one. `token` restores "first chunk with content". A bare role/usage chunk never counts either way. The pipeline's TTFB metric is still
stamped at the winner's real first token."""
from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Callable

from loguru import logger

from pipecat.frames.frames import TTSSpeakFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.nvidia.llm import NvidiaLLMService

import prompts
from config import Settings

KNOWN_PROVIDERS = ("nvidia_lightning", "brev", "nvidia_nano")


@dataclass(frozen=True)
class Provider:
    key: str  # nvidia_lightning | brev | nvidia_nano
    label: str  # the trace's provider badge: nvidia (hosted API) | brev (our GPU)
    base_url: str
    api_key: str
    model: str  # what is sent as `model` in the request
    shown: str = ""  # what the trace reports as the model (defaults to `model`)

    @property
    def display(self) -> str:
        return self.shown or self.model


class LLMUnavailable(RuntimeError):
    """Every provider in the chain failed or timed out before producing a token."""


def build_providers(s: Settings) -> tuple[list[Provider], list[str]]:
    """The usable chain in VOICE_LLM_PROVIDERS order, plus warnings for entries that were skipped (unknown name, brev not configured...)."""
    out: list[Provider] = []
    warnings: list[str] = []
    for key in s.llm_providers:
        if any(p.key == key for p in out):
            continue
        if key == "nvidia_lightning":
            out.append(Provider(key, "nvidia", s.llm_base_url, s.llm_api_key, s.llm_model))
        elif key == "brev":
            if not (s.brev_base_url and s.brev_model):
                warnings.append("VOICE_LLM_PROVIDERS lists brev but BREV_BASE_URL / BREV_NEMOTRON_MODEL are empty: skipped")
                continue
            out.append(Provider(key, "brev", s.brev_base_url, s.brev_api_key or "EMPTY", s.brev_model, s.brev_label))
        elif key == "nvidia_nano":
            api_key = s.nvidia_api_key or s.llm_api_key
            if not (api_key and s.nano_model):
                warnings.append("VOICE_LLM_PROVIDERS lists nvidia_nano but there is no NVIDIA key or VOICE_LLM_NANO_MODEL: skipped")
                continue
            out.append(Provider(key, "nvidia", s.nano_base_url, api_key, s.nano_model))
        else:
            warnings.append(f"VOICE_LLM_PROVIDERS: unknown provider {key!r} (use {', '.join(KNOWN_PROVIDERS)}): skipped")
    if not out:  # a half-configured env must never leave the call without a brain
        warnings.append("no usable LLM provider in VOICE_LLM_PROVIDERS; using nvidia_lightning")
        out.append(Provider("nvidia_lightning", "nvidia", s.llm_base_url, s.llm_api_key, s.llm_model))
    return out, warnings


def sanitize_messages(messages: list) -> list:
    """The conversation as the model should see it: no dangling or empty turns, and the caller's consecutive messages merged into one.

    A reply that was cut off mid tool call leaves an assistant message whose tool call never got a result (some servers answer 400 to that
    forever after: the bot goes silent for the rest of the call). A caller who pauses mid-thought is split into several user turns, each of
    which interrupted the previous request: the model should get them as ONE message."""
    answered = {m.get("tool_call_id") for m in messages if isinstance(m, dict) and m.get("role") == "tool"}
    issued = {tc.get("id") for m in messages if isinstance(m, dict) and m.get("role") == "assistant" for tc in (m.get("tool_calls") or []) if isinstance(tc, dict)}
    out: list = []
    for m in messages:
        if not isinstance(m, dict):
            out.append(m)
            continue
        role = m.get("role")
        if role == "assistant":
            calls = m.get("tool_calls") or []
            if calls and any(tc.get("id") not in answered for tc in calls if isinstance(tc, dict)):
                continue  # a tool call nobody answered
            content = m.get("content")
            if not calls and isinstance(content, (str, type(None))) and not (content or "").strip():
                continue  # an empty assistant turn
        elif role == "tool" and m.get("tool_call_id") not in issued:
            continue  # a result whose call is gone
        if role == "user" and out and isinstance(out[-1], dict) and out[-1].get("role") == "user" and isinstance(m.get("content"), str) and isinstance(out[-1].get("content"), str):
            out[-1] = {**out[-1], "content": (out[-1]["content"].rstrip() + " " + m["content"].lstrip()).strip()}
            continue
        out.append(m)
    return out


def has_output(chunk: Any) -> bool:
    """True when a streamed chunk carries the model's first real output (text, a tool call, reasoning or a finish reason)."""
    for c in getattr(chunk, "choices", None) or []:
        d = getattr(c, "delta", None)
        if d is not None and (getattr(d, "content", None) or getattr(d, "tool_calls", None) or getattr(d, "reasoning_content", None) or getattr(d, "reasoning", None)):
            return True
        if getattr(c, "finish_reason", None):
            return True
    return False


_SENTENCE_END = re.compile(r"""[.!?]["')\]]*\s""")
GATE_WORDS = 16


class _Gate:
    """Decides when a request has delivered enough for the voice to start: see 'What counts as answered' above."""

    def __init__(self, until: str):
        self.until = until
        self.text = ""
        self.finished = False
        self.tool = False
        self.first_at: float | None = None  # wall clock of the first real output

    def feed(self, chunk: Any) -> bool:
        out = has_output(chunk)
        if out and self.first_at is None:
            self.first_at = time.time()
        for c in getattr(chunk, "choices", None) or []:
            d = getattr(c, "delta", None)
            if d is not None:
                if getattr(d, "content", None):
                    self.text += d.content
                if getattr(d, "tool_calls", None):
                    self.tool = True
            if getattr(c, "finish_reason", None):
                self.finished = True
        if self.until == "token":
            return out
        if self.finished:
            return True
        if self.tool:
            return False  # a tool call runs when its arguments are complete: wait for the end of the stream
        return bool(_SENTENCE_END.search(self.text)) or len(self.text.split()) >= GATE_WORDS


async def _aclose(stream: Any) -> None:
    """Close an OpenAI stream (releases its HTTP connection). Never raises."""
    close = getattr(stream, "close", None) or getattr(stream, "aclose", None)
    if close is None:
        return
    try:
        res = close()
        if asyncio.iscoroutine(res) or hasattr(res, "__await__"):
            await res
    except Exception as e:  # pragma: no cover - best effort
        logger.debug(f"closing an LLM stream failed: {type(e).__name__}")


@dataclass
class _Opened:
    """A request whose stream has produced its first token (the chunks read so far are replayed first)."""

    prov: Provider
    attempt: int
    stream: Any
    it: Any
    buffered: list = field(default_factory=list)
    first_at: float | None = None  # wall clock of the first real token of this request
    t_req: float = field(default_factory=time.monotonic)


class _HedgedStream:
    """What the pipeline reads: the winner's already-seen chunks, then the rest of its stream. Exposes close()/aclose() like OpenAI's.
    Keeps the stream's timing and logs one summary line when it ends (longest gap between chunks shows a mid-stream stall)."""

    def __init__(self, opened: _Opened, text_cap: int = 0):
        self._o = opened
        self._closed = False
        self._text_cap = text_cap  # max content chunks (about tokens) of a PLAIN-TEXT reply; tool calls are never cut
        self._text_chunks = 0
        self._tool = False
        self._last = time.monotonic()
        self._max_gap = 0.0
        self._n = 0
        self._logged = False

    def __aiter__(self) -> "_HedgedStream":
        return self

    async def __anext__(self):
        try:
            if self._o.buffered:
                c = self._o.buffered.pop(0)
            elif self._closed:
                raise StopAsyncIteration
            else:
                c = await self._o.it.__anext__()
        except StopAsyncIteration:
            self._summary()
            raise
        for ch in getattr(c, "choices", None) or []:
            d = getattr(ch, "delta", None)
            if d is not None and getattr(d, "tool_calls", None):
                self._tool = True
            elif d is not None and getattr(d, "content", None):
                self._text_chunks += 1
        if self._text_cap and not self._tool and self._text_chunks > self._text_cap:
            logger.info(f"LLM reply cut after {self._text_cap} tokens (plain-text cap)")
            await self.close()
            self._summary()
            raise StopAsyncIteration
        now = time.monotonic()
        self._max_gap = max(self._max_gap, now - self._last)
        self._last = now
        self._n += 1
        return c

    def _summary(self) -> None:
        if self._logged:
            return
        self._logged = True
        logger.info(f"LLM stream {self._o.prov.key}: {self._n} chunks, ended {round((time.monotonic() - self._o.t_req) * 1000)} ms after the request, longest gap between chunks {round(self._max_gap * 1000)} ms")

    async def close(self) -> None:
        if not self._closed:
            self._closed = True
            await _aclose(self._o.stream)

    async def aclose(self) -> None:
        await self.close()


@dataclass
class _Attempt:
    pos: int  # chain position of its provider
    n: int  # 1-based request number within the provider
    deadline: float
    task: asyncio.Task
    started: float = field(default_factory=time.monotonic)


class _HedgedCompletions:
    def __init__(self, svc: "LightningLLMService"):
        self._svc = svc

    async def create(self, **params: Any):
        if not params.get("stream"):  # one-shot calls (warm-up, run_inference) go straight to the primary provider
            return await self._svc._clients[self._svc.providers[0].key].chat.completions.create(**params)
        return await self._svc._hedged_stream(params)


class LightningLLMService(NvidiaLLMService):
    """NvidiaLLMService with `enable_thinking: false`, hedged first-token requests and the provider chain described above."""

    def __init__(
        self,
        *,
        providers: list[Provider] | None = None,
        hedge_secs: float = 1.5,
        retry_secs: float = 4.0,
        timeout_secs: float = 8.0,
        cooldown_secs: float = 30.0,
        on_event: Callable[[str, dict], None] | None = None,
        on_slow: Callable[[], str | None] | None = None,
        hedge_until: str = "sentence",
        text_cap_tokens: int = 0,
        **kwargs: Any,
    ):
        super().__init__(**kwargs)
        primary_client = self._client
        base = kwargs.get("base_url") or "https://integrate.api.nvidia.com/v1"
        self.providers: list[Provider] = providers or [Provider("nvidia_lightning", "nvidia", base, kwargs.get("api_key") or "", self._settings.model or "")]
        self._clients: dict[str, Any] = {self.providers[0].key: primary_client}
        for p in self.providers[1:]:
            self._clients[p.key] = self.create_client(api_key=p.api_key, base_url=p.base_url)
        self._client = SimpleNamespace(chat=SimpleNamespace(completions=_HedgedCompletions(self)), models=primary_client.models)
        self.hedge_secs, self.retry_secs, self.timeout_secs, self.cooldown_secs = hedge_secs, retry_secs, timeout_secs, cooldown_secs
        self.text_cap_tokens = text_cap_tokens
        self.hedge_until = "token" if hedge_until == "token" else "sentence"
        self.on_event = on_event
        self.on_slow = on_slow  # returns a short "one moment" line to speak when the first token is late, or None
        self.served: list[dict] = []  # one entry per completed request since the bot last drained it (a tool turn has two)
        self.exhausted_line: str | None = prompts.ERROR_LINE
        self._cool_until: dict[str, float] = {}

    def create_client(self, *args: Any, **kwargs: Any):
        """The OpenAI client, minus its silent safety nets: no hidden retries (the SDK sleeps through a 429's Retry-After and backs off on 5xx
        inside create(), invisibly, which is how a request can take 38 s with no error in the log) and a read timeout of 10 s instead of
        10 minutes. Errors now surface immediately, to the hedge/failover logic above."""
        import httpx

        return super().create_client(*args, **kwargs).with_options(max_retries=0, timeout=httpx.Timeout(connect=4.0, read=10.0, write=10.0, pool=5.0))

    def build_chat_completion_params(self, params_from_context):
        params = super().build_chat_completion_params(params_from_context)
        self._merge_extra_body(params, {"chat_template_kwargs": {"enable_thinking": False}})
        if isinstance(params.get("messages"), list):
            params["messages"] = sanitize_messages(params["messages"])
        return params

    # ---- the race --------------------------------------------------------------------------------------------------------
    def _ordered(self) -> list[int]:
        """Provider indexes in try order: configured order, but providers that recently failed go last."""
        now = time.monotonic()
        hot = [i for i, p in enumerate(self.providers) if self._cool_until.get(p.key, 0.0) <= now]
        cold = [i for i, p in enumerate(self.providers) if i not in hot]
        return hot + cold

    def _cool(self, prov: Provider, why: str, secs: float | None = None) -> None:
        secs = self.cooldown_secs if secs is None else secs
        if secs > 0:
            self._cool_until[prov.key] = time.monotonic() + secs
            logger.warning(f"LLM {prov.key} ({prov.model}) {why}; trying it last for {secs:.0f} s")

    def _emit(self, kind: str, **info: Any) -> None:
        if self.on_event:
            try:
                self.on_event(kind, info)
            except Exception:  # pragma: no cover - reporting must never break a turn
                logger.exception("LLM event handler failed")

    async def _open(self, prov: Provider, params: dict) -> _Opened:
        """One request: connect, then read until the stream has delivered its first speakable unit. Closes its own stream if it fails or is cancelled."""
        p = dict(params)
        p["model"] = prov.model
        t_req = time.monotonic()
        stream = await self._clients[prov.key].chat.completions.create(**p)
        it = stream.__aiter__()
        buffered: list = []
        gate = _Gate(self.hedge_until)
        try:
            while True:
                chunk = await it.__anext__()
                buffered.append(chunk)
                if gate.feed(chunk):
                    break
        except StopAsyncIteration:
            pass  # the model finished without saying anything: hand over what there is
        except BaseException:
            await _aclose(stream)
            raise
        return _Opened(prov, 0, stream, it, buffered, first_at=gate.first_at, t_req=t_req)

    async def _hedged_stream(self, params: dict) -> _HedgedStream:
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        order = self._ordered()  # chain position -> index into self.providers
        H, R = self.hedge_secs, self.retry_secs
        T = self.timeout_secs if self.timeout_secs > 0 else float("inf")
        attempts: dict[asyncio.Task, _Attempt] = {}  # running requests
        every: list[asyncio.Task] = []  # every request ever started (cleanup)
        start: dict[int, float] = {}  # chain position -> when its first request started
        count: dict[int, int] = {}
        dead: set[int] = set()  # positions that gave up: cap hit, or every request errored
        retried: set[int] = set()
        errors: list[str] = []
        winner: _Opened | None = None
        winner_pos = 0
        handed_over = False
        slow_said = False

        def prov_at(pos: int) -> Provider:
            return self.providers[order[pos]]

        def running(pos: int) -> bool:
            return any(a.pos == pos for a in attempts.values())

        def launch(pos: int, now: float) -> None:
            prov = prov_at(pos)
            n = count[pos] = count.get(pos, 0) + 1
            start.setdefault(pos, now)
            task = asyncio.ensure_future(self._open(prov, params))
            attempts[task] = _Attempt(pos, n, start[pos] + T, task)
            every.append(task)
            if n > 1:
                logger.info(f"LLM {prov.key}: no first token after {now - start[pos]:.1f} s, request #{n} sent")
                self._emit("hedge", provider=prov.key, model=prov.model, attempt=n, after_ms=round((now - start[pos]) * 1000))
            elif pos > 0:
                logger.warning(f"LLM joining {prov.key} ({prov.model}) after {now:.1f} s")
                self._emit("failover", provider=prov.key, model=prov.model, after_ms=round(now * 1000), errors=errors[-2:])

        def give_up(pos: int, why: str, cool_secs: float | None = None) -> None:
            for task, a in list(attempts.items()):
                if a.pos == pos:
                    task.cancel()
                    del attempts[task]
            dead.add(pos)
            self._cool(prov_at(pos), why, cool_secs)

        try:
            while winner is None:
                now = loop.time() - t0
                for task, a in list(attempts.items()):  # hard cap
                    if a.deadline <= now and a.pos not in dead:
                        give_up(a.pos, f"gave no first token in {T:.0f} s")
                if not start:
                    launch(0, now)
                for pos in sorted(start):
                    if pos in dead:
                        continue
                    s0 = start[pos]
                    if count[pos] == 1 and 0 < H < T and now >= s0 + H:
                        nxt = pos + 1
                        if prov_at(pos).key == "brev" and nxt < len(order) and nxt not in start:
                            count[pos] = 2  # one GPU behind one tunnel: a second identical request would queue behind the first, so the hedge goes to the next provider
                            launch(nxt, now)
                        else:
                            launch(pos, now)  # the hedge: an identical request to the same provider
                    if 0 < R < T and pos not in retried and now >= s0 + R:
                        retried.add(pos)
                        if pos + 1 < len(order) and pos + 1 not in start:
                            launch(pos + 1, now)  # the retry: the next provider joins the race
                        elif pos + 1 >= len(order) and count[pos] < 3:
                            launch(pos, now)  # nobody left to bring in: one more request to the same provider
                        if not slow_said:
                            slow_said = True
                            await self._say_slow()
                for pos in sorted(dead):
                    if pos + 1 < len(order) and pos + 1 not in start:
                        launch(pos + 1, now)  # the previous provider is out: the next one starts at once
                if not attempts:
                    nxt = next((p for p in range(len(order)) if p not in start), None)
                    if nxt is None:
                        raise LLMUnavailable("; ".join(errors[-3:]) or "no provider produced a first token in time")
                    launch(nxt, now)
                wake = [a.deadline for a in attempts.values()]
                for pos, s0 in start.items():
                    if pos in dead:
                        continue
                    if count[pos] == 1 and 0 < H < T:
                        wake.append(s0 + H)
                    if 0 < R < T and pos not in retried:
                        wake.append(s0 + R)
                wake = [w for w in wake if w > now]
                timeout = max(0.0, min(wake) - now) if wake else None
                done, _ = await asyncio.wait(set(attempts), timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
                for task in sorted(done, key=lambda t: attempts[t].started):
                    a = attempts.pop(task, None)
                    if a is None or task.cancelled():
                        continue
                    prov = prov_at(a.pos)
                    exc = task.exception()
                    if exc is not None:
                        why = _describe(exc)
                        errors.append(f"{prov.key}: {why}")
                        logger.warning(f"LLM {prov.key} request #{a.n} failed: {why}")
                        if getattr(exc, "status_code", None) in (401, 403, 404):  # wrong key or model: retrying the same route is pointless
                            give_up(a.pos, f"rejected the request ({why})", 300.0)
                        elif not running(a.pos) and a.pos not in dead:
                            give_up(a.pos, f"failed ({why})")
                        continue
                    if winner is None:
                        winner = task.result()
                        winner.prov, winner.attempt, winner_pos = prov, a.n, a.pos
            ttfb_ms = round((loop.time() - t0) * 1000)
            self._cool_until.pop(winner.prov.key, None)
            for pos in start:  # a later provider beat the ones before it: try those last for a while, so the next turn does not pay the wait again
                if pos < winner_pos and pos not in dead:
                    self._cool(prov_at(pos), f"made no progress while {winner.prov.key} answered")
            info = {"provider": winner.prov.key, "label": winner.prov.label, "model": winner.prov.display, "ttfb_ms": ttfb_ms, "attempt": winner.attempt,
                    "failover": winner_pos > 0, "hedge_won": winner.attempt > 1}
            self.served.append(info)
            await self.stop_ttfb_metrics(end_time=winner.first_at)  # TTFB = the winner's real first token, not the end of the gate
            if info["hedge_won"] or info["failover"]:
                logger.info(f"LLM {winner.prov.key} answered after {ttfb_ms} ms (request #{winner.attempt}{', after failover' if info['failover'] else ''})")
                self._emit("won", **info)
            handed_over = True
            return _HedgedStream(winner, self.text_cap_tokens)
        except LLMUnavailable as e:
            logger.error(f"LLM unavailable: {e}")
            self._emit("exhausted", error=str(e))
            if self.exhausted_line:
                try:
                    await self.push_frame(TTSSpeakFrame(self.exhausted_line, append_to_context=False))
                except Exception:  # pragma: no cover
                    pass
            raise
        finally:
            # whoever lost (or was cut off by an interruption) is cancelled and its connection closed; nothing is left running
            for task in every:
                if not task.done():
                    task.cancel()
            if every:
                results = await asyncio.gather(*every, return_exceptions=True)
                for r in results:
                    if isinstance(r, _Opened) and r is not winner:
                        await _aclose(r.stream)  # finished in the same instant as the winner: nobody will read it
            if winner is not None and not handed_over:
                await _aclose(winner.stream)

    async def _say_slow(self) -> None:
        """A first token is taking long: let the bot say a short 'one moment' line (it decides whether one fits) so the caller is not left in silence."""
        if not self.on_slow:
            return
        try:
            line = self.on_slow()
            if line:
                await self.push_frame(TTSSpeakFrame(line, append_to_context=False))
        except Exception:  # pragma: no cover
            logger.exception("slow-reply filler failed")

    # ---- warm-up ---------------------------------------------------------------------------------------------------------
    async def warm(self, context: LLMContext | None = None) -> dict[str, float]:
        """Background warm-up, never raises. Connects to every provider (a models call: TLS handshake, no tokens spent). With a context,
        also sends the call's real system prompt + tool list with a throwaway user turn and max_tokens=1 to the primary provider, so its
        prompt-prefix cache already holds the ~3k tokens that every turn repeats and the first real question does not pay for them."""
        took: dict[str, float] = {}

        async def ping(prov: Provider) -> None:
            t = time.monotonic()
            try:
                await asyncio.wait_for(self._clients[prov.key].models.list(), timeout=6)
                took[f"connect:{prov.key}"] = time.monotonic() - t
            except Exception as e:
                logger.debug(f"LLM warm-up: {prov.key} connect failed ({type(e).__name__})")

        async def prime() -> None:
            t = time.monotonic()
            try:
                msgs = [m for m in context.messages] + [{"role": "user", "content": "Hello."}]
                tmp = LLMContext(messages=msgs, tools=context.tools)
                await asyncio.wait_for(self.run_inference(tmp, max_tokens=1), timeout=10)
                took["prime:" + self.providers[0].key] = time.monotonic() - t
            except Exception as e:
                logger.warning(f"LLM warm-up with the real prompt failed (the first answer may be slower): {type(e).__name__}: {e}")

        jobs = [ping(p) for p in self.providers]
        if context is not None:
            jobs.append(prime())
        else:
            # connection only for the primary too: a 1-token completion also wakes the route
            async def wake() -> None:
                t = time.monotonic()
                try:
                    await asyncio.wait_for(
                        self._clients[self.providers[0].key].chat.completions.create(
                            model=self.providers[0].model, messages=[{"role": "user", "content": "hi"}], max_tokens=1, stream=False, extra_body={"chat_template_kwargs": {"enable_thinking": False}}
                        ),
                        timeout=10,
                    )
                    took["wake:" + self.providers[0].key] = time.monotonic() - t
                except Exception as e:
                    logger.warning(f"LLM pre-warm failed (the first answer may be slower): {type(e).__name__}: {e}")

            jobs.append(wake())
        await asyncio.gather(*jobs)
        if took:
            logger.info("LLM warm-up: " + ", ".join(f"{k} {round(v * 1000)} ms" for k, v in took.items()))
        return took

    def drain_served(self) -> list[dict]:
        out, self.served = self.served, []
        return out


def _describe(exc: BaseException) -> str:
    status = getattr(exc, "status_code", None)
    return f"HTTP {status}" if status else type(exc).__name__


def build_llm(s: Settings, *, on_event: Callable[[str, dict], None] | None = None, on_slow: Callable[[], str | None] | None = None) -> LightningLLMService:
    providers, warnings = build_providers(s)
    for w in warnings:
        logger.warning(w)
    svc = LightningLLMService(
        providers=providers,
        hedge_secs=s.llm_hedge_secs,
        retry_secs=s.llm_retry_secs,
        timeout_secs=s.llm_timeout_secs,
        cooldown_secs=s.llm_cooldown_secs,
        hedge_until=s.llm_hedge_until,
        text_cap_tokens=s.llm_max_tokens,
        on_event=on_event,
        on_slow=on_slow,
        api_key=providers[0].api_key,
        base_url=providers[0].base_url,
        settings=LightningLLMService.Settings(model=providers[0].model, temperature=s.llm_temperature, top_p=s.llm_top_p, max_completion_tokens=max(s.llm_api_max_tokens, s.llm_max_tokens)),
    )
    return svc
