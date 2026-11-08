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
from pipecat.frames.frames import EndFrame, Frame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame, MetricsFrame, TTSSpeakFrame
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
from pipecat.turns.user_start import MinWordsUserTurnStartStrategy
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy, TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

import prompts
from config import Settings
from llm import build_llm
from pacing import SentenceCap
from pin_gate import PinGate, PinOutcome
from reporter import TraceReporter
from speech import SpeechNormalizer
from tts import TTSChoice, build_tts
from worker_client import WorkerClient, WorkerError

_tools_cache: tuple[float, list[dict]] | None = None


@dataclass
class CallInit:
    call_id: str
    kind: str  # "webrtc" | "phone"
    transport_label: str  # webrtc | twilio | signalwire
    household_id: str = ""  # webrtc: from the offer's request data
    display_name: str = ""
    caller_hash: str = ""
    caller: str = "new"  # known | new (never the number itself)


async def fetch_tools(client: WorkerClient) -> list[dict]:
    """The phone tool specs come from the worker (one registry, schemas never duplicated); cached for 5 minutes."""
    global _tools_cache
    now = time.monotonic()
    if _tools_cache and now - _tools_cache[0] < 300:
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


def _stop_strategies(s: Settings) -> list:
    """Smart Turn v3 decides when the caller is finished (a timer alone cuts people off at a pause). `turn_hold_secs` > 0 adds a timer
    that must ALSO have run out (pipecat's default stop_mode is ALL), so a one-word "wait" followed by a breath is not taken as a whole turn."""
    if not s.smart_turn:
        return [SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.8)]
    stops: list = [TurnAnalyzerUserTurnStopStrategy(turn_analyzer=LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=s.smart_turn_stop_secs)))]
    if s.turn_hold_secs > 0:
        stops.append(SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=s.turn_hold_secs))
    return stops


class LLMTap(FrameProcessor):
    """Sits after the LLM: remembers whether the model already said something this turn (so a filler is not stacked on top of it),
    the token usage of the last completion, and enforces the spoken-turn cap (SentenceCap: once a turn has said enough, the current
    sentence is allowed to finish and the rest of the reply is dropped before it reaches the voice)."""

    def __init__(self, max_words: int = 32, **kw: Any):
        super().__init__(**kw)
        self.cap = SentenceCap(max_words=max_words)
        self.capped_turns = 0
        self.spoke = False
        self.tokens_in = 0
        self.tokens_out = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self.spoke = False
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
        elif isinstance(frame, MetricsFrame):
            for d in frame.data:
                usage = getattr(d, "value", None)
                if usage is not None and hasattr(usage, "prompt_tokens"):
                    self.tokens_in, self.tokens_out = int(usage.prompt_tokens or 0), int(usage.completion_tokens or 0)
        await self.push_frame(frame, direction)


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
        self.end_reason = "hangup"
        self.stats: dict[str, Any] = {"transport": init.transport_label, "barge_ins": 0, "turns": 0, "tts_voice": settings.tts_voice}
        self._idle_prompted = False
        self._run_sent = False
        self._rtvi_ready = False
        self._activated = asyncio.Event()
        self._turn: dict[str, Any] = {}
        self._tap = LLMTap(max_words=settings.turn_cap_words)
        self.speech = SpeechNormalizer()  # dates follow the demo's as_of once the run starts
        self.fillers = prompts.FillerPicker()
        self._filled = False  # one filler per caller turn, even when the model chains two tools
        self.tts_choice: TTSChoice | None = None
        self._tts: Any = None
        self._rtvi: RTVIProcessor | None = None
        self._watchdog: asyncio.Task | None = None
        self.worker: PipelineWorker | None = None
        self.runner: WorkerRunner | None = None
        self.llm = build_llm(settings)
        self.context = LLMContext(messages=[{"role": "system", "content": "You are a voice assistant. The caller has not been verified yet; do not discuss anyone's finances."}])

    # ---- lifecycle ------------------------------------------------------------------------------------------------------
    async def run(self) -> str:
        s, init = self.s, self.init
        phone = init.kind == "phone"
        stt = NvidiaSTTService(api_key=s.nvidia_api_key, server=s.asr_server, model_function_map={"function_id": s.asr_function_id, "model_name": "nemotron-asr-streaming"})
        tts, self.tts_choice = await build_tts(s, phone=phone, normalizer=self.speech)
        self._tts = tts
        self.stats["tts_voice"] = self.tts_choice.label
        user_agg, asst_agg = LLMContextAggregatorPair(
            self.context,
            user_params=LLMUserAggregatorParams(
                # Silero only says "quiet for 0.2 s"; the Smart Turn v3 model (local ONNX, CPU, about 9 MB) decides whether the caller is really
                # finished, so a pause mid-thought ("if we bought a... thirty-five thousand dollar car") does not trigger an answer.
                vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=s.vad_stop_secs if s.smart_turn else max(s.vad_stop_secs, 0.5))),
                user_turn_strategies=UserTurnStrategies(
                    # barge-in needs two words while the bot is talking, so a cough or hall noise does not cut it off
                    start=[MinWordsUserTurnStartStrategy(min_words=s.barge_in_words)],
                    stop=_stop_strategies(s),
                ),
                user_idle_timeout=float(s.idle_secs),
            ),
        )

        gate = None
        if phone:
            gate = PinGate(verify=self._verify_pin, on_unlocked=self._on_pin_ok, on_locked=self._on_pin_locked, pin_length=s.pin_length)
        procs = [self.transport.input(), *( [gate] if gate else [] ), stt, user_agg, self.llm, self._tap, tts, self.transport.output(), asst_agg]

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
            m: dict[str, Any] = {"v2v": b.total_secs}
            for t in b.ttfb:
                name = t.processor
                if "STT" in name:
                    m["asr"] = t.duration_secs
                elif "LLM" in name:
                    m["llm"] = t.duration_secs
                elif "TTS" in name:
                    m["tts"] = t.duration_secs
            self._turn = m

        @user_agg.event_handler("on_user_turn_stopped")
        async def _heard(_agg, _strategy, message):
            text = (message.content or "").strip()
            self._filled = False
            if text:
                self._idle_prompted = False
                self.stats["turns"] += 1
                self.reporter.heard(text)
                logger.info(f"heard: {text}")

        @asst_agg.event_handler("on_assistant_turn_stopped")
        async def _said(_agg, message):
            text = (message.content or "").strip()
            if not text:
                return
            m, self._turn = self._turn, {}
            if message.interrupted:
                self.stats["barge_ins"] += 1
            self.reporter.said(text, model=s.llm_model, asr_ms=m.get("asr"), llm_ms=m.get("llm"), tts_ms=m.get("tts"), v2v_ms=m.get("v2v"), tokens_in=self._tap.tokens_in or None, tokens_out=self._tap.tokens_out or None, interrupted=message.interrupted, voice=self.tts_choice.label if self.tts_choice else s.tts_voice, tts_model=self.tts_choice.model if self.tts_choice else None, tts_provider=self.tts_choice.provider if self.tts_choice else None)
            logger.info(f"said: {text} (v2v={m.get('v2v')}, llm={m.get('llm')}, tts={m.get('tts')})")

        @user_agg.event_handler("on_user_turn_idle")
        async def _idle(_agg):
            if not self.run_id:
                return
            if not self._idle_prompted:
                self._idle_prompted = True
                await self.worker.queue_frame(TTSSpeakFrame(prompts.IDLE_PROMPT, append_to_context=False))
            else:
                self.end_reason = "idle"
                await self._goodbye(prompts.IDLE_BYE)

        @self.transport.event_handler("on_client_connected")
        async def _connected(_t, _client):
            logger.info(f"client connected ({init.transport_label}) call={init.call_id}")
            self.reporter.start()
            asyncio.create_task(self._prewarm_llm(), name="llm-prewarm")
            if phone:
                await self.worker.queue_frame(TTSSpeakFrame(prompts.DISCLOSURE_PHONE, append_to_context=False))
            else:
                await self.worker.queue_frame(TTSSpeakFrame(prompts.DISCLOSURE_WEB, append_to_context=False))
                asyncio.create_task(self._activate_web(), name="activate-web")
            self._watchdog = asyncio.create_task(self._max_call_watchdog(), name="call-watchdog")

        @self.transport.event_handler("on_client_disconnected")
        async def _disconnected(_t, _client):
            logger.info(f"client disconnected call={init.call_id}")
            await self.runner.cancel()

        if self._rtvi:

            @self._rtvi.event_handler("on_client_ready")
            async def _rtvi_ready(_p):
                self._rtvi_ready = True
                await self._send_run_message()

        try:
            await self.runner.run()
        except Exception as e:  # pragma: no cover - surfaced in the run's final event
            logger.exception("pipeline crashed")
            self.end_reason = f"error: {type(e).__name__}: {e}"[:120]
        finally:
            await self._finish()
        return self.end_reason

    async def _finish(self) -> None:
        if self._watchdog:
            self._watchdog.cancel()
        await self.reporter.stop()
        closer = getattr(getattr(self, "_tts", None), "kv_cleanup", None)
        if closer:
            try:
                await closer()
            except Exception:
                pass
        if self.run_id:
            await self.client.end(self.run_id, self.end_reason, self.stats)
        if self._owns_client:
            await self.client.aclose()
        logger.info(f"call {self.init.call_id} finished: {self.end_reason}")

    async def _prewarm_llm(self) -> None:
        """Open the TLS connection to the LLM endpoint and wake the route while the disclosure is still being spoken, so the first real
        question does not pay for it (a cold first call cost about a second in the spike)."""
        client = getattr(self.llm, "_client", None)
        if client is None:
            return
        t0 = time.monotonic()
        try:
            await client.chat.completions.create(
                model=self.s.llm_model, messages=[{"role": "user", "content": "hi"}], max_tokens=1, stream=False, extra_body={"chat_template_kwargs": {"enable_thinking": False}}
            )
            logger.info(f"LLM pre-warm took {round((time.monotonic() - t0) * 1000)} ms")
        except Exception as e:
            logger.warning(f"LLM pre-warm failed (the first answer may be slower): {e}")

    async def _goodbye(self, line: str) -> None:
        if self.worker:
            await self.worker.queue_frames([TTSSpeakFrame(line, append_to_context=False), EndFrame()])

    async def _max_call_watchdog(self) -> None:
        await asyncio.sleep(self.s.max_call_secs)
        self.end_reason = "max_duration"
        self.reporter.note("Call reached the maximum length; hanging up")
        await self._goodbye(prompts.MAX_CALL_BYE)

    # ---- activation: the call becomes a traced agent_run with the household's brief and tools ------------------------------
    async def _activate_web(self) -> None:
        try:
            await self._activate(household_id=self.init.household_id, display_name=self.init.display_name, first_name="", member_id="", speak=None)
        except Exception as e:
            logger.error(f"could not start the run: {e}")
            self.end_reason = f"error: start failed ({e})"[:120]
            await self._goodbye(prompts.PIN_UNAVAILABLE)

    async def _activate(self, *, household_id: str, display_name: str, first_name: str, member_id: str, speak: str | None) -> None:
        init = self.init
        resp = await self.client.start(
            call_id=init.call_id,
            household_id=household_id,
            member_id=member_id,
            first_name=first_name,
            display_name=display_name,
            transport=init.transport_label,
            caller=init.caller,
            llm={"provider": "nvidia", "model": self.s.llm_model},
        )
        self.run_id = resp["run_id"]
        self.family = resp.get("family", "the family")
        self.speech.today = resp.get("as_of") or None
        self.reporter.set_run(self.run_id)
        specs = await fetch_tools(self.client)
        self.context.messages[0]["content"] = prompts.system_prompt(
            family=self.family, first_name=resp.get("first_name", ""), brief=resp.get("brief", []), today=resp.get("as_of", ""), channel="phone" if init.kind == "phone" else "web"
        )
        self.context.set_tools(to_tools_schema(specs))
        for sp in specs:
            self.llm.register_function(sp["name"], self._on_tool)
        self._activated.set()
        logger.info(f"run {self.run_id} active for {self.family}")
        await self._send_run_message()
        if speak:
            await self.worker.queue_frame(TTSSpeakFrame(speak.format(family=self.family), append_to_context=True))

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
