"""Stall-injecting proxy for an OpenAI-compatible endpoint: reproduces the hosted API's random stalls on demand so the voice service's hedging
and failover can be tried (and demoed) without waiting for a real one. Everything else passes through to the real endpoint untouched.

  docker run --rm --network host -v $PWD/tools:/tools keystone-voice:dev python /tools/stall_proxy.py --port 9090 --p 0.35 --secs 15
  VOICE_LLM_BASE_URL=http://127.0.0.1:9090/v1  (the voice service then talks to the proxy; the key is forwarded as is)

Each STREAMING chat completion is stalled with probability --p: `first` holds the request for --secs before forwarding it (a first-token
stall, like the 38 s one on the live call), `mid` forwards the first chunk and then pauses --secs (the voice sits on a half sentence).
--mode mixed picks one of the two at random. --seed makes the pattern repeatable. Prints one line per stalled request."""
from __future__ import annotations

import argparse
import asyncio
import json
import random

import aiohttp
from aiohttp import web


def make_app(upstream: str, p: float, secs: float, mode: str, seed: int) -> web.Application:
    rng = random.Random(seed)
    state = {"n": 0}

    async def handle(request: web.Request) -> web.StreamResponse:
        body = await request.read()
        stream = False
        if request.method == "POST" and body:
            try:
                stream = bool(json.loads(body).get("stream"))
            except ValueError:
                pass
        stall = None
        if stream and request.path.endswith("/chat/completions"):
            state["n"] += 1
            if rng.random() < p:
                stall = mode if mode != "mixed" else rng.choice(["first", "first", "mid"])
                print(f"[stall-proxy] request #{state['n']}: {stall} stall of {secs:.0f} s", flush=True)
        if stall == "first":
            await asyncio.sleep(secs)
        headers = {k: v for k, v in request.headers.items() if k.lower() in ("authorization", "content-type", "accept")}
        async with aiohttp.ClientSession() as s, s.request(request.method, upstream.rstrip("/") + request.path_qs, data=body or None, headers=headers) as r:
            resp = web.StreamResponse(status=r.status, headers={"Content-Type": r.headers.get("Content-Type", "application/json")})
            await resp.prepare(request)
            first = True
            try:
                async for chunk in r.content.iter_any():
                    await resp.write(chunk)
                    if first and stall == "mid":
                        await asyncio.sleep(secs)
                    first = False
                await resp.write_eof()
            except (ConnectionResetError, asyncio.CancelledError):  # the voice service dropped this request (it hedged, or the caller spoke over it)
                pass
            return resp

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", handle)
    return app


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9090)
    ap.add_argument("--upstream", default="https://integrate.api.nvidia.com")
    ap.add_argument("--p", type=float, default=0.35, help="chance that a streaming chat completion is stalled")
    ap.add_argument("--secs", type=float, default=15.0)
    ap.add_argument("--mode", choices=["first", "mid", "mixed"], default="mixed")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    web.run_app(make_app(a.upstream, a.p, a.secs, a.mode, a.seed), host="127.0.0.1", port=a.port, print=lambda *_: None)
