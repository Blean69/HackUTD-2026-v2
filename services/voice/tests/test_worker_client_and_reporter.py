import json

import httpx
import pytest

from reporter import TraceReporter
from worker_client import WorkerClient, WorkerError


def client_for(handler) -> WorkerClient:
    return WorkerClient("http://worker.test", "sekrit", transport=httpx.MockTransport(handler))


async def test_sends_the_secret_header_and_json():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["secret"] = req.headers.get("x-voice-secret")
        seen["path"] = req.url.path
        seen["body"] = json.loads(req.content) if req.content else None
        return httpx.Response(200, json={"ok": True, "household_id": "hh_rivera"})

    c = client_for(handler)
    r = await c.identify("call-1", "hash", "1234")
    assert r["household_id"] == "hh_rivera"
    assert seen == {"secret": "sekrit", "path": "/phone/identify", "body": {"call_id": "call-1", "caller_hash": "hash", "pin": "1234"}}


async def test_errors_carry_status_and_code_and_5xx_is_retried_for_safe_calls():
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if req.url.path == "/phone/tools":
            return httpx.Response(503, json={"error": "spacetime_unavailable"}) if calls["n"] == 1 else httpx.Response(200, json=[{"name": "get_forecast"}])
        return httpx.Response(404, json={"error": "unknown_run", "detail": "gone"})

    c = client_for(handler)
    assert await c.tools() == [{"name": "get_forecast"}]
    with pytest.raises(WorkerError) as e:
        await c.tool("run_x", "get_forecast", {})
    assert e.value.status == 404 and e.value.code == "unknown_run"


async def test_unreachable_worker_raises_and_end_never_does():
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    c = client_for(handler)
    with pytest.raises(WorkerError) as e:
        await c.start(call_id="x", household_id="hh")
    assert e.value.code == "unreachable"
    assert await c.end("run_x", "hangup") == {}


async def test_reporter_holds_events_until_the_run_exists_then_batches():
    batches = []

    def handler(req: httpx.Request) -> httpx.Response:
        batches.append(json.loads(req.content))
        return httpx.Response(200, json={"ok": True})

    rep = TraceReporter(client_for(handler), flush_secs=0.05)
    rep.note("PIN verified on the keypad", caller="new")
    await rep.flush()
    assert batches == []  # no run yet
    rep.set_run("run_1")
    rep.heard("how are we doing")
    rep.said("You're fine.", model="m", asr_ms=0.21, llm_ms=0.19, tts_ms=0.17, v2v_ms=1.4, interrupted=False, voice="Mia")
    await rep.flush()
    assert len(batches) == 1 and batches[0]["run_id"] == "run_1"
    ev = batches[0]["events"]
    assert [e["kind"] for e in ev] == ["note", "heard", "said"]
    assert ev[2]["v2v_ms"] == 1400 and ev[2]["asr_ms"] == 210 and "interrupted" not in ev[2]  # seconds -> ms, Nones dropped
    rep.start()
    rep.heard("again")
    await rep.stop()  # drains on stop
    assert batches[-1]["events"][0]["text"] == "again"


async def test_reporter_swallows_worker_errors():
    rep = TraceReporter(client_for(lambda r: httpx.Response(500, json={"error": "x"})), flush_secs=0.05)
    rep.set_run("run_1")
    rep.heard("hello")
    await rep.flush()  # must not raise
