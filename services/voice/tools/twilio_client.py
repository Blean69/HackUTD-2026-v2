"""Scripted phone caller: speaks the Twilio/SignalWire media-stream protocol to /ws, the way a carrier would.
Posts to /twiml first (reads the stream token from the cXML), keys PINs as DTMF, plays WAV questions as 8 kHz mu-law and records the reply.

  python tools/twilio_client.py --url http://127.0.0.1:7861 --pin 0000 --pin 1234 --wav q_coming.wav --out reply_phone.wav
"""
from __future__ import annotations

import argparse
import asyncio
import audioop  # python 3.12
import base64
import json
import re
import time
import wave

import httpx
import numpy as np
import soxr
import websockets


def wav_to_ulaw_frames(path: str) -> list[bytes]:
    with wave.open(path, "rb") as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        y = soxr.resample(pcm, w.getframerate(), 8000).astype(np.int16)
    y = np.concatenate([np.zeros(4000, dtype=np.int16), y, np.zeros(4000, dtype=np.int16)])
    u = audioop.lin2ulaw(y.tobytes(), 2)
    return [u[i : i + 160].ljust(160, b"\xff") for i in range(0, len(u), 160)]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:7861")
    ap.add_argument("--pin", action="append", default=[], help="PIN to key in (repeat to test retries)")
    ap.add_argument("--wav", action="append", default=[])
    ap.add_argument("--out", default="/out/reply_phone.wav")
    ap.add_argument("--from-number", default="+15555550123")
    ap.add_argument("--max-secs", type=float, default=100)
    ap.add_argument("--no-token", action="store_true", help="try the media socket without a valid token (must be refused)")
    args = ap.parse_args()

    async with httpx.AsyncClient(timeout=10) as http:
        r = await http.post(f"{args.url}/twiml", data={"From": args.from_number, "To": "+14695550100", "CallSid": "CAtest" + str(int(time.time()))})
    print("twiml", r.status_code, r.text[:400].replace(args.from_number, "<number>"))
    assert args.from_number not in r.text, "the caller's number must not appear in the cXML"
    params = dict(re.findall(r'<Parameter name="([^"]+)" value="([^"]*)"', r.text))
    ws_url = re.search(r'<Stream url="([^"]+)"', r.text).group(1)
    local_ws = args.url.replace("http", "ws") + "/ws"
    print("stream url in cXML:", ws_url, "| connecting to", local_ws)
    if args.no_token:
        params["token"] = "0.deadbeef"

    stream_sid, call_sid = "MZ" + "a" * 30, params.get("call_sid") or "CAx"
    t0 = time.monotonic()
    out = bytearray()
    st = {"last_loud": 0.0, "first_loud": None}
    marks = []

    async with websockets.connect(local_ws) as ws:
        await ws.send(json.dumps({"event": "connected", "protocol": "Call", "version": "1.0.0"}))
        await ws.send(json.dumps({"event": "start", "sequenceNumber": "1", "streamSid": stream_sid, "start": {"streamSid": stream_sid, "callSid": call_sid, "accountSid": "ACx", "tracks": ["inbound"], "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1}, "customParameters": params}}))
        queue: asyncio.Queue[bytes] = asyncio.Queue()
        closed = asyncio.Event()

        async def sender() -> None:
            n = 0
            nxt = time.monotonic()
            while not closed.is_set():
                try:
                    chunk = queue.get_nowait()
                except asyncio.QueueEmpty:
                    chunk = b"\xff" * 160
                n += 1
                try:
                    await ws.send(json.dumps({"event": "media", "streamSid": stream_sid, "media": {"track": "inbound", "chunk": str(n), "timestamp": str(n * 20), "payload": base64.b64encode(chunk).decode()}}))
                except Exception:
                    return
                nxt += 0.02
                await asyncio.sleep(max(0, nxt - time.monotonic()))

        async def receiver() -> None:
            try:
                async for raw in ws:
                    m = json.loads(raw)
                    if m.get("event") == "media":
                        u = base64.b64decode(m["media"]["payload"])
                        pcm = audioop.ulaw2lin(u, 2)
                        out.extend(pcm)
                        if audioop.rms(pcm, 2) > 250:
                            now = time.monotonic()
                            st["first_loud"] = st["first_loud"] or now
                            st["last_loud"] = now
                    else:
                        marks.append(m.get("event"))
                        print(f"[{time.monotonic()-t0:6.2f}s] bot event: {m.get('event')}")
            except websockets.ConnectionClosed as e:
                print(f"[{time.monotonic()-t0:6.2f}s] socket closed by the service: code={e.code}")
            finally:
                closed.set()

        tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]

        async def bot_idle(quiet: float, timeout: float) -> bool:
            t = time.monotonic()
            st["first_loud"] = None
            while time.monotonic() - t < timeout and not closed.is_set():
                await asyncio.sleep(0.1)
                if st["first_loud"] and time.monotonic() - st["last_loud"] > quiet:
                    return True
            return False

        if args.no_token:
            await asyncio.wait_for(closed.wait(), 10)
            return
        ok = await bot_idle(1.5, 40)
        print(f"[{time.monotonic()-t0:6.2f}s] disclosure {'finished' if ok else 'TIMEOUT'} ({len(out)/16000:.1f}s of audio so far)")
        for pin in args.pin:
            for d in pin:
                await ws.send(json.dumps({"event": "dtmf", "streamSid": stream_sid, "dtmf": {"track": "inbound_track", "digit": d}}))
                await asyncio.sleep(0.15)
            print(f"[{time.monotonic()-t0:6.2f}s] keyed a {len(pin)}-digit PIN")
            ok = await bot_idle(1.5, 25)
            print(f"[{time.monotonic()-t0:6.2f}s] bot replied ({'ok' if ok else 'nothing'}); socket {'closed' if closed.is_set() else 'open'}")
            if closed.is_set():
                break
        for path in args.wav:
            if closed.is_set():
                break
            frames = wav_to_ulaw_frames(path)
            speech_end = time.monotonic() + (len(frames) * 0.02 - 0.25)
            for f in frames:
                queue.put_nowait(f)
            print(f"[{time.monotonic()-t0:6.2f}s] question sent: {path.split('/')[-1]}")
            st["first_loud"] = None
            while not closed.is_set() and time.monotonic() < t0 + args.max_secs and not (st["first_loud"] and st["first_loud"] > speech_end - 1.0):
                await asyncio.sleep(0.05)
            if st["first_loud"]:
                print(f"[{time.monotonic()-t0:6.2f}s] voice-to-voice (client view): {st['first_loud'] - speech_end:.2f}s")
            ok = await bot_idle(2.0, max(2, t0 + args.max_secs - time.monotonic()))
            print(f"[{time.monotonic()-t0:6.2f}s] bot finished answering: {ok}")
        closed.set()
        for t in tasks:
            t.cancel()
    with wave.open(args.out, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000); w.writeframes(bytes(out))
    print(f"saved {len(out)/16000:.1f}s of bot audio to {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
