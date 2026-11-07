# Phone line: call the family's agent (design, researched 2026-11-07, nothing built yet)

Goal: a family member dials a US number, hears an honest AI disclosure, says a PIN, and talks to a warm voice that explains the household's
money in plain words, runs "what if we buy a $35k car?" by voice, and shows up as a live `agent_run` (workflow `phone`) in the Agent Trail.
Binding constraints are in `docs/contracts.md` section 8. Marks: **[V]** verified today on a primary source (URL at the bottom), **[U]** unverified, test first.
Method: docs and PyPI read today; no accounts created, no keys used, nothing installed, no call placed. Every latency number below is a budget or a third-party figure, not something we measured.

## Decisions (read this, skip the rest if short on time)

| Question | Decision | Why |
|---|---|---|
| Telephony | **Twilio, upgraded to paid**, Media Streams (`<Connect><Stream>`), a 214/469 local number | Trial **blocks `<Stream>` and `<ConversationRelay>`**, allows inbound only from verified callers, 75 min total, 10 min/call **[V]**. Judges cannot call a trial number. Paid is about $0.013/min. Pipecat has a first-class Twilio serializer **[V]** |
| Backup path | Same bot over **SmallWebRTC** ("Talk to Keystone" button in the room, no number needed) | Same `bot.py`, second transport. Wideband audio and browser echo/noise cancellation. Needs UDP reachable on the EC2 box **[U]** |
| Framework | **Pipecat 1.15.0** (PyPI 2026-10-29, Python 3.11+) in a new `services/voice` | Ships `NvidiaSTTService`, `NvidiaLLMService`, `NvidiaTTSService`, Silero VAD, Smart Turn v3, barge-in **[V]**. Hand-rolling these in Node is a day-plus |
| ASR | **Nemotron ASR streaming** (NVCF fn `bb0837de-...`, gRPC) via `NvidiaSTTService` (its default) | Same function id the repo already uses **[V]**. Fallback: `NvidiaSegmentedSTTService` (Canary) |
| LLM (voice turns) | **`nvidia/nemotron-3.5-lightning-30b-a3b`, thinking off**, tools on, hosted API | 3B active, tools supported **[V per catalog]**. Ultra stays off the hot path |
| LLM (depth) | **Ultra as an async "analyst" tool** (phase 2) | Planner/analyst handoff is the NVIDIA-track story. The caller hears a filler line while it runs |
| Brev Lightning | **Hot spare, not primary** | Public share URL plus a cold GPU is a worse bet than the hosted API. Its job is rescuing 429s |
| TTS | **Magpie TTS Multilingual** via `NvidiaTTSService`; Cartesia Sonic as one-env-var fallback | Keeps the NVIDIA story. Phone audio is 8 kHz mu-law, which narrows the gap to commercial voices. Pick by ear in spike S2 |
| Turn-taking | Silero VAD + Smart Turn v3 (defaults), barge-in needs 3+ words, RNNoise on input | Hall noise must not cut the bot off |
| Integration | Python never touches SpacetimeDB. It calls new internal **worker `/phone/*` HTTP routes**; the worker owns RunContext, tools, traces | No official Python SpacetimeDB SDK **[V]**. Reuses tools and the glass box unchanged |
| Caller ID | PIN (keypad or spoken) gates everything. Known team numbers are recognized by salted hash. Judges' numbers are never stored | Judges call from unknown phones, so "number on file" can only be a convenience |
| Targets | voice-to-voice p50 <= 1.5 s, p95 <= 2.5 s (tool turns <= 3.5 s with a filler) | See 2.5 |
| Effort | Spikes 45 min, MVP 2 h, polish 3-4 h | See section 4 |

## 1. Telephony

| | Twilio | Telnyx | Vonage | Browser WebRTC |
|---|---|---|---|---|
| Inbound + WS media | `<Connect><Stream>`, bidirectional, 8 kHz mu-law, `dtmf` + `mark` + `clear` events **[V]** | `<Stream bidirectionalMode="rtp">` via TeXML **[V]** | Voice API `connect` to WebSocket, `audio/l16;rate=16000` **[V]** | SmallWebRTC offer/answer **[V]** |
| Trial vs judges calling in | Inbound only from verified numbers (5 max), `<Stream>` stripped, 10 min/call, 75 min total, 5 concurrent **[V]** | Inbound only from the 1 verified number; 1 trial number, reclaimed in 30 days **[V]** | Not found **[U]** | No number needed |
| After upgrade | Restrictions removed; US local number first month free **[V]** | Number needs eKYC (can take time) **[U]** | | |
| Cost | Number $1.15/mo, inbound $0.0085/min, Media Streams $0.0044/min **[V]** (about $0.013/min, 300 judging minutes is about $4) | Number $1/mo, WS streaming $0.0035/min **[U, search snippet]** | | $0 |
| Pipecat | `TwilioFrameSerializer`, DTMF to `InputDTMFFrame`, auto hang-up **[V]** | `TelnyxFrameSerializer` **[V]** | Serializer is for the Video API Audio Connector only **[V]**, so custom work | `SmallWebRTCTransport` **[V]** |
| Verdict | **Pick.** Fastest to a working number | Fine if Twilio billing fails | Skip | Build second |

Twilio break-glass: **ConversationRelay** ($0.07/min **[V]**) does ASR/TTS for you and speaks plain text to a WebSocket, so the Node worker could answer with no Python. We would lose Nemotron ASR/TTS, so use it only if Pipecat dies.

**Twilio setup (15 min, one teammate with a card):**
1. Console, Upgrade (add a card; budget a $20 top-up **[U]**). Do this first: the trial cannot run `<Stream>` at all.
2. Buy a local number (214 or 469, Dallas) with Voice capability. Set "A call comes in" to Webhook `POST https://$PUBLIC_HOSTNAME/voice/twiml`.
3. Put the Account SID and Auth Token (or an API key) in `.env.prod` only. Add a Twilio usage trigger / spend cap.
4. Our TwiML endpoint returns this and validates `X-Twilio-Signature` (otherwise anyone can start calls):
```xml
<Response><Connect><Stream url="wss://${PUBLIC_HOSTNAME}/voice/ws">
  <Parameter name="from" value="{From}"/></Stream></Connect></Response>   <!-- fill {From} server-side -->
```
Sample code to copy: pipecat-examples `twilio-chatbot/inbound` (it already fetches the caller via REST; we use the `<Parameter>` instead).

## 2. Pipeline

### 2.1 Framework
- **Pipecat 1.15.0** **[V]**. The 1.x API names differ from older blog posts: `PipelineWorker` + `WorkerRunner` (not `PipelineTask`), `LLMContextAggregatorPair` with `LLMUserAggregatorParams`, `pipecat.turns.*` strategies. Pin the version. Extras: `pipecat-ai[nvidia,silero,websocket,webrtc,runner,local-smart-turn,rnnoise,cartesia]` **[V]**.
- NVIDIA's own paths: the **ACE Controller** docs moved to `archive.docs.nvidia.com` and the nvidia-pipecat changelog I could read stops at 0.1.0 (Apr 2025), so treat the old ACE blueprint as legacy **[V]**. The current one is **NeMo Voice Agent** (docs.nvidia.com/nemo/labs-voice-agent), an open-source Pipecat pipeline using exactly `NvidiaSTTService` / `NvidiaLLMService` / a retrying TTS wrapper for cold starts **[V]**. Borrow the retry idea, do not adopt the framework. Pipecat's repo has `examples/voice/voice-nvidia.py` with `twilio` and `webrtc` transports **[V]**: start from it.
- Hand-rolling on the Node worker means mu-law codec, 8 to 16 kHz resampling, VAD, a Riva gRPC client for ASR and TTS, turn detection and barge-in/`clear` handling. Not worth it with 19 hours left.

### 2.2 ASR
`NvidiaSTTService(api_key=...)` defaults to `nemotron-asr-streaming`, fn `bb0837de-8c7b-481f-9ec8-ef5663e9c1fa`, `grpc.nvcf.nvidia.com:443`, interim results on **[V]**. Cache-aware FastConformer-RNNT, 250k+ hours en-US, punctuation built in **[V]**; A 24 ms median time-to-final on a server GPU is reported by NVIDIA-adjacent blogs **[U, third-party]**; hosted latency is **[U]**. Pipecat upsamples the 8 kHz phone audio to 16 kHz for us. Weak spot: **digits and dollar amounts in noise** ("fifteen" vs "fifty"). So the PIN is keyed on the keypad (DTMF, preferred) and the bot reads back any amount before running a what-if.

### 2.3 LLM
- Voice front: Lightning, `enable_thinking=False`, `temperature 1.0 / top_p 0.95` per the card, `max_tokens ~200`, streaming. One LLM call per plain turn, two per tool turn.
- Set the model explicitly: `NvidiaLLMService`'s default is `nvidia/nemotron-3.5-super-vl-120b-a12b` **[V]**, not Lightning. It has no documented place for `chat_template_kwargs` **[V]** and the Pipecat example uses a `/no_think` system prefix **[V]**; `docs/nvidia-stack.md` says the new models use `chat_template_kwargs` instead. Spike S3 decides: subclass `NvidiaLLMService` to add `extra_body={"chat_template_kwargs":{"enable_thinking":False}}`, or fall back to `/no_think`. **[U]**
- Analyst (phase 2): tool `ask_analyst(question)` calls the worker, which runs the existing `runAgentLoop` on `NEMOTRON_MODEL` (Ultra) with thinking on. Pipecat registers it with `cancel_on_interruption=False`, speaks "Let me dig into that, one second" while it runs, and the trace shows a `handoff` voice_agent to analyst. Cap at 25 s, then answer from what the fast model already has.
- **Rate limits are the real constraint.** Free tier is about 40 RPM per account **[V per docs/nvidia-stack.md]** and the web agents share it. Give the voice service its **own NVIDIA key from a different teammate's account** (limit assumed per account **[U]**), keep `NVIDIA_RPM` accounting separate, and keep the Brev endpoint as the failover `base_url` (an `LLMSwitcher`/`ServiceSwitcher` pair, or a try/except around turn start).
- Brev critical-path verdict: no. Hop count, cold weights, NVFP4 support on L40S **[U]**, and a public share URL are all risks for the first sentence the judge hears. Run Brev only if spike S3 shows hosted TTFT above about 800 ms or 429s.

### 2.4 TTS
- `NvidiaTTSService` default: fn `877104f7-e885-42b9-8de8-f6e4c6303969`, voice `Magpie-Multilingual.EN-US.Aria`, `PER_SENTENCE` synthesis (`STITCHED` sounds smoother, try it) **[V]**. Magpie Multilingual v4.0 (364M, autoregressive, 22.05 kHz) is documented with EN-US speakers **Aria, Jason, Leo, Mia, Ray, Sofia** and emotion suffixes like `Magpie-Multilingual.EN-US.Aria.Calm` / `.Happy` (availability differs per speaker) **[V for the NIM]**. Whether our hosted function exposes all of them is **[U]**: spike S2 lists them. Streaming flush knobs: `custom_configuration={"flush": ..., "chunk_len_threshold": ...}` **[V]**.
- "Human sounding": it is expressive for an open model, and on an 8 kHz mu-law line most of the audible difference to ElevenLabs/Cartesia disappears. A/B on a real phone in S2 (Cartesia Sonic 3.5 GA May 2026, ElevenLabs Flash v2.5 about 75 ms: both **[U, third-party blogs]**). Decision rule: Magpie unless it sounds clearly robotic or its p95 time-to-first-audio is over 600 ms. If we fall back, the pitch is "Nemotron ASR + Nemotron agent + Nemotron-planned tools; voice skin is a commercial TTS", still honest in the trace.
- Write for the ear: system prompt forces short sentences, contractions, rounded numbers spoken as words ("about thirty-five thousand dollars"), no symbols or lists. The NIM card says input text must be normalized **[V]**, so do not rely on it to expand "$35k".
- Pre-render the disclosure greeting once (mu-law WAV on disk) so call pickup has zero TTS dependency and zero cold start.

### 2.5 Turn-taking, noise and the latency budget
```python
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.turns.user_start import MinWordsUserTurnStartStrategy, TranscriptionUserTurnStartStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams

user_agg, asst_agg = LLMContextAggregatorPair(context, user_params=LLMUserAggregatorParams(
    vad_analyzer=SileroVADAnalyzer(),                   # stop_secs=0.2 default; Smart Turn v3 is the default stop strategy
    user_turn_strategies=UserTurnStrategies(            # [U] this start combo is untested; tune on a real call
        start=[MinWordsUserTurnStartStrategy(min_words=3), TranscriptionUserTurnStartStrategy()])))
params = PipelineParams(audio_in_sample_rate=8000, audio_out_sample_rate=8000, enable_metrics=True)
```
Add `audio_in_filter=RNNoiseFilter()` on the FastAPI WebSocket params (the filter is open source and keyless **[V]**; that it accepts the 8 kHz telephony path is **[U]**). Krisp VIVA is better but needs a Krisp developer account and SDK wheel **[V]**: skip. Interruptions stay on **[V]** (default), but the 3-word rule keeps coughs and hall chatter from cutting the bot off. Smart Turn v3 is an 8 MB CPU model, about 12 ms on a modern core **[U, vendor blog]**; on a burstable t3 vCPU **[U]**.

| Stage (caller stops talking) | Budget | Notes |
|---|---|---|
| VAD stop + turn decision | 200-300 ms | stop_secs 0.2; Smart Turn is inside the STT deadline |
| ASR final (NVCF gRPC) | 100-250 ms | **[U]** |
| LLM first sentence (Lightning, no thinking) | 400-700 ms | **[U]**, the biggest unknown |
| TTS first audio (Magpie) | 250-500 ms | **[U]**, warm gRPC channel |
| Twilio edge + playout | 100-200 ms | the box's 52.72.x address is probably us-east-1 **[U]**, close to Twilio's US East edge |
| **Total** | **~1.1-1.9 s** | tool turn adds HTTP 50-300 ms + a second LLM call: mask with a filler |

How to hit it: thinking off; a short system prompt; household brief preloaded so common questions need **zero** tool calls; stream the LLM into TTS per sentence; speak a filler (`TTSSpeakFrame("Let me run that.")`) the moment a tool is called; keep tool results under 1 KB (`voiceView`, section 3); open the ASR and TTS gRPC channels at connect, not at first word; cap replies at about 40 words.

## 3. Integration

```
caller -- PSTN --> Twilio --wss--> Caddy /voice/ws --> voice (Pipecat) --gRPC--> NVCF: Nemotron ASR, Magpie TTS
                                                          |   --HTTPS--> NVIDIA API: Lightning (or Brev)
                                                          '-- http://worker:8787/phone/* (secret header) --> worker --> SpacetimeDB
```
**Why HTTP to the worker, not SpacetimeDB from Python:** SpacetimeDB documents SDKs for Rust, C#, TypeScript and Unreal; Python is not one **[V]** (a community `spacetimedb-sdk` 0.7.0 exists on PyPI, old **[U]**). The raw HTTP API (`POST /v1/database/:db/call/:reducer`, `/sql`, bearer token) works but would duplicate the identity and worker-secret handling **[V]**. The worker already owns tools, `RunContext`, the sink and trace sequencing, so the voice service stays a thin media + dialogue layer and **all state still lives in SpacetimeDB** (hard rule 1).

**Worker additions** (`services/worker/src/phone/`; routes registered with `router.add`, internal only):

| Route | Does |
|---|---|
| `POST /phone/identify {call_id, caller_hash, pin}` | PIN to `{household_id, member_id, first_name}`; 3 tries per call; constant-time compare |
| `POST /phone/start {call_id, household_id, member_id, transport}` | `agent_enqueue_job('phone', hh, call_id, {})` then `claimJob` then `startRun`; builds a `RunContext` (kept in a Map); runs the **briefing**: `plan` event, then `run.tool` for `get_health_indicators`, `get_forecast`, `get_obligations`; returns `{run_id, brief}` (about 10 spoken-friendly lines) |
| `GET /phone/tools` | `registry.specs(PHONE_TOOLS)`; Python builds `FunctionSchema`s from it, so schemas are never duplicated |
| `POST /phone/tool {run_id, name, args}` | `run.tool('phone', name, args)` (emits `tool_call`/`tool_result`), returns `voiceView(result)`: for `simulate_scenario` only `headline, verdict, lowest, ending, effect, months_of_spending_covered_at_low, assumptions[:2]` |
| `POST /phone/trace {run_id, events[]}` | `run.emit` for turn events (below) |
| `POST /phone/end {run_id, reason, stats}` | `final` event, `drain()`, `finishRun`. A reaper finishes runs with no traffic for 10 min as `error: abandoned` |

`PHONE_TOOLS` = `get_health_indicators, get_forecast, get_obligations, get_accounts, simulate_scenario, goal_feasibility, detect_scam_signals` (7 is plenty for a 3B-active model). A live call does **not** take a `JobQueue` slot (concurrency is 2): do not register `phone` as a `WorkflowDef`, so the queue ignores the job and the session claims it directly.

**Contract changes (edit `docs/contracts.md` first, per its own rule):**
1. `WORKFLOWS` in `spacetime/src/util.ts` and the trace-semantics list gain `phone`; add `voice_agent` and `analyst` to the agent names.
2. New worker-only reducer `agent_enqueue_job(workflow, household_id, subject_id, input_json)` that calls `enqueueJob` (about 10 lines; `start_run` needs a claimed job, so there is no way around it). Republish, regenerate both binding folders.
3. Web: add a `phone` label/icon where workflows are listed (`apps/web/components/trace/AgentActivityPanel.tsx`, `apps/web/lib/types.ts`).
4. Phase 2 table `phone_identity` (private: member_id, household_id, phone_hash, pin_hash). MVP shortcut: `PHONE_IDENTITIES_JSON` env on the worker (deviates from "state is a table"; note it in the PR).
5. Caddy must not expose `/worker/phone/*` (section 4).

**Trace events per call** (so the Agent Trail shows a real multi-step run): `run_started` "Phone call connected (PIN verified, Maria)" - `plan` (briefing steps) - `tool_call`/`tool_result` for the briefing - per turn: `message` "Heard: '...'" (model `nemotron-asr-streaming`, latency = ASR final) - optional `tool_call`/`tool_result` - `message` "Said: first sentence" (Lightning, provider `nvidia` or `brev`, tokens, latency = LLM first token, plus `tts_ttfb_ms` in `data_json`) - `handoff` to analyst (phase 2) - `final` with turns, tools used, p50/p95 voice-to-voice. Python batches events and POSTs every 500 ms or on turn end (Pipecat `enable_metrics=True` yields TTFB metrics; a small `FrameProcessor` collects them).

**Who is calling.** (1) Twilio sends `From` as a `<Parameter>`; the voice service computes `sha256(salt + From)` and sends only the hash. (2) A hash that matches a team number is greeted by first name, but **everyone still enters the PIN** (keypad digits arrive as `InputDTMFFrame` **[V]**; a 20-line processor that collects 4 digits and calls `/phone/identify` is **[U]**, spoken digits go through a `verify_pin` tool as the fallback). (3) Unknown numbers (all judges): PIN only. PINs are synthetic, printed on the demo card like Plaid's `user_good`. (4) Until the PIN verifies, the LLM has only a `verify_pin` path and no household data; afterwards push `LLMSetToolsFrame` with the full tool set and inject the brief. (5) Never store or log raw numbers; the trace says `caller: known|new`.

**Disclosure and privacy** (AGENTS rule 6). First thing spoken, pre-rendered, no input accepted until it finishes ([U] how to make a `TTSSpeakFrame` uninterruptible; the simple route is to open the mic gate after `BotStoppedSpeakingFrame`): *"Hi, this is Keystone, an AI assistant for your family's finances. I'm not a person or a licensed advisor, this is a demo with made-up data, and I log the steps I take but never record your voice. Please enter your four-digit PIN."* Also: no audio recording (do not use `AudioBufferProcessor`), 5-minute max call, hang up after 20 s of silence, answer "are you a real person?" truthfully (in the system prompt).

## 4. Plan

### Files, env, compose, Caddy
```
services/voice/  Dockerfile  pyproject.toml  bot.py (pipeline)  server.py (FastAPI: POST /twiml, WS /ws, POST /offer)  worker_client.py  tools.py  prompts.py  assets/greeting_8k.ulaw
services/worker/src/phone/  routes.ts  session.ts  voice_view.ts  identity.ts   (+ import in src/index.ts)
spacetime/src/reducers/worker.ts  + agent_enqueue_job;  spacetime/src/util.ts  WORKFLOWS += 'phone'
```
```bash
# voice service (.env.prod, never committed)
TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= TWILIO_PHONE_NUMBER=+1214...   VOICE_SHARED_SECRET=<random>   CALLER_HASH_SALT=<random>
NVIDIA_VOICE_API_KEY=<a different teammate's key>   NVIDIA_ASR_FUNCTION_ID=bb0837de-8c7b-481f-9ec8-ef5663e9c1fa
NVIDIA_TTS_FUNCTION_ID=877104f7-e885-42b9-8de8-f6e4c6303969   NVIDIA_TTS_VOICE=Magpie-Multilingual.EN-US.Aria
VOICE_LLM_BASE_URL=https://integrate.api.nvidia.com/v1   VOICE_LLM_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
VOICE_LLM_FALLBACK_URL=$BREV_BASE_URL   VOICE_TTS_PROVIDER=nvidia|cartesia   CARTESIA_API_KEY=   WORKER_URL=http://worker:8787
VOICE_ENABLED=1   VOICE_MAX_CALL_SECS=300   # worker side: PHONE_IDENTITIES_JSON='{"<pin>":{"household_id":"hh_rivera","member_id":"mem_..."}}'
```
```yaml
  voice:   # infra/docker-compose.yml
    build: { context: ../services/voice }
    image: keystone-voice:latest
    restart: always
    expose: ["7860"]
    depends_on: [worker]
    mem_limit: 1200m
```
```caddy
	handle /worker/phone/* { respond 404 }        # BEFORE the /worker/* block: handle blocks match in file order
	handle /voice/* {
		uri strip_prefix /voice
		reverse_proxy voice:7860 { flush_interval -1 }   # WebSocket upgrade works through reverse_proxy
	}
```
The worker's `x-voice-secret` check is the real guard; the Caddy 404 is belt and braces. The `/voice/ws` and `/voice/twiml` paths must be public (Twilio); validate the Twilio signature in `server.py`.

### Phase 0: spikes, first 45 min, in parallel (each is pass/fail; the riskiest first)
- **S1 telephony + NVCF end to end (15 min):** upgrade Twilio, buy the number, run pipecat-examples `twilio-chatbot/inbound` (swap in the three Nvidia services) on a laptop behind ngrok, call it from a cell phone. Pass: you hear Magpie and it hears you. This kills the biggest unknowns at once.
- **S2 TTS (10 min):** list available voices (`GetRivaSynthesisConfig` through `riva.client` **[U]**), 10 cold + 10 warm time-to-first-audio samples, A/B Aria/Mia/Jason (+ `.Calm`) vs Cartesia on a phone speaker.
- **S3 LLM (10 min):** thinking off via subclass vs `/no_think`; 20 calls of TTFT; 20 tool-call prompts against the 7 real specs; compare hosted vs Brev if it exists.
- **S4 box fit (10 min):** run the container next to web+worker+spacetime+caddy; measure RSS and CPU during a call. If >1 GB or CPU credits drain, resize to t3.large (stop/start; confirm the Elastic IP **[U]**) or add 2 GB swap.
- **S5 WebRTC reachability (5 min, optional):** SmallWebRTC from a phone on cellular to the box (UDP security-group range **[U]**).

### Phase 1: 2-hour MVP (three question types, one household)
1. (35 min) Worker: `agent_enqueue_job` reducer + republish + regenerate bindings; `phone/` routes with `identify/start/tools/tool/trace/end`, `voiceView`, PIN env map; unit tests with `MemorySink`.
2. (45 min) `services/voice`: `server.py` (`/twiml` with signature check, `/ws`), `bot.py` per the sketches above, tools from `/phone/tools`, PIN gate, greeting asset, trace batching.
3. (20 min) Dockerfile, compose service, Caddy block, deploy with `infra/deploy.sh`, point the Twilio number at it.
4. (20 min) Call it 10 times; fix prompts. Exit test: the three questions below work 8 of 10 times with a trace visible at `/agents`.
- Q1 "How are we doing?" (brief, no tool). Q2 "What's coming up / will we run short?" (`get_forecast`, `get_obligations`). Q3 "What if we buy a thirty-five thousand dollar car?" (`simulate_scenario`, then ask about financing).

### Phase 2: polish (3-4 h, in this order)
Filler phrases and 40-word cap, RNNoise A/B with hall noise played from a speaker, `STITCHED` TTS, Cartesia fallback switch, hosted-to-Brev LLM failover, **mirror what-ifs into the room** (also call `request_simulation` so a scenario card appears live on every family phone while the caller is still talking: the Spacetime and PNC cross-surface moment), `ask_analyst` with Ultra and the `handoff` event, "Talk to Keystone" WebRTC button + QR, `phone` chip in the trail, 3 simultaneous calls load test, dead-air and error scripts ("I'm having trouble hearing you, try the web room"). Then hardening: `VOICE_ENABLED` kill switch, Twilio spend cap, rehearse with the card below.

### Demo script for judges (60-90 s, print on the QR card)
1. "Call **(214) xxx-xxxx**. A voice says it's an AI. Key in PIN **####** (the Rivera family)." 2. Ask "How are we doing?": about two months of cushion, one friendly caution. 3. "What's coming up this month?": names the low point and the date. 4. "What if we buy a thirty-five thousand dollar car?": reads back the amount, runs the simulator, narrates the verdict and the monthly payment. 5. Meanwhile on the big screen, `/agents` shows the phone run: plan, tool calls, ASR / Lightning / Magpie badges, latency per step. 6. Noisy hall: hold the phone to your mouth, use the keypad for the PIN, or tap **Talk to Keystone** in the browser.

### Top risks and mitigations
1. **Hosted NVCF ASR/TTS is shared and can cold-start or throttle** (the NeMo voice agent ships a retry wrapper for TTS cold starts **[V]**; speech pages warn of throttling per docs/nvidia-stack.md): warm channels at connect, retry once, pre-rendered greeting, Cartesia switch, a polite exit line.
2. **LLM rate limits and latency shared with the web agents:** separate key, Brev failover, one LLM call per plain turn, calls capped at 5 min, 3 concurrent callers max.
3. **Noise plus 8 kHz audio garbles amounts and digits; and t3.medium headroom:** keypad PIN, read-back before simulating, RNNoise, 3-word barge-in, measured RSS/CPU in S4, resize if needed.
(Also: Twilio trial is not usable; do the upgrade before anything else.)

## Sources
- Twilio trial: https://www.twilio.com/docs/usage/trials , https://www.twilio.com/docs/usage/trials/try-out-voice , https://www.twilio.com/en-us/changelog/inbound-calls-to-trial-accounts-must-use-verified-callerid
- Twilio pricing and streams: https://www.twilio.com/en-us/voice/pricing/us , https://www.twilio.com/docs/voice/media-streams/websocket-messages , https://www.twilio.com/docs/voice/conversationrelay
- Telnyx: https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/trial , https://telnyx.com/pricing/voice-api (snippet only)
- Vonage: https://developer.vonage.com/en/voice/voice-api/concepts/websockets
- Pipecat: https://docs.pipecat.ai/pipecat/telephony/twilio-websockets , .../telnyx-websockets , https://docs.pipecat.ai/pipecat/learn/speech-input , https://docs.pipecat.ai/pipecat/learn/function-calling , https://docs.pipecat.ai/api-reference/server/utilities/turn-management/user-turn-strategies , https://docs.pipecat.ai/api-reference/server/services/{stt,tts,llm}/nvidia , .../serializers/twilio , .../transport/small-webrtc , https://docs.pipecat.ai/pipecat/features/krisp-viva , https://pypi.org/project/pipecat-ai/ , https://github.com/pipecat-ai/pipecat/blob/main/examples/voice/voice-nvidia.py
- NVIDIA: https://docs.nvidia.com/nemo/labs-voice-agent/ , .../build-voice-agents/model-serving/nvidia-nim-riva , https://build.nvidia.com/nvidia/nemotron-asr-streaming , https://build.nvidia.com/nvidia/magpie-tts-multilingual , https://docs.nvidia.com/nim/speech/latest/tts/voices.html , .../tts/customization.html , https://www.daily.co/blog/building-voice-agents-with-nvidia-open-models/ (RTX 5090 local numbers, not hosted) , https://archive.docs.nvidia.com/ace/ace-controller-microservice/latest/user-guide.html
- SpacetimeDB: https://spacetimedb.com/docs/http/database , https://spacetimedb.com/docs/sdks
- TTS vendors (third-party, unverified): https://invideo.io/blog/cartesia-sonic-ai-voice/ , https://openrouter.ai/elevenlabs/eleven-flash-v2.5
