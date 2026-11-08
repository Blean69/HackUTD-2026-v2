"""Hedged first-token requests and the provider failover chain (llm.py), against fake OpenAI clients with scripted stalls.

The stall that motivated this: one hosted request produced no first token for 38 s with no error, and pipecat's own retry only wraps the
HTTP connect, so it never fired. These tests stall the FIRST stream and prove the hedge answers instead, that the loser is cancelled and
closed, that a tool call or text is never delivered twice, and that a dead provider is skipped for the next turns."""
import asyncio
import time
from types import SimpleNamespace

import pytest
from pipecat.frames.frames import LLMFullResponseEndFrame, LLMTextFrame, TTSSpeakFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.frames.frames import LLMContextFrame
from pipecat.tests.utils import run_test

import llm
from config import Settings
from llm import LightningLLMService, LLMUnavailable, Provider, build_llm, build_providers, has_output

A = Provider("nvidia_lightning", "nvidia", "http://a.invalid/v1", "ka", "nvidia/nemotron-3.5-lightning-30b-a3b")
B = Provider("brev", "brev", "http://b.invalid/v1", "kb", "nemotron")
C = Provider("nvidia_nano", "nvidia", "http://c.invalid/v1", "kc", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")


def chunk(content=None, tool=None, finish=None, role=False):
    delta = SimpleNamespace(content=content, tool_calls=tool, role="assistant" if role else None, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=finish, index=0)], usage=None, model="served-model")


def tool_chunk(name, args):
    tc = SimpleNamespace(index=0, id="call_1", function=SimpleNamespace(name=name, arguments=args))
    return chunk(tool=[tc])


class FakeStream:
    """An OpenAI-style async stream whose first chunk is delayed (`stall` seconds), then yields `chunks`."""

    def __init__(self, tag, stall, chunks, registry):
        self.tag, self.stall, self._chunks, self.closed, self.cancelled, self.yielded = tag, stall, list(chunks), False, False, 0
        registry.append(self)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            if self.yielded == 0 and self.stall:
                await asyncio.sleep(self.stall)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        if not self._chunks:
            raise StopAsyncIteration
        self.yielded += 1
        return self._chunks.pop(0)

    async def close(self):
        self.closed = True


class FakeClient:
    """script: one entry per create() call: ("stall", secs, tag) | ("error", status) | ("slow-connect", secs, tag)."""

    def __init__(self, script, streams, text="hello there"):
        self.script, self.calls, self.models_calls, self.streams, self.text = list(script), [], 0, streams, text
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        self.models = SimpleNamespace(list=self.list_models)

    async def list_models(self):
        self.models_calls += 1

    async def create(self, **p):
        self.calls.append(p)
        step = self.script.pop(0) if self.script else ("stall", 0, "default")
        if step[0] == "error":
            raise StatusError(step[1])
        if step[0] == "slow-connect":
            await asyncio.sleep(step[1])
        stall = step[1] if step[0] == "stall" else 0
        tag = step[2] if len(step) > 2 else f"{len(self.calls)}"
        chunks = [chunk(role=True, content=""), chunk(content=self.text), chunk(content=" done"), chunk(finish="stop")]
        return FakeStream(tag, stall, chunks, self.streams)


class StatusError(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.status_code = status


def make(providers, scripts, *, hedge=0.05, retry=0.15, timeout=0.4, cooldown=5.0, **kw):
    streams: list[FakeStream] = []
    svc = LightningLLMService(
        providers=providers, hedge_secs=hedge, retry_secs=retry, timeout_secs=timeout, cooldown_secs=cooldown,
        api_key=providers[0].api_key, base_url=providers[0].base_url, settings=LightningLLMService.Settings(model=providers[0].model), **kw,
    )
    clients = {p.key: FakeClient(scripts.get(p.key, []), streams, text=f"from {p.key}") for p in providers}
    svc._clients = clients
    return svc, clients, streams


async def read(stream):
    out = []
    async for c in stream:
        for ch in c.choices:
            if ch.delta.content:
                out.append(ch.delta.content)
    return "".join(out)


async def settle():
    await asyncio.sleep(0.02)


PARAMS = {"model": "m", "messages": [{"role": "user", "content": "hi"}], "stream": True}


async def test_a_stalled_first_stream_loses_to_the_hedge_and_is_cleaned_up():
    svc, clients, streams = make([A], {"nvidia_lightning": [("stall", 30, "stalled"), ("stall", 0, "hedge")]})
    t = time.monotonic()
    stream = await svc._client.chat.completions.create(**PARAMS)
    text = await read(stream)
    took = time.monotonic() - t
    await stream.aclose()
    await settle()
    assert text == "from nvidia_lightning done" and took < 0.5  # not 30 s
    assert len(clients["nvidia_lightning"].calls) == 2  # one identical hedge, nothing more
    assert clients["nvidia_lightning"].calls[0]["messages"] == clients["nvidia_lightning"].calls[1]["messages"]
    stalled, hedge = streams
    assert stalled.tag == "stalled" and stalled.cancelled and stalled.closed and stalled.yielded == 0  # the loser never delivered anything
    assert hedge.closed
    assert all(s.closed for s in streams)  # no leaked connection
    served = svc.drain_served()
    assert len(served) == 1 and served[0]["hedge_won"] and served[0]["attempt"] == 2 and served[0]["provider"] == "nvidia_lightning"
    assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]  # no stray request left running


async def test_a_healthy_first_stream_is_not_hedged():
    svc, clients, streams = make([A], {"nvidia_lightning": [("stall", 0.01, "only")]})
    stream = await svc._client.chat.completions.create(**PARAMS)
    assert await read(stream) == "from nvidia_lightning done"
    await stream.aclose()
    assert len(clients["nvidia_lightning"].calls) == 1 and svc.served[0]["hedge_won"] is False
    assert all(s.closed for s in streams)


async def test_a_role_only_first_chunk_is_not_a_first_token():
    assert not has_output(chunk(role=True, content="")) and has_output(chunk(content="Hi")) and has_output(chunk(finish="stop")) and has_output(tool_chunk("f", "{}"))
    assert not has_output(SimpleNamespace(choices=[], usage=object()))  # usage-only chunk
    svc, clients, _ = make([A], {"nvidia_lightning": [("stall", 30, "stalled"), ("stall", 0, "hedge")]})
    stream = await svc._client.chat.completions.create(**PARAMS)
    await read(stream)
    await stream.aclose()
    assert len(clients["nvidia_lightning"].calls) == 2


async def test_retry_setting_covers_a_second_stall_when_there_is_no_other_provider():
    # hedge at 0.05 s also stalls; the retry timer (0.15 s) sends request #3 to the only provider, which answers
    svc, clients, streams = make([A], {"nvidia_lightning": [("stall", 30), ("stall", 30), ("stall", 0)]}, timeout=1.0)
    stream = await svc._client.chat.completions.create(**PARAMS)
    assert await read(stream) == "from nvidia_lightning done"
    await stream.aclose()
    await settle()
    assert len(clients["nvidia_lightning"].calls) == 3 and svc.served[0]["attempt"] == 3
    assert all(s.closed for s in streams)


async def test_hard_cap_falls_to_the_next_provider_and_the_dead_one_is_tried_last_afterwards():
    spoken = []

    async def capture(frame, direction=None):
        spoken.append(frame)

    svc, clients, streams = make([A, B], {"nvidia_lightning": [("stall", 30)] * 6, "brev": [("stall", 0, "brev1"), ("stall", 0, "brev2")]}, retry=0.0, timeout=0.2)
    svc.push_frame = capture
    events = []
    svc.on_event = lambda kind, info: events.append((kind, info))
    stream = await svc._client.chat.completions.create(**PARAMS)  # A: #1 at 0, hedge at 0.05; both capped at 0.2 -> brev
    text = await read(stream)
    await stream.aclose()
    assert text == "from brev done"
    info = svc.drain_served()[0]
    assert info["provider"] == "brev" and info["failover"] and info["label"] == "brev" and info["model"] == "nemotron"
    assert [k for k, _ in events].count("failover") == 1 and events[-1][0] == "won"
    assert len(clients["nvidia_lightning"].calls) == 2 and all(s.cancelled and s.closed for s in streams if s.tag != "brev1")
    # next turn: A is cooling, so brev goes first and A is not even called
    stream = await svc._client.chat.completions.create(**PARAMS)
    assert await read(stream) == "from brev done"
    await stream.aclose()
    assert len(clients["nvidia_lightning"].calls) == 2
    assert all(s.closed for s in streams)


async def test_retry_brings_the_next_provider_into_the_race_while_the_first_keeps_trying():
    svc, clients, streams = make([A, B], {"nvidia_lightning": [("stall", 30), ("stall", 30)], "brev": [("stall", 0, "brev")]}, retry=0.15, timeout=2.0)
    t = time.monotonic()
    stream = await svc._client.chat.completions.create(**PARAMS)
    assert await read(stream) == "from brev done"
    assert time.monotonic() - t < 0.6
    await stream.aclose()
    await settle()
    assert svc.served[0]["failover"] and all(s.closed for s in streams)
    assert svc._cool_until["nvidia_lightning"] > time.monotonic()  # passed over: brev goes first on the next turn, not another 0.15 s wait
    assert svc._ordered() == [1, 0]


async def test_errors_fail_over_at_once_and_a_404_parks_the_provider_for_minutes():
    svc, clients, streams = make([A, B, C], {"nvidia_lightning": [("error", 429), ("error", 429)], "brev": [("error", 404)], "nvidia_nano": [("stall", 0, "nano")]}, hedge=5.0, retry=0.0, timeout=5.0)
    t = time.monotonic()
    stream = await svc._client.chat.completions.create(**PARAMS)
    assert await read(stream) == "from nvidia_nano done" and time.monotonic() - t < 0.5  # no waiting on timers
    await stream.aclose()
    info = svc.drain_served()[0]
    assert info["provider"] == "nvidia_nano" and info["model"].startswith("nvidia/nemotron")
    assert svc._cool_until["brev"] - time.monotonic() > 200  # 404: wrong model/route, long cooldown
    assert 0 < svc._cool_until["nvidia_lightning"] - time.monotonic() <= 5.0


async def test_every_provider_failing_raises_and_the_caller_hears_an_apology():
    spoken = []

    async def capture(frame, direction=None):
        spoken.append(frame)

    svc, _, streams = make([A, B], {"nvidia_lightning": [("error", 500)], "brev": [("error", 503)]}, hedge=5.0, retry=0.0, timeout=5.0)
    svc.push_frame = capture
    events = []
    svc.on_event = lambda kind, info: events.append(kind)
    with pytest.raises(LLMUnavailable):
        await svc._client.chat.completions.create(**PARAMS)
    assert any(isinstance(f, TTSSpeakFrame) and "say it again" in f.text for f in spoken) and "exhausted" in events


async def test_cancelling_the_wait_cancels_every_request_and_closes_every_stream():
    svc, clients, streams = make([A], {"nvidia_lightning": [("stall", 30), ("stall", 30), ("stall", 30)]}, timeout=5.0)
    task = asyncio.create_task(svc._client.chat.completions.create(**PARAMS))
    await asyncio.sleep(0.12)  # barge-in while the request and its hedge are both stalled
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await settle()
    assert len(streams) == 2 and all(s.cancelled and s.closed for s in streams)
    assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]


async def test_slow_first_token_asks_the_bot_for_a_one_moment_line_once():
    spoken = []

    async def capture(frame, direction=None):
        spoken.append(frame)

    lines = iter(["One moment.", "never"])
    svc, _, _ = make([A, B], {"nvidia_lightning": [("stall", 30), ("stall", 30)], "brev": [("stall", 0)]}, retry=0.1, timeout=2.0, on_slow=lambda: next(lines))
    svc.push_frame = capture
    stream = await svc._client.chat.completions.create(**PARAMS)
    await read(stream)
    await stream.aclose()
    assert [f.text for f in spoken if isinstance(f, TTSSpeakFrame)] == ["One moment."]


async def test_through_the_pipecat_service_a_stalled_first_request_still_yields_one_reply_and_one_tool_call():
    """End to end through NvidiaLLMService._process_context: the stalled stream emits a tool call too, but only the winner's reaches the pipeline."""
    svc, clients, streams = make([A], {"nvidia_lightning": [("stall", 30, "stalled"), ("stall", 0, "hedge")]}, timeout=2.0)
    calls = []

    async def handler(params):
        calls.append(params.function_name)
        await params.result_callback({"ok": True})

    svc.register_function("get_forecast", handler)
    ctx = LLMContext(messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "How are we doing?"}])
    down, _ = await run_test(svc, frames_to_send=[LLMContextFrame(ctx)])
    text = "".join(f.text for f in down if isinstance(f, LLMTextFrame))
    assert text == "from nvidia_lightning done"  # said once, not twice
    assert sum(isinstance(f, LLMFullResponseEndFrame) for f in down) == 1
    assert [s.tag for s in streams] == ["stalled", "hedge"] and all(s.closed for s in streams)
    assert streams[0].yielded == 0 and calls == []


async def test_a_tool_call_in_the_winning_stream_runs_exactly_once():
    svc, clients, streams = make([A], {"nvidia_lightning": [("stall", 30, "stalled"), ("stall", 0, "hedge")]}, timeout=2.0)
    first = clients["nvidia_lightning"]
    orig = first.create
    n = {"i": 0}

    async def create(**p):
        n["i"] += 1
        s = await orig(**p)
        if s.tag == "hedge":
            s._chunks = [tool_chunk("get_forecast", "{}"), chunk(finish="tool_calls")]
        elif s.tag == "stalled":
            s._chunks = [tool_chunk("get_forecast", "{}"), chunk(finish="tool_calls")]
        else:
            s._chunks = [chunk(content="The forecast looks fine."), chunk(finish="stop")]
        return s

    first.create = create
    first.chat.completions.create = create
    calls = []

    async def handler(params):
        calls.append(params.function_name)
        await params.result_callback({"low": 1000})

    svc.register_function("get_forecast", handler)
    ctx = LLMContext(messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "forecast?"}])
    down, _ = await run_test(svc, frames_to_send=[LLMContextFrame(ctx)])
    assert calls == ["get_forecast"]  # one hedge pair, one tool call


# ---- provider list --------------------------------------------------------------------------------------------------------------
def test_provider_chain_from_settings():
    s = Settings(nvidia_api_key="nk", llm_api_key="nk")
    chain, warn = build_providers(s)
    assert [p.key for p in chain] == ["nvidia_lightning", "nvidia_nano"]  # brev has no URL: skipped with a warning
    assert any("brev" in w for w in warn)
    assert chain[0].model == "nvidia/nemotron-3.5-lightning-30b-a3b" and chain[1].model.startswith("nvidia/nemotron-3-nano")
    assert all("nemotron" in p.model.lower() for p in chain)
    s2 = s.with_overrides(brev_base_url="https://brev.example/v1", brev_model="nemotron", brev_api_key="bk")
    chain2, warn2 = build_providers(s2)
    assert [p.key for p in chain2] == ["brev", "nvidia_lightning", "nvidia_nano"] and not warn2  # our own GPU first when it is configured
    assert chain2[0].label == "brev" and chain2[0].base_url == "https://brev.example/v1" and chain2[0].api_key == "bk"
    assert chain2[0].model == "nemotron" and chain2[0].display == "nemotron-3.5-lightning (Brev L40S)"  # sent as "nemotron", shown as the real model
    assert [p.key for p in build_providers(s2.with_overrides(llm_providers=["brev", "nvidia_lightning"]))[0]] == ["brev", "nvidia_lightning"]
    odd, w = build_providers(s.with_overrides(llm_providers=["nope", "nvidia_lightning", "nvidia_lightning"]))
    assert [p.key for p in odd] == ["nvidia_lightning"] and any("nope" in x for x in w)
    empty, w = build_providers(s.with_overrides(llm_providers=["nope"]))
    assert [p.key for p in empty] == ["nvidia_lightning"]


def test_build_llm_wires_the_settings(monkeypatch):
    s = Settings(nvidia_api_key="nk", llm_api_key="nk", llm_hedge_secs=1.2, llm_retry_secs=3.0, llm_timeout_secs=7.0, llm_cooldown_secs=11.0, brev_base_url="https://brev.example/v1", brev_model="nemotron")
    svc = build_llm(s)
    assert (svc.hedge_secs, svc.retry_secs, svc.timeout_secs, svc.cooldown_secs) == (1.2, 3.0, 7.0, 11.0)
    assert [p.key for p in svc.providers] == ["brev", "nvidia_lightning", "nvidia_nano"] and set(svc._clients) == {"nvidia_lightning", "brev", "nvidia_nano"}


def test_env_names_and_defaults(monkeypatch):
    import config

    for k in ("VOICE_LLM_PROVIDERS", "VOICE_LLM_HEDGE_SECS", "VOICE_LLM_TIMEOUT_SECS", "VOICE_LLM_RETRY_SECS", "LLM_RETRY_SECS", "BREV_BASE_URL", "BREV_API_KEY", "BREV_NEMOTRON_MODEL", "VOICE_LLM_NANO_MODEL"):
        monkeypatch.delenv(k, raising=False)
    d = config.load_settings()
    assert d.llm_providers == ["brev", "nvidia_lightning", "nvidia_nano"] and d.llm_hedge_secs == 1.5 and d.llm_timeout_secs == 8.0 and d.llm_retry_secs == 4.0 and d.brev_base_url == ""
    monkeypatch.setenv("VOICE_LLM_PROVIDERS", "brev; nvidia_lightning")
    monkeypatch.setenv("VOICE_LLM_HEDGE_SECS", "0.8")
    monkeypatch.setenv("VOICE_LLM_TIMEOUT_SECS", "6")
    monkeypatch.setenv("LLM_RETRY_SECS", "3")  # the shorter alias is honoured when VOICE_LLM_RETRY_SECS is unset
    monkeypatch.setenv("BREV_BASE_URL", "https://brev.example/v1/")
    monkeypatch.setenv("BREV_NEMOTRON_MODEL", "nemotron")
    s = config.load_settings()
    assert s.llm_providers == ["brev", "nvidia_lightning"] and s.llm_hedge_secs == 0.8 and s.llm_timeout_secs == 6.0 and s.llm_retry_secs == 3.0
    assert s.brev_base_url == "https://brev.example/v1" and s.brev_model == "nemotron"
    monkeypatch.setenv("VOICE_LLM_RETRY_SECS", "5")
    assert config.load_settings().llm_retry_secs == 5.0


# ---- a stall AFTER the first token (the voice speaks nothing until it holds a whole sentence) ----------------------------------------
class ScriptedStream(FakeStream):
    """Chunks with a delay before each: [(0, chunk), (30, chunk), ...]."""

    def __init__(self, tag, steps, registry):
        super().__init__(tag, 0, [c for _, c in steps], registry)
        self._delays = [d for d, _ in steps]

    async def __anext__(self):
        try:
            if self._delays and self._delays[0]:
                await asyncio.sleep(self._delays[0])
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        if self._delays:
            self._delays.pop(0)
        if not self._chunks:
            raise StopAsyncIteration
        self.yielded += 1
        return self._chunks.pop(0)


def scripted_service(steps_per_call, **kw):
    streams: list[FakeStream] = []
    svc = LightningLLMService(providers=[A], hedge_secs=0.05, retry_secs=0.0, timeout_secs=1.0, api_key="k", base_url=A.base_url, settings=LightningLLMService.Settings(model=A.model), **kw)
    calls = []

    async def create(**p):
        calls.append(p)
        return ScriptedStream(f"call{len(calls)}", steps_per_call[len(calls) - 1], streams)

    svc._clients = {A.key: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), models=None)}
    return svc, calls, streams


STALLS_MID_SENTENCE = [(0, chunk(content="Pretty")), (30, chunk(content=" good, honestly.")), (0, chunk(content=" More.")), (0, chunk(finish="stop"))]
WHOLE_SENTENCE = [(0.01, chunk(content="Pretty")), (0, chunk(content=" good, honestly.")), (0, chunk(content=" You are fine.")), (0, chunk(finish="stop"))]


async def test_a_stall_after_the_first_token_is_hedged_when_the_gate_is_a_sentence():
    svc, calls, streams = scripted_service([STALLS_MID_SENTENCE, WHOLE_SENTENCE])
    t = time.monotonic()
    stream = await svc._client.chat.completions.create(**PARAMS)
    text = await read(stream)
    await stream.aclose()
    await settle()
    assert text == "Pretty good, honestly. You are fine." and time.monotonic() - t < 0.6
    assert len(calls) == 2 and streams[0].cancelled and streams[0].closed and streams[0].yielded == 1  # it had said "Pretty", and none of that reached the pipeline
    assert svc.served[0]["hedge_won"]


async def test_with_the_token_gate_the_first_chunk_wins_even_if_the_sentence_never_finishes():
    svc, calls, streams = scripted_service([[(0, chunk(content="Pretty")), (0.3, chunk(content=" good, honestly.")), (0, chunk(finish="stop"))], WHOLE_SENTENCE], hedge_until="token")
    stream = await svc._client.chat.completions.create(**PARAMS)
    assert await read(stream) == "Pretty good, honestly."
    await stream.aclose()
    assert len(calls) == 1  # the old rule: one chunk of text and the race is over


async def test_a_tool_call_wins_only_when_its_arguments_are_complete():
    stalls_in_args = [(0, tool_chunk("simulate_scenario", '{"kind":')), (30, tool_chunk("simulate_scenario", '"purchase"}')), (0, chunk(finish="tool_calls"))]
    whole = [(0.01, tool_chunk("simulate_scenario", '{"kind":"purchase"}')), (0, chunk(finish="tool_calls"))]
    svc, calls, streams = scripted_service([stalls_in_args, whole])
    stream = await svc._client.chat.completions.create(**PARAMS)
    chunks = [c async for c in stream]
    await stream.aclose()
    assert len(calls) == 2 and streams[0].cancelled
    assert [c.choices[0].delta.tool_calls[0].function.arguments for c in chunks if c.choices[0].delta.tool_calls] == ['{"kind":"purchase"}']


async def test_a_long_run_on_sentence_does_not_wait_for_a_full_stop():
    words = [(0, chunk(content=f" w{i}")) for i in range(20)] + [(0, chunk(finish="stop"))]
    svc, calls, streams = scripted_service([words])
    stream = await svc._client.chat.completions.create(**PARAMS)
    first = await stream.__anext__()
    assert first.choices[0].delta.content == " w0" and len(calls) == 1  # released after ~16 words, buffered chunks replayed in order
    rest = [c async for c in stream]
    assert len(rest) == 20
    await stream.aclose()


# ---- wiring in the call: the model that really answered is what the trace says --------------------------------------------------------------
def test_said_event_carries_the_model_and_provider_that_answered():
    from reporter import TraceReporter

    rep = TraceReporter(client=None)  # only the pending queue is looked at
    rep.said("Pretty good.", model="nemotron", provider="brev", llm_ms=1.75, v2v_ms=2.4)
    ev = rep._pending[-1]
    assert ev["kind"] == "said" and ev["model"] == "nemotron" and ev["provider"] == "brev" and ev["llm_ms"] == 1750
    rep.said("Hello.", model="nvidia/nemotron-3.5-lightning-30b-a3b")
    assert rep._pending[-1]["provider"] == "nvidia"


def test_call_hooks_one_filler_per_turn_and_trace_notes():
    import bot
    from bot import CallInit, VoiceCall

    s = Settings(nvidia_api_key="k", llm_api_key="k", brev_base_url="https://brev.example/v1", brev_model="nemotron")
    call = VoiceCall(s, CallInit(call_id="c1", kind="webrtc", transport_label="webrtc", household_id="hh"), transport=None)
    line = call._slow_line()
    assert line in bot.prompts.FILLERS and call._slow_line() is None  # one "one moment" per caller turn
    call._filled = False
    call._tap.spoke = True
    assert call._slow_line() is None  # never on top of words already said
    call._on_llm_event("hedge", {"provider": "nvidia_lightning", "model": "m", "attempt": 2, "after_ms": 1500})
    call._on_llm_event("failover", {"provider": "brev", "model": "nemotron", "after_ms": 4000, "errors": ["nvidia_lightning: HTTP 429"]})
    call._on_llm_event("exhausted", {"error": "all down"})
    kinds = [(e["kind"], e.get("title", "")) for e in call.reporter._pending]
    assert ("note", "LLM first token was late: sent a second identical request") in kinds and ("note", "LLM provider failover") in kinds and any(k == "error" for k, _ in kinds)
    assert call.stats["llm_hedges"] == 1 and call.stats["llm_failovers"] == 1
    assert [p.key for p in call.llm.providers] == ["brev", "nvidia_lightning", "nvidia_nano"]


def test_health_lists_the_llm_chain_without_secrets():
    from fastapi.testclient import TestClient

    from server import create_app

    s = Settings(shared_secret="vs", nvidia_api_key="secret-nvidia", llm_api_key="secret-nvidia", brev_base_url="https://brev.example/v1", brev_model="nemotron", brev_api_key="secret-brev")
    with TestClient(create_app(s)) as c:
        body = c.get("/health").json()
    assert [p["provider"] for p in body["llm_chain"]] == ["brev", "nvidia_lightning", "nvidia_nano"]
    assert all("nemotron" in p["model"].lower() for p in body["llm_chain"]) and "secret-nvidia" not in str(body) and "secret-brev" not in str(body)


def test_the_sdk_no_longer_retries_silently_and_reads_time_out_in_seconds():
    svc = build_llm(Settings(nvidia_api_key="k", llm_api_key="k"))
    for key, client in svc._clients.items():
        assert client.max_retries == 0, key  # a 429/5xx must reach the failover logic, not sleep inside create()
        assert client.timeout.read == 10.0 and client.timeout.connect == 4.0


async def test_brev_first_a_stalled_brev_hedges_to_hosted_lightning_not_to_itself():
    br = Provider("brev", "brev", "http://b.invalid/v1", "kb", "nemotron", "nemotron-3.5-lightning (Brev L40S)")
    svc, clients, streams = make([br, A], {"brev": [("stall", 30, "brev-stalled")], "nvidia_lightning": [("stall", 0, "hosted")]}, retry=0.0, timeout=2.0)
    t = time.monotonic()
    stream = await svc._client.chat.completions.create(**PARAMS)
    assert await read(stream) == "from nvidia_lightning done" and time.monotonic() - t < 0.6
    await stream.aclose()
    await settle()
    assert len(clients["brev"].calls) == 1 and len(clients["nvidia_lightning"].calls) == 1  # one request each, no second one to the stalled GPU
    info = svc.drain_served()[0]
    assert info["provider"] == "nvidia_lightning" and info["failover"] and streams[0].cancelled and all(s.closed for s in streams)
    assert svc._ordered() == [1, 0]  # brev was passed over: hosted goes first for the next turns, brev rejoins after the cooldown


async def test_brev_answering_is_reported_as_the_real_model():
    br = Provider("brev", "brev", "http://b.invalid/v1", "kb", "nemotron", "nemotron-3.5-lightning (Brev L40S)")
    svc, clients, streams = make([br, A], {"brev": [("stall", 0.01, "brev")]})
    stream = await svc._client.chat.completions.create(**PARAMS)
    await read(stream)
    await stream.aclose()
    info = svc.drain_served()[0]
    assert info["provider"] == "brev" and info["label"] == "brev" and info["model"] == "nemotron-3.5-lightning (Brev L40S)"
    assert clients["brev"].calls[0]["model"] == "nemotron"  # the wire still says what vLLM serves it as
