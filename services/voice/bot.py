"""One Pipecat pipeline for both transports (browser SmallWebRTC and the phone/SignalWire media stream).

   transport.input -> [PinGate: phone only] -> Nemotron ASR -> user aggregator (Silero VAD, Smart Turn, barge-in) -> Lightning LLM
   -> LLMTap -> Magpie TTS -> transport.output -> assistant aggregator

The worker owns the agent run: /phone/start creates the traced agent_run, /phone/tool runs the tools, /phone/trace takes the
"Heard" / "Said" lines and /phone/end closes the run. This module only wires audio, dialogue and those calls together."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

from loguru import logger

from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame, EndFrame, Frame, FunctionCallsStartedFrame, InterruptionFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame, MetricsFrame, TTSSpeakFrame
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIProcessor, RTVIServerMessageFrame
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.nvidia.stt import NvidiaSTTService
from pipecat.transports.base_transport import BaseTransport
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy, TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

import acks
import alerts
import prompts
from barge import BargeControl, EchoAwareStart, PttAwareStop, PttAwareTimeout
from config import Settings
from llm import build_llm, sanitize_messages
from pacing import SentenceCap
from pin_gate import PinGate, PinOutcome
from reporter import TraceReporter
from speech import SpeechNormalizer
from tts import TTSChoice, build_tts
from turns import HesitationAwareStop
from worker_client import WorkerClient, WorkerError

_tools_cache: tuple[float, list[dict]] | None = None
ACK_DELAY_SECS = 0.25  # an acknowledgement waits this long for the real answer to start before it plays
REPLY_WATCHDOG_SECS = 6.0  # a caller turn that has produced no audio after this long gets the recovery line


@dataclass
class CallInit:
    call_id: str
    kind: str  # "webrtc" | "phone"
    transport_label: str  # webrtc | twilio | signalwire
    household_id: str = ""  # webrtc: from the offer's request data
    display_name: str = ""
    caller_hash: str = ""
    caller: str = "new"  # known | new | callback (never the number itself)
    call_sid: str = ""  # SignalWire's CallSid; only used to look up the number held for a possible callback
    callback: Any = None  # callback.CallbackPlan when Brian placed this call (already unlocked: no PIN gate)
    may_ring_back: bool = False  # a phone call a callback can follow: every goodbye says Brian might ring back
    noise_filter: str = "off"  # what the input noise filter is for this call ("rnnoise" | "off"), for the run's stats


async def fetch_tools(client: WorkerClient, max_age: float = 300) -> list[dict]:
    """The phone tool specs come from the worker (one registry, schemas never duplicated); cached for 5 minutes (max_age=0 forces a refresh)."""
    global _tools_cache
    now = time.monotonic()
    if _tools_cache and now - _tools_cache[0] < max_age:
        return _tools_cache[1]
    try:
        specs = await client.tools()
        _tools_cache = (now, specs)
        return specs
    except WorkerError:
        if _tools_cache:
            return _tools_cache[1]
        raise


def to_tools_schema(specs: list[dict]) -> ToolsSchema:
    out = []
    for s in specs:
        p = s.get("parameters") or {}
        out.append(FunctionSchema(name=s["name"], description=s.get("description", ""), properties=p.get("properties", {}), required=p.get("required", [])))
    return ToolsSchema(standard_tools=out)


def _stop_strategies(s: Settings, phone: bool = False, barge: BargeControl | None = None) -> list:
    """Smart Turn v3 decides when the caller is finished (a timer alone cuts people off at a pause), with two guards against a hesitant caller
    being split into several turns: a transcript that trails off ("uh", "so", "and the") gets `hesitation_hold_secs` more (turns.py), and
    `turn_hold_secs` > 0 adds a timer that must ALSO have run out (pipecat's default stop_mode is ALL), so a one-word "wait" followed by a
    breath is not taken as a whole turn. turn_hold_secs unset = 0.6 s on the phone (long pauses, 8 kHz audio), none in the browser.
    With `barge` the strategies also end the turn at once when the browser's hold-to-talk button is released (barge.py)."""
    if not s.smart_turn:
        return [SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.8)]
    analyzer = LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=s.smart_turn_stop_secs))
    if barge is not None:  # a live call: the same strategies, plus the talk button's "I'm done"
        first = PttAwareStop(turn_analyzer=analyzer, hesitation_hold_secs=max(0.0, s.hesitation_hold_secs))
    else:
        first = HesitationAwareStop(turn_analyzer=analyzer, hesitation_hold_secs=s.hesitation_hold_secs) if s.hesitation_hold_secs > 0 else TurnAnalyzerUserTurnStopStrategy(turn_analyzer=analyzer)
    stops: list = [first]
    hold = s.turn_hold_secs if s.turn_hold_secs is not None else (0.6 if phone else 0.0)
    if hold > 0:
        stops.append((PttAwareTimeout if barge is not None else SpeechTimeoutUserTurnStopStrategy)(user_speech_timeout=hold))
    if barge is not None:
        barge.stops = [x for x in stops if hasattr(x, "force_end")]
    return stops


class LLMTap(FrameProcessor):
    """Sits after the LLM: remembers whether the model already said something this turn (so a filler is not stacked on top of it),
    the token usage of the last completion, and enforces the spoken-turn cap (SentenceCap: once a turn has said enough, the current
    sentence is allowed to finish and the rest of the reply is dropped before it reaches the voice)."""

    def __init__(self, max_words: int = 32, on_empty: Any = None, **kw: Any):
        super().__init__(**kw)
        self.cap = SentenceCap(max_words=max_words)
        self.on_empty = on_empty  # async callable: a reply finished with nothing for the caller to hear (see process_frame)
        self._saw_call = False
        self._interrupted = False
        self._line = False
        self.capped_turns = 0
        self.spoke = False
        self.tokens_in = 0
        self.tokens_out = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InterruptionFrame):
            self._interrupted = True
        elif isinstance(frame, FunctionCallsStartedFrame):
            self._saw_call = True
        elif isinstance(frame, TTSSpeakFrame):
            self._line = True  # a fixed line (the LLM service's apology, a filler) is already on its way to the caller
        elif isinstance(frame, LLMFullResponseStartFrame):
            self.spoke = False
            self._saw_call = self._interrupted = self._line = False
            self.cap.reset()
        elif isinstance(frame, LLMTextFrame):
            if not self.cap.allow(frame.text):
                if self.cap.closed and self.cap.words and not getattr(self, "_logged_cap", False):
                    self._logged_cap = True
                    self.capped_turns += 1
                    logger.info(f"turn cap: dropped the rest of a long reply after {self.cap.words} words")
                return
            if frame.text.strip():
                self.spoke = True
        elif isinstance(frame, LLMFullResponseEndFrame):
            self._logged_cap = False
            if self.on_empty and not (self.spoke or self._saw_call or self._interrupted or self._line):
                await self.push_frame(frame, direction)
                await self.on_empty()  # empty, malformed or truncated reply: nothing was said and no tool is running
                return
        elif isinstance(frame, MetricsFrame):
            for d in frame.data:
                usage = getattr(d, "value", None)
                if usage is not None and hasattr(usage, "prompt_tokens"):
                    self.tokens_in, self.tokens_out = int(usage.prompt_tokens or 0), int(usage.completion_tokens or 0)
        await self.push_frame(frame, direction)


    async def say(self, text: str) -> None:
        """Speak a fixed line from HERE (after the LLM), so it is not queued behind a request that is still in flight."""
        await self.push_frame(TTSSpeakFrame(text, append_to_context=False))


class AckPlayer(FrameProcessor):
    """Sits between the TTS and the transport. Everything passes through; play() puts a pre-rendered clip straight on the wire (no TTS, no LLM)."""

    def __init__(self, on_speech: Any = None, **kw: Any):
        super().__init__(**kw)
        self._n = 0
        self.on_speech = on_speech  # called (sync) when REAL speech audio (not an acknowledgement clip) goes past
        self.tts_ttfb: float | None = None  # last TTS time-to-first-byte seen (the latency observer's breakdown is consumed by the acknowledgement)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame) and not str(frame.context_id or "").startswith("ack-") and self.on_speech:
            self.on_speech()
        elif isinstance(frame, MetricsFrame):
            for d in frame.data:
                if d.__class__.__name__ == "TTFBMetricsData" and "TTS" in str(getattr(d, "processor", "")):
                    self.tts_ttfb = float(d.value)
        await self.push_frame(frame, direction)  # a pure pass-through: the TTS audio must reach the transport untouched

    async def play(self, clip: "acks.Clip") -> None:
        self._n += 1
        ctx = f"ack-{self._n}"
        await self.push_frame(TTSStartedFrame(context_id=ctx, append_to_context=False))
        step = clip.rate // 5 * 2  # 200 ms per frame, so an interruption can cut the rest
        for i in range(0, len(clip.pcm), step):
            await self.push_frame(TTSAudioRawFrame(audio=clip.pcm[i : i + step], sample_rate=clip.rate, num_channels=1, context_id=ctx))
        await self.push_frame(TTSStoppedFrame(context_id=ctx))


class VoiceCall:
    def __init__(self, settings: Settings, init: CallInit, transport: BaseTransport, *, client: WorkerClient | None = None):
        self.s = settings
        self.init = init
        self.transport = transport
        self.client = client or WorkerClient(settings.worker_url, settings.shared_secret)
        self._owns_client = client is None
        self.reporter = TraceReporter(self.client)
        self.run_id: str | None = None
        self.family = ""
        self.unlocked = False  # a phone call that passed the PIN (callbacks only follow those)
        self.household_id = init.household_id
        self.first_name = ""
        self.end_reason = "hangup"
        self.stats: dict[str, Any] = {"transport": init.transport_label, "barge_ins": 0, "turns": 0, "tts_voice": settings.tts_voice}
        self._idle_prompted = False
        self._run_sent = False
        self._rtvi_ready = False
        self._activated = asyncio.Event()
        self._turn: dict[str, Any] = {}
        self._tap = LLMTap(max_words=settings.turn_cap_words, on_empty=self._on_empty_reply)
        self.speech = SpeechNormalizer()  # dates follow the demo's as_of once the run starts
        self.barge = BargeControl(echo_overlap=settings.echo_overlap, grace_secs=settings.echo_grace_secs)
        self.barge.interrupt = self._interrupt_bot
        self.barge.on_echo = self._note_echo
        self.speech.on_spoken = self.barge.spoken.add  # the echo guard compares what is heard with what the voice was just given to say
        self._echo_notes = 0
        self.fillers = prompts.FillerPicker()
        self._filled = False  # one filler per caller turn, even when the model chains two tools
        self.tts_choice: TTSChoice | None = None
        self._tts: Any = None
        self._rtvi: RTVIProcessor | None = None
        self._watchdog: asyncio.Task | None = None
        self._lag_task: asyncio.Task | None = None
        self._keepwarm_task: asyncio.Task | None = None
        self._reply_watchdog: asyncio.Task | None = None
        self._ack = AckPlayer(on_speech=self._on_real_speech)
        self._ack_picker = acks.AckPicker()
        self._ack_clips: list = []
        self._ack_until = 0.0
        self._bot_audible = False
        self._turn_end_t = 0.0
        self._answer_logged = True
        self._last_recovery = 0.0
        self.worker: PipelineWorker | None = None
        self.runner: WorkerRunner | None = None
        self.llm = build_llm(settings, on_event=self._on_llm_event, on_slow=self._slow_line)
        self.context = LLMContext(messages=[{"role": "system", "content": "You are a voice assistant. The caller has not been verified yet; do not discuss anyone's finances."}])

    # ---- lifecycle ------------------------------------------------------------------------------------------------------
    async def run(self) -> str:
        s, init = self.s, self.init
        phone = init.kind == "phone"
        stt = NvidiaSTTService(api_key=s.nvidia_api_key, server=s.asr_server, model_function_map={"function_id": s.asr_function_id, "model_name": "nemotron-asr-streaming"})
        tts, self.tts_choice = await build_tts(s, phone=phone, normalizer=self.speech)
        self._tts = tts
        self.stats["tts_voice"] = self.tts_choice.label
        if s.acks:
            self._ack_clips = acks.cached(self.tts_choice)
            if not self._ack_clips:  # not primed yet (first call after a restart): render in the background, usable from the next turn on
                asyncio.create_task(self._load_acks(), name="ack-clips")
        user_agg, asst_agg = LLMContextAggregatorPair(
            self.context,
            user_params=LLMUserAggregatorParams(
                # Silero only says "quiet for 0.2 s"; the Smart Turn v3 model (local ONNX, CPU, about 9 MB) decides whether the caller is really
                # finished, so a pause mid-thought ("if we bought a... thirty-five thousand dollar car") does not trigger an answer.
                vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=s.vad_stop_secs if s.smart_turn else max(s.vad_stop_secs, 0.5))),
                user_turn_strategies=UserTurnStrategies(
                    # barge-in needs two words (phone) or three (browser) while the bot is talking, and not an echo of what it just said (barge.py)
                    start=[EchoAwareStart(min_words=s.barge_in_words if phone else s.barge_in_words_webrtc, barge=self.barge)],
                    stop=_stop_strategies(s, phone, self.barge),
                ),
                user_idle_timeout=float(s.idle_secs),
            ),
        )

        callback = init.callback if phone else None
        gate = None
        if phone and not callback:  # a callback is already unlocked: the signed token that brought it here is the proof
            gate = PinGate(verify=self._verify_pin, on_unlocked=self._on_pin_ok, on_locked=self._on_pin_locked, pin_length=s.pin_length)
        procs = [self.transport.input(), *( [gate] if gate else [] ), stt, user_agg, self.llm, self._tap, tts, self._ack, self.transport.output(), asst_agg]

        latency = UserBotLatencyObserver()
        rate = {"audio_in_sample_rate": 8000, "audio_out_sample_rate": 8000} if phone else {"audio_in_sample_rate": 16000, "audio_out_sample_rate": 24000}
        kwargs: dict[str, Any] = {}
        if not phone:
            self._rtvi = RTVIProcessor()
            kwargs["rtvi_processor"] = self._rtvi
            kwargs["enable_rtvi"] = True
        else:
            kwargs["enable_rtvi"] = False
        self.worker = PipelineWorker(
            Pipeline(procs),
            params=PipelineParams(enable_metrics=True, enable_usage_metrics=True, **rate),
            observers=[latency],
            idle_timeout_secs=s.max_call_secs + 60,
            **kwargs,
        )
        self.runner = WorkerRunner(handle_sigint=False)
        await self.runner.add_workers(self.worker)

        # ---- events ----------------------------------------------------------------------------------------------------
        @latency.event_handler("on_latency_breakdown")
        async def _breakdown(_obs, b):
            self._on_bot_audible()
            parts = " | ".join(f"{c.label} {c.duration_secs:.2f}s" for c in b.contributions)
            if getattr(b.measured_from, "value", b.measured_from) == "client_connected":
                logger.info(f"greeting started {b.total_secs:.2f}s after the client connected: {parts}")
                return  # the greeting is not a caller turn: keep it out of the voice-to-voice numbers
            m: dict[str, Any] = {"v2v": b.total_secs}
            llm_total = 0.0
            for t in b.ttfb:
                name = t.processor
                if "STT" in name:
                    m["asr"] = t.duration_secs
                elif "LLM" in name:
                    llm_total += t.duration_secs  # a tool turn has two requests; the wait is the sum, not just the last one
                elif "TTS" in name:
                    m["tts"] = t.duration_secs
            if llm_total:
                m["llm"] = llm_total
            self._turn = m
            logger.info(f"turn latency {b.total_secs:.2f}s: {parts}")
            if b.total_secs > 3.5:  # a slow turn explains itself in the trace instead of needing the server log
                self.reporter.note("Slow turn: where the time went", v2v_ms=round(b.total_secs * 1000), parts={c.label: round(c.duration_secs * 1000) for c in b.contributions})

        @user_agg.event_handler("on_user_turn_stopped")
        async def _heard(_agg, _strategy, message):
            text = (message.content or "").strip()
            self._filled = False
            if text:
                self._idle_prompted = False
                self.stats["turns"] += 1
                self.reporter.heard(text)
                logger.info(f"heard: {text}")
                self._cancel_watchdog()
                self._reply_watchdog = asyncio.create_task(self._watch_reply(), name="reply-watchdog")
                self._bot_audible = False
                self._turn_end_t, self._answer_logged = time.monotonic(), False
                if self._ack_clips:
                    asyncio.create_task(self._maybe_ack(), name="ack")

        @asst_agg.event_handler("on_assistant_turn_stopped")
        async def _said(_agg, message):
            text = (message.content or "").strip()
            if not text:
                return
            m, self._turn = self._turn, {}
            if message.interrupted:
                self.stats["barge_ins"] += 1
            served = self.llm.drain_served()  # which Nemotron really answered (a hedge or a failover can change it)
            last = served[-1] if served else {}
            if served and m.get("llm") is None:  # an acknowledgement used up the latency breakdown: take the LLM wait from the service itself
                m["llm"] = sum(x.get("ttfb_ms", 0) for x in served) / 1000
            if m.get("tts") is None and self._ack.tts_ttfb is not None:
                m["tts"] = self._ack.tts_ttfb
            self.reporter.said(text, model=last.get("model") or s.llm_model, provider=last.get("label") or "nvidia", asr_ms=m.get("asr"), llm_ms=m.get("llm"), tts_ms=m.get("tts"), v2v_ms=m.get("v2v"), tokens_in=self._tap.tokens_in or None, tokens_out=self._tap.tokens_out or None, interrupted=message.interrupted, voice=self.tts_choice.label if self.tts_choice else s.tts_voice, tts_model=self.tts_choice.model if self.tts_choice else None, tts_provider=self.tts_choice.provider if self.tts_choice else None)
            logger.info(f"said: {text} (v2v={m.get('v2v')}, llm={m.get('llm')}, tts={m.get('tts')}, model={last.get('model') or s.llm_model}{', hedged' if last.get('hedge_won') else ''}{', failover' if last.get('failover') else ''})")

        @user_agg.event_handler("on_user_turn_started")
        async def _user_started(_agg, _strategy):
            self._cancel_watchdog()  # they are talking again: the answer to the earlier half is being replaced anyway

        @user_agg.event_handler("on_user_turn_idle")
        async def _idle(_agg):
            if not self.run_id:
                return
            if self.init.callback is not None and self.stats["turns"] == 0:
                # nobody has said a word since Brian spoke (not picked up, or voicemail): what he said is the message; do not wait around
                self.end_reason = "callback_no_reply"
                await self._goodbye(prompts.CALLBACK_IDLE_BYE)
            elif not self._idle_prompted:
                self._idle_prompted = True
                await self.worker.queue_frame(TTSSpeakFrame(prompts.IDLE_PROMPT, append_to_context=False))
            else:
                self.end_reason = "idle"
                await self._goodbye(prompts.idle_bye(self.init.may_ring_back))

        @self.transport.event_handler("on_client_connected")
        async def _connected(_t, _client):
            logger.info(f"client connected ({init.transport_label}) call={init.call_id}")
            self.reporter.start()
            if s.llm_warm:
                asyncio.create_task(self.llm.warm(), name="llm-prewarm")  # TLS to every provider while the disclosure plays; never blocks it
                if s.llm_keepwarm_secs > 0:
                    self._keepwarm_task = asyncio.create_task(self.llm.keep_warm(s.llm_keepwarm_secs), name="llm-keepwarm")
            if callback:
                await self.worker.queue_frame(TTSSpeakFrame(prompts.CALLBACK_OPENING, append_to_context=True))
                asyncio.create_task(self._activate_callback(), name="activate-callback")
            elif phone:
                await self.worker.queue_frame(TTSSpeakFrame(prompts.disclosure_phone(s.pin_length, s.pin_variable), append_to_context=False))
            else:
                await self.worker.queue_frame(TTSSpeakFrame(prompts.DISCLOSURE_WEB, append_to_context=False))
                asyncio.create_task(self._activate_web(), name="activate-web")
            self._watchdog = asyncio.create_task(self._max_call_watchdog(), name="call-watchdog")
            self._lag_task = asyncio.create_task(self._loop_lag_monitor(), name="loop-lag")

        @self.transport.event_handler("on_client_disconnected")
        async def _disconnected(_t, _client):
            logger.info(f"client disconnected call={init.call_id}")
            await self.runner.cancel()

        if self._rtvi:

            @self._rtvi.event_handler("on_client_ready")
            async def _rtvi_ready(_p):
                self._rtvi_ready = True
                await self._send_run_message()

            @self._rtvi.event_handler("on_client_message")
            async def _client_message(_p, msg):
                # {type: "ptt", data: {state: enabled|disabled|pressed|released}} and {type: "interrupt"} (docs/contracts.md section 8)
                done = await self.barge.client_message(getattr(msg, "type", ""), getattr(msg, "data", None))
                if done:
                    logger.info(f"client message: {done}")

        try:
            await self.runner.run()
        except Exception as e:  # pragma: no cover - surfaced in the run's final event
            logger.exception("pipeline crashed")
            self.end_reason = f"error: {type(e).__name__}: {e}"[:120]
        finally:
            await self._finish()
        return self.end_reason

    async def _finish(self) -> None:
        for t in (self._watchdog, self._lag_task, self._reply_watchdog, self._keepwarm_task):
            if t:
                t.cancel()
        await self.reporter.stop()
        closer = getattr(getattr(self, "_tts", None), "kv_cleanup", None)
        if closer:
            try:
                await closer()
            except Exception:
                pass
        self.stats["noise_filter"] = self.init.noise_filter
        if any(self.barge.stats.values()):
            self.stats["barge"] = {k: v for k, v in self.barge.stats.items() if v}
        if self.run_id:
            await self.client.end(self.run_id, self.end_reason, self.stats)
        if self._owns_client:
            await self.client.aclose()
        logger.info(f"call {self.init.call_id} finished: {self.end_reason}")

    # ---- LLM hooks: trace notes for the glass box, and one "one moment" line when the first token is late -------------------
    def _on_llm_event(self, kind: str, info: dict[str, Any]) -> None:
        if kind == "hedge":
            self.stats["llm_hedges"] = self.stats.get("llm_hedges", 0) + 1
            self.reporter.note("LLM first token was late: sent a second identical request", provider=info.get("provider"), model=info.get("model"), request=info.get("attempt"), after_ms=info.get("after_ms"))
        elif kind == "failover":
            self.stats["llm_failovers"] = self.stats.get("llm_failovers", 0) + 1
            self.reporter.note("LLM provider failover", to=info.get("provider"), model=info.get("model"), after_ms=info.get("after_ms"), errors=info.get("errors") or None)
        elif kind == "exhausted":
            self.reporter.error("Every LLM provider failed or timed out", detail=info.get("error"))

    def _slow_line(self) -> str | None:
        """Called by the LLM service when the first token is late. At most one filler per caller turn, and never on top of words already spoken."""
        if self._tap.spoke or self._filled:
            return None
        self._filled = True
        line = self.fillers.next()
        self.reporter.note("Spoke a short filler line while the LLM was slow", line=line)
        return line

    def _on_real_speech(self) -> None:
        """The answer itself (not an acknowledgement clip) is going out: the caller is no longer waiting, the watchdog can stand down."""
        if not self._answer_logged:
            self._answer_logged = True
            ms = round((time.monotonic() - self._turn_end_t) * 1000)
            self.stats.setdefault("answer_ms", []).append(ms)
            logger.info(f"answer audio started {ms} ms after the caller's turn was released")
        if not self._bot_audible or self._reply_watchdog:
            self._bot_audible = True
            self._cancel_watchdog()

    def _on_bot_audible(self) -> None:
        self._bot_audible = True
        if time.monotonic() > self._ack_until:  # an acknowledgement is not the answer: the watchdog keeps watching until real speech
            self._cancel_watchdog()

    # ---- barge-in helpers --------------------------------------------------------------------------------------------------------
    async def _interrupt_bot(self) -> None:
        """Stop Brian talking right now (the browser's talk button was pressed over him, or its Interrupt button)."""
        if self._rtvi:
            await self._rtvi.interrupt_bot()
        elif self.worker:
            await self.worker.queue_frame(InterruptionFrame())

    def _note_echo(self, text: str) -> None:
        self._echo_notes += 1
        if self._echo_notes <= 3:  # the glass box says so, a few times per call
            self.reporter.note("Ignored an echo of Brian's own voice (not an interruption)", heard_words=len(text.split()))

    # ---- acknowledgements ---------------------------------------------------------------------------------------------------------
    async def _load_acks(self) -> None:
        try:
            self._ack_clips = await acks.ensure_clips(self.s, self.tts_choice)
        except Exception:  # pragma: no cover
            logger.exception("ack clips")

    async def _maybe_ack(self) -> None:
        """~250 ms after the caller's turn ends, if nothing is audible yet and the reply is not already flowing: a short human "Mm-hm." from the
        pre-rendered bank. Once per turn; it also takes the place of the tool filler (never both)."""
        await asyncio.sleep(ACK_DELAY_SECS)
        if self._bot_audible or self._tap.spoke or self._filled or not self._ack_clips:
            return
        clip = self._ack_picker.pick(self._ack_clips)
        if clip is None:
            return
        self._filled = True
        self._ack_until = time.monotonic() + clip.secs + 0.3
        self.stats["acks"] = self.stats.get("acks", 0) + 1
        await self._ack.play(clip)

    # ---- never a silent bot ---------------------------------------------------------------------------------------------------
    def _cancel_watchdog(self) -> None:
        if self._reply_watchdog and not self._reply_watchdog.done():
            self._reply_watchdog.cancel()
        self._reply_watchdog = None

    async def _watch_reply(self, secs: float | None = None) -> None:
        """A caller turn ended and nothing audible started within REPLY_WATCHDOG_SECS: say the recovery line instead of leaving silence."""
        try:
            await asyncio.sleep(REPLY_WATCHDOG_SECS if secs is None else secs)
        except asyncio.CancelledError:
            return
        await self._recover("no audio within %.0f s of the caller's turn ending" % (REPLY_WATCHDOG_SECS if secs is None else secs))

    async def _on_empty_reply(self) -> None:
        last_user = next((m for m in reversed(self.context.messages) if isinstance(m, dict) and m.get("role") == "user"), None)
        text = last_user.get("content") if last_user else ""
        if isinstance(text, str) and len(text.split()) <= 2:
            # "wait", "hold on", "um": saying nothing to that is a fair answer, not a failure (the rest of the sentence is usually on its way)
            logger.info(f"no reply to a very short turn ({len(text.split())} words): staying quiet")
            return
        await self._recover("the LLM reply had nothing speakable (empty, malformed or truncated tool call)")

    async def _recover(self, why: str) -> None:
        logger.warning(f"recovering: {why}")
        self.stats["recoveries"] = self.stats.get("recoveries", 0) + 1
        try:  # drop the broken turn so it cannot poison every later request
            self.context.set_messages(sanitize_messages(list(self.context.messages)))
        except Exception:  # pragma: no cover
            logger.exception("could not repair the context")
        now = time.monotonic()
        if now - self._last_recovery < 8.0:
            return  # one apology per breath
        self._last_recovery = now
        self.reporter.note("Recovered from a reply with nothing to say", why=why)
        await self._tap.say(prompts.ERROR_LINE)

    async def _loop_lag_monitor(self) -> None:
        """Says so in the log when the event loop was blocked or starved (a multi-second gap between audio frames or LLM chunks is either the
        endpoint or this process: this line tells which)."""
        last = time.monotonic()
        while True:
            await asyncio.sleep(0.25)
            now = time.monotonic()
            if now - last - 0.25 > 0.4:
                logger.warning(f"event loop stalled for {now - last - 0.25:.1f} s (CPU starved, or something blocking the loop)")
            last = now

    async def _goodbye(self, line: str) -> None:
        if self.worker:
            await self.worker.queue_frames([TTSSpeakFrame(line, append_to_context=False), EndFrame()])

    async def _max_call_watchdog(self) -> None:
        await asyncio.sleep(self.s.max_call_secs)
        self.end_reason = "max_duration"
        self.reporter.note("Call reached the maximum length; hanging up")
        await self._goodbye(prompts.max_call_bye(self.init.may_ring_back))

    # ---- activation: the call becomes a traced agent_run with the household's brief and tools ------------------------------
    async def _activate_web(self) -> None:
        try:
            await self._activate(household_id=self.init.household_id, display_name=self.init.display_name, first_name="", member_id="", speak=None)
        except Exception as e:
            logger.error(f"could not start the run: {e}")
            self.end_reason = f"error: start failed ({e})"[:120]
            await self._goodbye(prompts.PIN_UNAVAILABLE)

    async def _activate(self, *, household_id: str, display_name: str, first_name: str, member_id: str, speak: str | None, callback: Any = None, callback_notes: str = "") -> None:
        init = self.init
        # the briefing call and the tool list are independent: fetch them together (the list is cached 5 min across calls)
        resp, specs = await asyncio.gather(
            self.client.start(
                call_id=init.call_id,
                household_id=household_id,
                member_id=member_id,
                first_name=first_name,
                display_name=display_name,
                transport=init.transport_label,
                caller=init.caller,
                llm={"provider": "nvidia", "model": self.s.llm_model},
                **({"callback": True} if callback else {}),
            ),
            fetch_tools(self.client),
        )
        self.run_id = resp["run_id"]
        self.family = resp.get("family", "the family")
        self.speech.today = resp.get("as_of") or None
        self.reporter.set_run(self.run_id)
        self.context.messages[0]["content"] = prompts.system_prompt(
            family=self.family, first_name=resp.get("first_name", ""), brief=resp.get("brief", []), today=resp.get("as_of", ""), channel="phone" if init.kind == "phone" else "web", callback_notes=callback_notes, may_ring_back=init.may_ring_back
        )
        self.context.set_tools(to_tools_schema(specs))
        for sp in specs:
            self.llm.register_function(sp["name"], self._on_tool)
        self._activated.set()
        logger.info(f"run {self.run_id} active for {self.family}")
        if self.s.llm_warm:  # prime the provider's prompt cache with this call's real system prompt + tools while the greeting is still playing
            asyncio.create_task(self.llm.warm(self.context), name="llm-prime")
        await self._send_run_message()
        if speak:
            await self.worker.queue_frame(TTSSpeakFrame(speak.format(family=self.family), append_to_context=True))

    # ---- callback: Brian rings back with a critical alert -------------------------------------------------------------------
    async def _activate_callback(self) -> None:
        """The opening line is already playing. Start the (traced) run, put the alert on the dashboard, then say it. The model only takes
        over for the caller's questions, so the alert is spoken even if the LLM is down."""
        plan = self.init.callback
        alert: alerts.CallbackAlert = plan.alert
        self.household_id, self.first_name, self.unlocked = plan.household_id, plan.first_name, True
        try:
            await self._activate(household_id=plan.household_id, display_name="", first_name=plan.first_name, member_id="", speak=None, callback=plan, callback_notes=alerts.system_notes(alert))
        except Exception as e:
            logger.error(f"could not start the callback run: {e}")
            self.end_reason = f"error: start failed ({e})"[:120]
            await self._goodbye(prompts.PIN_UNAVAILABLE)
            return
        posted = await self._post_callback_alert(alert)
        self.reporter.note("Callback: critical alert ready", source=alert.source, origin=alert.origin, kind=alert.kind, on_dashboard=posted)
        await self.worker.queue_frame(TTSSpeakFrame(alerts.spoken_script(alert, posted=posted), append_to_context=True))

    async def _post_callback_alert(self, alert: "alerts.CallbackAlert") -> bool:
        """True when the alert is on the dashboard (written now, or an open critical one that was already there)."""
        try:
            r = await self.client.callback_alert(self.run_id or "", alert.api_payload())
            return bool(r.get("ok"))
        except WorkerError as e:
            logger.warning(f"callback alert not written: {e}")
            self.reporter.error("Could not put the callback alert on the dashboard", detail=str(e)[:160])
            return False

    async def _send_run_message(self) -> None:
        """{type: "run", run_id} so the browser can link to Agent Trail; sent once the run exists AND the RTVI client is ready."""
        if self._run_sent or not self.run_id or not self._rtvi_ready or not self.worker:
            return
        self._run_sent = True
        await self.worker.queue_frame(RTVIServerMessageFrame(data={"type": "run", "run_id": self.run_id}))

    # ---- phone: PIN ------------------------------------------------------------------------------------------------------
    async def _verify_pin(self, pin: str) -> PinOutcome:
        try:
            r = await self.client.identify(self.init.call_id, self.init.caller_hash, pin)
        except WorkerError as e:
            logger.warning(f"identify failed: {e}")
            return PinOutcome(ok=False, unavailable=True, locked=True)
        if r.get("ok"):
            return PinOutcome(ok=True, info=r)
        return PinOutcome(ok=False, tries_left=int(r.get("tries_left", 0)), locked=bool(r.get("locked")))

    async def _on_pin_ok(self, info: dict[str, Any]) -> None:
        self.reporter.note("PIN verified on the keypad", caller=self.init.caller)
        self.unlocked, self.household_id, self.first_name = True, info["household_id"], info.get("first_name", "")  # a callback may follow this call
        try:
            await self._activate(household_id=info["household_id"], display_name="", first_name=info.get("first_name", ""), member_id=info.get("member_id", ""), speak=prompts.UNLOCKED)
        except Exception as e:
            logger.error(f"could not start the run after PIN: {e}")
            self.end_reason = f"error: start failed ({e})"[:120]
            await self._goodbye(prompts.PIN_UNAVAILABLE)

    async def _on_pin_locked(self, reason: str) -> None:
        self.end_reason = reason

    # ---- tools -------------------------------------------------------------------------------------------------------------
    async def _on_tool(self, params: FunctionCallParams) -> None:
        name, args = params.function_name, dict(params.arguments or {})
        t0 = time.monotonic()
        if not self._tap.spoke and not self._filled:
            self._filled = True
            line = self.fillers.next()
            await params.llm.push_frame(TTSSpeakFrame(line, append_to_context=False))
            self.reporter.note("Spoke a short filler line while the tool ran", tool=name, line=line)
        try:
            res = await self.client.tool(self.run_id or "", name, args)
        except WorkerError as e:
            logger.warning(f"tool {name} failed: {e}")
            await params.result_callback({"error": "The tool is not available right now. Tell the caller briefly and offer to try again."})
            return
        logger.info(f"tool {name} {round((time.monotonic() - t0) * 1000)} ms ok={res.get('ok')}")
        if res.get("ok"):
            await params.result_callback(res["result"])
        else:
            await params.result_callback({"error": res.get("error", "tool failed"), "hint": "Say you could not get that number and ask a clearer question."})
