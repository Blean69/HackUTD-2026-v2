"""Scripted SmallWebRTC client (aiortc): joins a voice call like the browser button does, plays WAV "questions" to the bot,
records what it says back and prints the RTVI captions, the `run` server message and the latencies it measured.

  python tools/webrtc_client.py --url http://localhost:7860 --household hh_rivera --wav q1.wav [--wav q2.wav] --out reply.wav

Run it with the service's own dependencies (aiortc ships with the pipecat webrtc extra):
  docker run --rm --network host -v $PWD/tools:/tools -v /tmp/voice:/out keystone-voice:dev python /tools/webrtc_client.py ...
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
import wave
from fractions import Fraction

import numpy as np
import soxr
import httpx
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack
from av import AudioFrame

RATE = 48000
FRAME = RATE // 50  # 20 ms


def frame_to_mono(frame) -> np.ndarray:
    """One received av.AudioFrame -> mono int16 samples at the frame's own rate.

    aiortc hands back packed s16 whose channel count follows the negotiated layout (the bot's track arrives as interleaved stereo,
    L R L R ..., shape (1, 2N)). Treating those samples as mono doubles the clip and drops the pitch an octave, so go by the real
    layout: de-interleave packed audio, take the rows of planar audio, and average the channels."""
    return downmix(frame.to_ndarray(), len(frame.layout.channels), bool(frame.format.is_planar))


def downmix(arr: np.ndarray, channels: int, planar: bool) -> np.ndarray:
    a = np.asarray(arr)
    if planar:  # (channels, samples)
        chans = a.reshape(channels, -1) if a.ndim != 2 else a
    else:  # packed: (1, samples * channels), interleaved
        flat = a.reshape(-1)
        flat = flat[: len(flat) // channels * channels]
        chans = flat.reshape(-1, channels).T
    if chans.shape[0] == 1:
        return chans[0].astype(np.int16)
    return np.round(chans.astype(np.int32).mean(axis=0)).astype(np.int16)


def read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2 and w.getnchannels() == 1, "mono 16-bit WAV please"
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        return soxr.resample(pcm, w.getframerate(), RATE).astype(np.int16)


class ScriptedMic(MediaStreamTrack):
    kind = "audio"

    def __init__(self) -> None:
        super().__init__()
        self._buf = np.zeros(0, dtype=np.int16)
        self._pts = 0
        self._t0: float | None = None
        self.play_ends_at: float | None = None

    def play(self, pcm: np.ndarray) -> None:
        self._buf = np.concatenate([self._buf, pcm])
        self.play_ends_at = time.monotonic() + len(self._buf) / RATE

    async def recv(self) -> AudioFrame:
        if self._t0 is None:
            self._t0 = time.monotonic()
        wait = self._t0 + self._pts / RATE - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        chunk, self._buf = self._buf[:FRAME], self._buf[FRAME:]
        if len(chunk) < FRAME:
            chunk = np.concatenate([chunk, np.zeros(FRAME - len(chunk), dtype=np.int16)])
        frame = AudioFrame.from_ndarray(chunk.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = RATE
        frame.pts = self._pts
        frame.time_base = Fraction(1, RATE)
        self._pts += FRAME
        return frame


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:7860")
    ap.add_argument("--household", default="hh_rivera")
    ap.add_argument("--name", default="Test Caller")
    ap.add_argument("--wav", action="append", default=[], help="question WAV (repeat for several turns)")
    ap.add_argument("--out", default="/out/reply.wav")
    ap.add_argument("--max-secs", type=float, default=90)
    ap.add_argument("--linger", type=float, default=2.0, help="seconds to stay on the call after the last answer (use 40 to watch the idle prompt and hang-up)")
    ap.add_argument("--camel", action="store_true", help="send requestData instead of request_data")
    ap.add_argument("--ask-after", type=float, default=None, help="ask the first question this many seconds after the answer arrives instead of waiting for the greeting to finish (a judge who talks over it)")
    args = ap.parse_args()

    t_start = time.monotonic()
    ev: list[dict] = []
    log = lambda kind, **kw: (ev.append({"t": round(time.monotonic() - t_start, 2), "kind": kind, **kw}), print(f"[{ev[-1]['t']:6.2f}s] {kind} {json.dumps(kw)[:240]}", flush=True))
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    mic = ScriptedMic()
    pc.addTrack(mic)
    dc = pc.createDataChannel("chat", ordered=True)

    bot_pcm: list[np.ndarray] = []
    state = {"last_loud": 0.0, "first_loud_after": None, "speaking": False, "run_id": None, "bot_ready": False, "bot_rate": RATE, "bot_first": None, "bot_last": None, "turn": -1}
    texts: dict[int, list[str]] = {}

    @pc.on("track")
    def on_track(track: MediaStreamTrack) -> None:
        async def pump() -> None:
            try:
                while True:
                    f = await track.recv()
                    a = frame_to_mono(f)
                    state["bot_rate"] = int(f.sample_rate or RATE)
                    state["bot_first"] = state["bot_first"] or time.monotonic()
                    state["bot_last"] = time.monotonic()
                    bot_pcm.append(a)
                    rms = float(np.sqrt(np.mean(a.astype(np.float64) ** 2))) if len(a) else 0.0
                    if rms > 300:
                        now = time.monotonic()
                        if state["first_loud_after"] is None:
                            state["first_loud_after"] = now
                        state["last_loud"] = now
            except MediaStreamError:
                pass

        asyncio.create_task(pump())

    def send_rtvi(msg_type: str, data: dict) -> None:
        dc.send(json.dumps({"label": "rtvi-ai", "type": msg_type, "id": uuid.uuid4().hex[:8], "data": data}))

    @dc.on("open")
    def on_open() -> None:
        log("datachannel_open")
        send_rtvi("client-ready", {"version": "1.2.0", "about": {"library": "keystone-scripted-client", "library_version": "0.1", "platform": "aiortc"}})

    @dc.on("message")
    def on_message(raw: str) -> None:
        try:
            m = json.loads(raw)
        except Exception:
            return
        t, d = m.get("type"), m.get("data")
        if t == "bot-ready":
            state["bot_ready"] = True
            log("bot-ready")
        elif t == "server-message":
            log("server-message", data=d)
            if isinstance(d, dict) and d.get("type") == "run":
                state["run_id"] = d.get("run_id")
        elif t == "user-transcription" and d and d.get("final"):
            log("user-transcription", text=d.get("text"))
        elif t in ("bot-output",) and d and d.get("aggregated_by") != "word":
            log("bot-output", text=d.get("text"), spoken=d.get("spoken"))
            seen = texts.setdefault(state["turn"], [])
            txt = str(d.get("text") or "").strip()
            if txt and txt not in seen:  # each sentence arrives twice (announced, then spoken); keep it once
                seen.append(txt)
        elif t == "error":
            log("rtvi-error", data=d)

    await pc.setLocalDescription(await pc.createOffer())
    body = {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type, "pc_id": None, "restart_pc": False}
    body["requestData" if args.camel else "request_data"] = {"household_id": args.household, "display_name": args.name}
    async with httpx.AsyncClient(timeout=20) as http:
        r = await http.post(f"{args.url}/api/offer", json=body)
    if r.status_code != 200:
        log("offer-failed", status=r.status_code, body=r.text[:200])
        raise SystemExit(2)
    ans = r.json()
    log("answer", pc_id=ans.get("pc_id"))
    await pc.setRemoteDescription(RTCSessionDescription(sdp=ans["sdp"], type=ans["type"]))

    async def bot_idle(min_silence: float, first_timeout: float) -> bool:
        """Wait until the bot has spoken and then been quiet for `min_silence`s."""
        t0 = time.monotonic()
        while time.monotonic() - t0 < first_timeout:
            await asyncio.sleep(0.1)
            if state["first_loud_after"] and time.monotonic() - state["last_loud"] > min_silence:
                return True
        return False

    results = []
    deadline = time.monotonic() + args.max_secs
    if args.ask_after is not None:
        await asyncio.sleep(args.ask_after)
        log("asking-over-the-greeting")
    else:
        ok = await bot_idle(1.5, 40)
        log("disclosure-finished" if ok else "disclosure-timeout")
    for i, path in enumerate(args.wav):
        # a fresh turn: forget previous bot audio markers
        state["first_loud_after"] = None
        state["turn"] = i
        pcm = read_wav(path)
        pcm = np.concatenate([np.zeros(RATE // 2, dtype=np.int16), pcm, np.zeros(RATE // 2, dtype=np.int16)])
        t_play = time.monotonic()
        mic.play(pcm)
        speech_end = t_play + (len(pcm) - RATE // 2) / RATE
        log("question-sent", n=i + 1, wav=path.split("/")[-1], secs=round(len(pcm) / RATE, 1))
        while time.monotonic() < deadline and not (state["first_loud_after"] and state["first_loud_after"] > t_play):
            await asyncio.sleep(0.05)
        first = state["first_loud_after"]
        v2v = (first - speech_end) if first and first > t_play else None
        log("bot-started-answer", voice_to_voice_s=None if v2v is None else round(v2v, 2))
        done = await bot_idle(2.0, max(1.0, deadline - time.monotonic()))
        spoken = (state["last_loud"] - first) if first and first > t_play else None  # first to last audible sample: sentences plus the pauses between
        log("bot-finished-answer" if done else "answer-timeout", answer_secs=round(time.monotonic() - (first or t_play), 1), spoken_secs=None if spoken is None else round(spoken, 1))
        results.append({"question": path.split("/")[-1], "voice_to_voice_s": v2v, "spoken_secs": None if spoken is None else round(spoken, 1), "turn": i})

    await asyncio.sleep(args.linger)  # let the last captions and trace events land
    if bot_pcm:
        pcm = np.concatenate(bot_pcm)
        rate = state["bot_rate"]
        with wave.open(args.out, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm.tobytes())
        wav_secs = len(pcm) / rate
        wall = (state["bot_last"] - state["bot_first"]) if state["bot_first"] else 0.0
        log("saved-bot-audio", path=args.out, secs=round(wav_secs, 1), rate=rate, wall_secs=round(wall, 1))
        if wall > 3 and abs(wav_secs - wall) > 0.15 * wall:  # the track is realtime, so the clip must last about as long as the call did
            print(f"WARNING: saved audio is {wav_secs:.1f}s but the bot track ran for {wall:.1f}s of wall clock; the WAV will not play at real speed")
    await pc.close()
    for r in results:
        r["text"] = " ".join(texts.get(r["turn"], []))
        r["words"] = len(r["text"].split())
    print("SUMMARY " + json.dumps({"run_id": state["run_id"], "bot_ready": state["bot_ready"], "turns": results}))


if __name__ == "__main__":
    asyncio.run(main())
