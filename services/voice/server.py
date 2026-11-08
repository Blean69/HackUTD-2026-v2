"""Keystone voice service: FastAPI in front of the Pipecat pipeline.

  POST  /api/offer   browser WebRTC signalling (Pipecat SmallWebRTC request/response JSON; request data = {household_id, display_name})
  PATCH /api/offer   trickle ICE candidates
  POST  /twiml       SignalWire/Twilio voice webhook -> cXML <Connect><Stream url="wss://<host>/voice/ws">
  WS    /ws          Twilio-format media stream (SignalWire speaks the same protocol)
  GET   /health

Caddy mounts this service at /voice (prefix stripped); in production it runs with host networking so WebRTC can use the
host's UDP ports."""
from __future__ import annotations

import asyncio
import json
import secrets
import time
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import IceCandidate, SmallWebRTCPatchRequest, SmallWebRTCRequest, SmallWebRTCRequestHandler
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport

import prompts
import acks
from bot import CallInit, VoiceCall, fetch_tools
from config import Settings, load_env, load_settings
from ice import parse_ice_servers
from llm import build_providers
from tts import choose_tts, resolve_elevenlabs_voice
from worker_client import WorkerClient
from twiml import build_twiml, caller_hash, make_stream_token, say_and_hangup, url_variants, valid_stream_token, verify_webhook

SAFE = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-")


def _safe_id(raw: str, prefix: str) -> str:
    keep = "".join(c for c in (raw or "") if c in SAFE)[:80]
    return keep or f"{prefix}-{secrets.token_hex(6)}"


async def _form_fields(request: Request, raw: bytes) -> dict[str, str]:
    """The webhook's fields as strings, parsed from the bytes already read (urlencoded form; a JSON object is accepted too)."""
    try:
        ctype = request.headers.get("content-type", "")
        if "json" in ctype:
            data = json.loads(raw or b"{}")
            return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
        return {k: str(v) for k, v in (await request.form()).items()}
    except Exception:
        return {}


async def _keep_warm(s: Settings) -> None:
    """Things a call would otherwise wait for at its start, kept ready in the background: the ElevenLabs voice probe (cached for 10 min, one
    HTTP round trip) and the worker's tool list (cached for 5 min). Refreshed before they expire; failures are ignored (the call does its own)."""
    client = WorkerClient(s.worker_url, s.shared_secret, timeout=5.0)
    try:
        tick = 0
        while True:
            engine = choose_tts(s, phone=False)
            if engine.provider == "elevenlabs" and tick % 2 == 0:  # every 8 min; the probe's cache lives 10
                try:
                    await resolve_elevenlabs_voice(s.elevenlabs_api_key, engine.model, engine.voice, ttl=0)
                except Exception:
                    pass
            try:
                await fetch_tools(client, max_age=0)
            except Exception:
                pass
            if s.acks and tick == 0:  # render the acknowledgement clips once per voice, for the browser rate and the phone rate
                for phone in (False, True):
                    try:
                        choice = choose_tts(s, phone=phone)
                        if choice.provider == "elevenlabs":  # the voice the call will really use (probe result is cached just above)
                            picked = await resolve_elevenlabs_voice(s.elevenlabs_api_key, choice.model, choice.voice)
                            if not picked:
                                choice = choose_tts(s.with_overrides(tts_provider="magpie"), phone=phone)
                            else:
                                choice = type(choice)(choice.provider, choice.model, picked[0], choice.sample_rate, choice.warnings)
                        await acks.ensure_clips(s, choice)
                    except Exception:
                        pass
            tick += 1
            await asyncio.sleep(240)
    finally:
        await client.aclose()


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or load_settings()
    active: dict[str, asyncio.Task] = {}  # call_id -> bot task
    handler_holder: dict[str, SmallWebRTCRequestHandler] = {}

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        ice = [IceServer(**d) for d in parse_ice_servers(s.ice_servers)]
        handler_holder["h"] = SmallWebRTCRequestHandler(ice_servers=ice or None)
        engine = choose_tts(s, phone=False)
        for w in engine.warnings:
            logger.warning(w)
        logger.info(f"voice service up: transports={s.transports} ice={[i.urls for i in ice]} worker={s.worker_url} tts={engine.provider}:{engine.model}:{engine.voice or 'auto'} llm={s.llm_model} smart_turn={s.smart_turn} llm_chain={[p.key + ':' + p.model for p in build_providers(s)[0]]} hedge={s.llm_hedge_secs}s retry={s.llm_retry_secs}s cap={s.llm_timeout_secs}s")
        if not s.shared_secret:
            logger.warning("VOICE_SHARED_SECRET is not set: the worker will refuse every /phone/* call")
        if not s.signature_token:
            logger.warning("SIGNALWIRE_SIGNING_KEY is empty: /twiml does not verify the webhook signature (the media socket still needs the signed stream token)")
        if not s.nvidia_api_key:
            logger.warning("no NVIDIA_VOICE_API_KEY / NVIDIA_API_KEY: speech and the LLM will fail")
        warm = asyncio.create_task(_keep_warm(s), name="keep-warm")
        yield
        warm.cancel()
        for t in list(active.values()):
            t.cancel()
        await handler_holder["h"].close()

    app = FastAPI(title="keystone-voice", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_methods=["GET", "POST", "PATCH", "OPTIONS"], allow_headers=["*"], max_age=600)

    def spawn(call: VoiceCall) -> None:
        cid = call.init.call_id

        async def _run() -> None:
            try:
                await call.run()
            except Exception:
                logger.exception(f"call {cid} crashed")
            finally:
                active.pop(cid, None)

        active[cid] = asyncio.create_task(_run(), name=f"call-{cid}")

    # ---- health -----------------------------------------------------------------------------------------------------------
    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "service": "keystone-voice",
            "enabled": s.enabled,
            "transports": s.transports,
            "active_calls": len(active),
            "max_sessions": s.max_sessions,
            "tts_provider": choose_tts(s, phone=False).provider,  # the engine a call will start with (a key the engine rejects falls back to magpie at call time)
            "tts_voice": s.tts_voice if choose_tts(s, phone=False).provider == "magpie" else choose_tts(s, phone=False).voice or "auto",
            "llm_model": s.llm_model,
            "llm_chain": [{"provider": p.key, "model": p.model} for p in build_providers(s)[0]],  # the Nemotron models a turn can fail over through, in order
            "worker": s.worker_url,
            "nvidia_key": bool(s.nvidia_api_key),
            "worker_secret": bool(s.shared_secret),
            "phone_line": bool(s.signalwire_number),
        }

    # ---- browser: SmallWebRTC ----------------------------------------------------------------------------------------------
    @app.post("/api/offer")
    async def offer(request: Request) -> dict[str, str] | None:
        if not s.enabled or "webrtc" not in s.transports:
            raise HTTPException(503, "voice is switched off")
        try:
            body = await request.json()
            req = SmallWebRTCRequest.from_dict(dict(body))
        except Exception:
            raise HTTPException(400, "body must be a SmallWebRTC offer: {sdp, type, pc_id?, restart_pc?, request_data?}")
        data = req.request_data if isinstance(req.request_data, dict) else {}
        household_id = str(data.get("household_id") or "").strip()
        display_name = str(data.get("display_name") or "").strip()[:60]
        reconnect = bool(req.pc_id)
        if not reconnect:
            if not household_id:
                raise HTTPException(400, "request_data.household_id is required")
            if len(active) >= s.max_sessions:
                raise HTTPException(429, "all voice lines are busy, try again in a minute")

        async def on_connection(connection: SmallWebRTCConnection) -> None:
            call_id = _safe_id(f"web-{connection.pc_id}", "web")
            transport = SmallWebRTCTransport(webrtc_connection=connection, params=TransportParams(audio_in_enabled=True, audio_out_enabled=True))
            init = CallInit(call_id=call_id, kind="webrtc", transport_label="webrtc", household_id=household_id, display_name=display_name)
            spawn(VoiceCall(s, init, transport))

        return await handler_holder["h"].handle_web_request(request=req, webrtc_connection_callback=on_connection)

    @app.patch("/api/offer")
    async def ice_candidate(request: Request) -> dict[str, str]:
        try:
            b = await request.json()
            patch = SmallWebRTCPatchRequest(
                pc_id=b["pc_id"],
                candidates=[IceCandidate(candidate=c.get("candidate", ""), sdp_mid=c.get("sdp_mid", c.get("sdpMid", "")), sdp_mline_index=c.get("sdp_mline_index", c.get("sdpMLineIndex", 0))) for c in b.get("candidates", [])],
            )
        except Exception:
            raise HTTPException(400, "bad ICE candidate patch")
        await handler_holder["h"].handle_patch_request(patch)
        return {"status": "success"}

    # ---- phone: SignalWire / Twilio cXML + media stream --------------------------------------------------------------------
    @app.post("/twiml")
    async def twiml(request: Request) -> Response:
        raw = await request.body()  # the signature covers the RAW body: read it before anything parses the form
        form = await _form_fields(request, raw)
        public_url = f"https://{s.public_hostname}{s.public_path}/twiml"
        if s.signature_token:
            urls = url_variants(public_url, request.url.query)
            ok, info = verify_webhook(s.signature_token, urls, raw, form, request.headers)
            if not ok:
                logger.warning(f"rejected a /twiml request with a bad signature: headers present={info['headers'] or 'none'}, url variants tried={info['variants']}, body bytes={len(raw)}")
                return Response("invalid signature", status_code=403)
            logger.info(f"/twiml signature ok ({info['scheme']})")
        if not s.enabled or "twilio" not in s.transports:
            return Response(say_and_hangup(prompts.LINE_CLOSED), media_type="text/xml")
        ws_url = f"wss://{s.public_hostname}{s.public_path}/ws"
        params = {
            "token": make_stream_token(s.shared_secret),  # the media socket only accepts streams started from here
            "call_sid": form.get("CallSid", ""),
            "caller_hash": caller_hash(s.caller_hash_salt, form.get("From", "")),  # never the number itself
        }
        return Response(build_twiml(ws_url, params), media_type="text/xml")

    @app.websocket("/ws")
    async def media_stream(ws: WebSocket) -> None:
        await ws.accept()
        start: dict[str, Any] | None = None
        try:
            for _ in range(4):
                msg = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=5))
                if msg.get("event") == "start":
                    start = msg["start"]
                    break
        except Exception as e:
            logger.warning(f"media stream handshake failed: {e}")
        params = (start or {}).get("customParameters") or {}
        if not start or not valid_stream_token(s.shared_secret, params.get("token")):
            logger.warning("rejected a media stream without a valid token")
            await ws.close(code=1008)
            return
        if not s.enabled or len(active) >= s.max_sessions:
            logger.warning("media stream refused (disabled or busy)")
            await ws.close(code=1013)
            return
        stream_sid, call_sid = start.get("streamSid", ""), start.get("callSid") or params.get("call_sid", "")
        call_id = _safe_id(f"tel-{call_sid or stream_sid}", "tel")
        serializer = TwilioFrameSerializer(stream_sid=stream_sid, call_sid=call_sid or None, params=TwilioFrameSerializer.InputParams(auto_hang_up=False))
        transport = FastAPIWebsocketTransport(websocket=ws, params=FastAPIWebsocketParams(audio_in_enabled=True, audio_out_enabled=True, add_wav_header=False, serializer=serializer))
        ch = params.get("caller_hash", "")
        init = CallInit(call_id=call_id, kind="phone", transport_label="signalwire", caller_hash=ch, caller="known" if ch and ch in s.known_caller_hashes else "new")
        call = VoiceCall(s, init, transport)
        spawn(call)
        task = active.get(call_id)
        if task:
            await asyncio.shield(asyncio.wait([task]))  # keep the socket handler alive for the life of the call

    return app




def main() -> None:
    load_env()
    s = load_settings()
    uvicorn.run(create_app(s), host=s.host, port=s.port, log_level="info", ws_ping_interval=None)


if __name__ == "__main__":
    main()
