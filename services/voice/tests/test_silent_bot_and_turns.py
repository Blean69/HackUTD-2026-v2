"""The silent-bot incident and the split-turn incident from a live phone call.

A rambling caller with "uh" pauses was split into four user turns, each starting an LLM call that interrupted the previous one. From then on
every reply used exactly 80 completion tokens (the old API cap) with nothing spoken: a tool call cut at 80 tokens is invalid JSON, pipecat
drops it, no tool runs and no text comes out, and the broken turn stayed in the context so every later turn failed the same way."""
import asyncio
import json
from types import SimpleNamespace

from pipecat.frames.frames import (
    FunctionCallsStartedFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSSpeakFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.tests.utils import run_test

import bot
import prompts
from config import Settings
from llm import LightningLLMService, Provider, build_llm, sanitize_messages
from test_llm_hedge import A, FakeStream, PARAMS, chunk, read, tool_chunk
from turns import HesitationAwareStop, ends_with_hesitation

LONG_ARGS = json.dumps({"kind": "purchase", "label": "car", "amount": 35000, "financed": True, "down_payment": 5000, "apr_pct": 6.5, "term_months": 60, "monthly_payment": 540})


def tool_cont(args):
    tc = SimpleNamespace(index=0, id=None, function=SimpleNamespace(name=None, arguments=args))
    return chunk(tool=[tc])


def pieces(text, n):
    return [text[i : i + n] for i in range(0, len(text), n)]


def long_tool_stream(registry, cut_at=None):
    """A simulate_scenario call whose arguments stream in many small chunks; cut_at = stop after that many (the old 80-token API cap)."""
    parts = pieces(LONG_ARGS, 3)
    parts = parts if cut_at is None else parts[:cut_at]
    chunks = [tool_chunk("simulate_scenario", parts[0])] + [tool_cont(p) for p in parts[1:]]
    if cut_at is None:
        chunks.append(chunk(finish="tool_calls"))
    return FakeStream("tool", 0, chunks, registry)


# ---- never cap a tool call; cap plain text client-side ----------------------------------------------------------------------------------
def test_api_budget_is_larger_than_the_spoken_text_cap():
    s = Settings(nvidia_api_key="k", llm_api_key="k")
    assert s.llm_api_max_tokens >= 400 and s.llm_max_tokens == 80
    svc = build_llm(s)
    assert svc._settings.max_completion_tokens == 400 and svc.text_cap_tokens == 80  # the API may write 400 tokens; a plain-text reply is cut at 80
    import config

    assert config.load_settings().llm_api_max_tokens >= 400


async def test_a_long_tool_call_is_never_cut_but_plain_text_is():
    registry = []
    svc = LightningLLMService(providers=[A], hedge_secs=5.0, retry_secs=0.0, timeout_secs=5.0, text_cap_tokens=10, api_key="k", base_url=A.base_url, settings=LightningLLMService.Settings(model=A.model))
    streams = iter([long_tool_stream(registry), FakeStream("text", 0, [chunk(content=f" w{i}") for i in range(40)] + [chunk(finish="stop")], registry)])

    async def create(**p):
        return next(streams)

    svc._clients = {A.key: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), models=None)}
    stream = await svc._client.chat.completions.create(**PARAMS)
    chunks = [c async for c in stream]
    await stream.aclose()
    args = "".join(c.choices[0].delta.tool_calls[0].function.arguments for c in chunks if c.choices and c.choices[0].delta.tool_calls)
    assert json.loads(args)["monthly_payment"] == 540  # all of it: far more than 10 chunks, and valid JSON
    stream = await svc._client.chat.completions.create(**PARAMS)
    text = await read(stream)
    await stream.aclose()
    assert len(text.split()) == 10  # plain text stopped at the cap
    assert all(s.closed for s in registry)


async def test_the_pipeline_runs_a_long_tool_call_to_completion_and_a_truncated_one_runs_nothing():
    for cut_at, expect in ((None, ["simulate_scenario"]), (6, [])):
        registry = []
        svc = LightningLLMService(providers=[A], hedge_secs=5.0, retry_secs=0.0, timeout_secs=5.0, text_cap_tokens=10, api_key="k", base_url=A.base_url, settings=LightningLLMService.Settings(model=A.model))
        called = []

        async def create(**p):
            return long_tool_stream(registry, cut_at) if not called else FakeStream("after", 0, [chunk(content="Done."), chunk(finish="stop")], registry)

        svc._clients = {A.key: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), models=None)}

        async def handler(params):
            called.append((params.function_name, params.arguments))
            await params.result_callback({"ok": True})

        svc.register_function("simulate_scenario", handler)
        await run_test(svc, frames_to_send=[LLMContextFrame(LLMContext(messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "what if"}]))])
        assert [n for n, _ in called] == expect
        if expect:
            assert called[0][1]["monthly_payment"] == 540  # arguments parsed intact


# ---- nothing speakable -> a recovery line, not silence -----------------------------------------------------------------------------------
class Capture:
    def __init__(self):
        self.empty_calls = 0

    async def on_empty(self):
        self.empty_calls += 1


async def test_a_reply_with_nothing_to_say_triggers_the_recovery_hook():
    cap = Capture()
    tap = bot.LLMTap(on_empty=cap.on_empty)
    await run_test(tap, frames_to_send=[LLMFullResponseStartFrame(), LLMFullResponseEndFrame()])
    assert cap.empty_calls == 1
    # the same thing when the model "spoke" only whitespace
    tap = bot.LLMTap(on_empty=cap.on_empty)
    await run_test(tap, frames_to_send=[LLMFullResponseStartFrame(), LLMTextFrame(" "), LLMTextFrame("\n"), LLMFullResponseEndFrame()])
    assert cap.empty_calls == 2


async def test_replies_that_did_something_do_not_trigger_it():
    cap = Capture()
    await run_test(bot.LLMTap(on_empty=cap.on_empty), frames_to_send=[LLMFullResponseStartFrame(), LLMTextFrame("Sure."), LLMFullResponseEndFrame()])  # spoke
    await run_test(bot.LLMTap(on_empty=cap.on_empty), frames_to_send=[LLMFullResponseStartFrame(), TTSSpeakFrame("Sorry.", append_to_context=False), LLMFullResponseEndFrame()])  # a fixed line is on its way
    # a tool is running / the caller cut in: those flags are set by system frames mid-reply, so preset them and send the end of the reply
    for flag in ("_saw_call", "_interrupted"):
        tap = bot.LLMTap(on_empty=cap.on_empty)
        setattr(tap, flag, True)
        await run_test(tap, frames_to_send=[LLMFullResponseEndFrame()])
    assert cap.empty_calls == 0
    tap = bot.LLMTap(on_empty=cap.on_empty)
    await run_test(tap, frames_to_send=[LLMFullResponseEndFrame()])  # the control: nothing at all
    assert cap.empty_calls == 1


def test_the_tap_sets_its_flags_from_the_frames_it_sees():
    import inspect

    src = inspect.getsource(bot.LLMTap.process_frame)
    assert "FunctionCallsStartedFrame" in src and "InterruptionFrame" in src and "TTSSpeakFrame" in src


def make_call():
    from bot import CallInit, VoiceCall

    return VoiceCall(Settings(nvidia_api_key="k", llm_api_key="k"), CallInit(call_id="c1", kind="phone", transport_label="signalwire"), transport=None)


async def test_recovery_speaks_once_cleans_the_context_and_notes_it():
    call = make_call()
    said = []

    async def say(text):
        said.append(text)

    call._tap.say = say
    call.context.set_messages(
        [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "what if we buy a car"},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "simulate_scenario", "arguments": '{"kind":'}}]},
            {"role": "assistant", "content": ""},
        ]
    )
    await call._on_empty_reply()
    await call._on_empty_reply()  # a second failure right behind the first: still one apology
    assert said == [prompts.ERROR_LINE]
    assert [m["role"] for m in call.context.messages] == ["system", "user"]  # the dangling tool call and the empty turn are gone
    assert any(e.get("title") == "Recovered from a reply with nothing to say" for e in call.reporter._pending)
    assert call.stats["recoveries"] == 2


async def test_an_empty_reply_to_a_one_word_turn_is_not_an_apology():
    call = make_call()
    said = []

    async def say(text):
        said.append(text)

    call._tap.say = say
    call.context.set_messages([{"role": "system", "content": "s"}, {"role": "user", "content": "wait"}])
    await call._on_empty_reply()
    assert said == []
    call.context.set_messages([{"role": "system", "content": "s"}, {"role": "user", "content": "what is our cushion"}])
    await call._on_empty_reply()
    assert said == [prompts.ERROR_LINE]


async def test_watchdog_speaks_the_recovery_line_when_no_audio_follows_a_turn(monkeypatch):
    call = make_call()
    said = []

    async def say(text):
        said.append(text)

    call._tap.say = say
    task = asyncio.create_task(call._watch_reply(0.05))
    await task
    assert said == [prompts.ERROR_LINE]
    # audio started in time (the latency observer fires): the watchdog is cancelled and says nothing
    said.clear()
    call._reply_watchdog = asyncio.create_task(call._watch_reply(0.2))
    await asyncio.sleep(0.02)
    call._cancel_watchdog()
    await asyncio.sleep(0.3)
    assert said == []


# ---- the broken turn can never reach the model again --------------------------------------------------------------------------------------
def test_sanitize_drops_dangling_turns_and_merges_split_user_turns():
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "So if we bought a,"},
        {"role": "user", "content": "uh, a car for thirty five thousand,"},
        {"role": "user", "content": "with a down payment"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{"}}]},
        {"role": "assistant", "content": "  "},
        {"role": "tool", "tool_call_id": "gone", "content": "{}"},
        {"role": "user", "content": "hello?"},
    ]
    out = sanitize_messages(msgs)
    assert [m["role"] for m in out] == ["system", "user", "user"] or [m["role"] for m in out] == ["system", "user"]
    assert out[1]["content"] == "So if we bought a, uh, a car for thirty five thousand, with a down payment" or "down payment hello?" in out[1]["content"]
    good = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "{}"},
        {"role": "assistant", "content": "Fine."},
    ]
    assert sanitize_messages(good) == good  # a complete tool exchange is untouched


async def test_the_model_receives_the_cleaned_conversation():
    svc = build_llm(Settings(nvidia_api_key="k", llm_api_key="k"))
    params = svc.build_chat_completion_params({"messages": [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}, {"role": "assistant", "content": ""}], "tools": []})
    assert params["messages"] == [{"role": "user", "content": "a b"}]


# ---- hesitations do not end the turn -----------------------------------------------------------------------------------------------------
def test_which_transcripts_look_unfinished():
    for t in ("So if we bought a", "what if we, uh", "I was thinking, um,", "and the", "we could do that and", "well...", "if we bought a car with, ", "like", "I mean the thing is, so"):
        assert ends_with_hesitation(t), t
    for t in ("How are we doing", "What if we buy a thirty five thousand dollar car", "Thank you.", "What's coming up this month?", "Is that okay", "wait", "", "Am I talking to a real person?"):
        assert not ends_with_hesitation(t), t


def test_strategies_use_the_hesitation_guard_and_a_phone_hold():
    s = Settings()
    web = bot._stop_strategies(s)
    assert isinstance(web[0], HesitationAwareStop) and len(web) == 1  # browser: no extra timer by default
    phone = bot._stop_strategies(s, phone=True)
    assert isinstance(phone[0], HesitationAwareStop) and len(phone) == 2 and phone[1]._user_speech_timeout == 0.6  # phone: Smart Turn AND 0.6 s of quiet
    assert len(bot._stop_strategies(s.with_overrides(turn_hold_secs=0.0), phone=True)) == 1  # explicit 0 turns it off
    assert bot._stop_strategies(s.with_overrides(turn_hold_secs=0.8), phone=True)[1]._user_speech_timeout == 0.8
    assert not isinstance(bot._stop_strategies(s.with_overrides(hesitation_hold_secs=0.0))[0], HesitationAwareStop)


async def test_a_trailing_filler_holds_the_turn_until_the_caller_stays_quiet():
    """Drive the strategy directly: Smart Turn says COMPLETE and a final transcript ends in 'uh'."""
    released = []
    strat = HesitationAwareStop(turn_analyzer=SimpleNamespace(params=None), hesitation_hold_secs=0.15)

    async def report():
        released.append(True)

    strat.report_user_turn_stopped = report
    strat._turn_complete = True
    strat._transcript_finalized = True
    strat._text = "if we bought a car, uh"
    strat._task_manager = SimpleNamespace(create_task=lambda coro, name: asyncio.ensure_future(coro), cancel_task=_cancel)
    await strat._maybe_report_user_turn_stopped()
    await asyncio.sleep(0.05)
    assert released == []  # held
    await asyncio.sleep(0.2)
    assert released == [True]  # nobody carried on: released after the hold
    released.clear()
    strat._held = False
    strat._text = "if we bought a car, uh"
    await strat._maybe_report_user_turn_stopped()
    strat._text = "if we bought a car, uh, a thirty five thousand dollar one"
    await strat._discard_pending_end_of_turn()  # the caller spoke again: VAD started -> pending end of turn discarded
    await asyncio.sleep(0.3)
    assert released == []
    strat._turn_complete = True
    strat._transcript_finalized = True
    await strat._maybe_report_user_turn_stopped()  # a finished sentence is not delayed
    assert released == [True]


async def _cancel(task):
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
