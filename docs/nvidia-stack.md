# NVIDIA / Nemotron stack: verified picks (as of 2026-11-07)

Method: live `GET https://integrate.api.nvidia.com/v1/models` (public, no key), build.nvidia.com model cards (`<page>.md`), Hugging Face READMEs and API, PyPI, GitHub READMEs. No API key was available while researching, so NO chat/tool/structured-output request was executed. Anything marked UNVERIFIED is not live-tested; test it with your key first.

IMPORTANT: the ids previously in `.env.example` (`nvidia/llama-3.3-nemotron-super-49b-v1.5`, `nvidia/nvidia-nemotron-nano-9b-v2`) are NOT in the live model list. Do not use them.

## Recommended picks

| Role | Model id | Where it runs | Why |
|---|---|---|---|
| Agent backbone (default; **404s for our key, use Ultra**) | `nvidia/nemotron-3-super-120b-a12b` | API Catalog | 12B active, 1M ctx, catalog flags: function calling + structured output + reasoning all Supported |
| Hardest reasoning step (optional) | `nvidia/nemotron-3-ultra-550b-a55b` | API Catalog | Flagship (55B active). Catalog says structured output NOT supported; slower; use for 1 "wow" step |
| Fast extraction / classify / sub-agent | `nvidia/nemotron-3.5-lightning-30b-a3b` | API Catalog + self-host | 3B active, 1M ctx, tools + structured output Supported, thinking toggle |
| Tiny / cheapest | `nvidia/nemotron-3.5-bolt-e4b` | API Catalog | 4B, only 64K ctx on the endpoint |
| Page image -> markdown/tables/bboxes | `nvidia/nemotron-3.5-parse` (HTTP multipart) or `nvidia/nemotron-parse-2.0` (chat API) | API Catalog | Purpose-built OCR/layout parser, 9K-token ctx, one page per call |
| Page image -> JSON fields (VLM) | `nvidia/nemotron-3.5-super-vl-120b-a12b` | API Catalog | Images+video, 262K ctx, structured output Supported (early access) |
| Speech-to-text | Riva fn `bb0837de-8c7b-481f-9ec8-ef5663e9c1fa` (nemotron-asr-streaming) | `grpc.nvcf.nvidia.com:443` | English, native punctuation/caps; fallback Parakeet CTC fn `1598d209-5e27-4d3c-8079-4751568b1081` (has HTTP route) |
| Text-to-speech | Riva fn `877104f7-e885-42b9-8de8-f6e4c6303969` (magpie-tts-multilingual) | `grpc.nvcf.nvidia.com:443` | Voice `Magpie-Multilingual.EN-US.Aria` |
| Embeddings / rerank | `nvidia/nemotron-3.5-embed-1b` / `nvidia/nemotron-3.5-rerank-8b` | API Catalog | rerank endpoint shape UNVERIFIED |
| Guard | `nvidia/nemotron-3.5-content-safety` | API Catalog | Text + 1 image, returns `User Safety: safe/unsafe` |
| Self-host (tenvor) | `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` | vLLM >= 0.27.1 | ~25 GB repo, OpenMDW-1.1, built-in `nemotron_v3` reasoning parser |
| Fraud graph | hand-rolled networkx (+ optional cuGraph) | backend | Blueprint is not agentic, see section 7 |

## 1. LLMs on integrate.api.nvidia.com

Live Nemotron-family ids in `/v1/models` today: `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`, `nvidia/nemotron-3.5-super-vl-120b-a12b`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `nvidia/nemotron-nano-3-30b-a3b`, `nvidia/nemotron-3.5-bolt-e4b`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, plus older `nvidia/llama-3.1-nemotron-ultra-253b-v1`, `-70b-instruct`, `-51b-instruct`.

Reasoning toggle (all new models; NOT the old "/think" or "detailed thinking on" system prompts):
- On/off: `extra_body={"chat_template_kwargs": {"enable_thinking": True|False}}` (default on).
- Effort: Super `{"enable_thinking": True, "low_effort": True}`; Ultra `{"enable_thinking": True, "medium_effort": True}`.
- Budget: top-level body field `reasoning_budget=<int>` (only when thinking is on; keep `max_tokens` larger; the build.nvidia.com Lightning snippet sends it in `extra_body`).
- Trace comes back in `message.reasoning_content`; answer in `message.content`.
- Sampling per cards: `temperature=1.0, top_p=0.95` for everything (including tool calls). Use `enable_thinking=False` for extraction/classification to save latency.
- Ultra card: with tools + reasoning add `"force_nonempty_content": True` to `chat_template_kwargs` (card says SGLang needs it; harmless to send).

Capability flags from each model card ("Capabilities" block, i.e. catalog metadata, not a live test):

| Model | Function calling | Structured output | Context |
|---|---|---|---|
| super-120b-a12b | Supported | Supported | 1,048,576 |
| ultra-550b-a55b | Supported | Not supported | 1,048,576 |
| 3.5-lightning-30b-a3b | Supported | Supported | 1,048,576 |
| 3.5-bolt-e4b | Supported | Supported | 65,536 |
| 3.5-super-vl-120b-a12b | Supported | Supported | 262,144 |
| 3-nano-omni-30b-a3b-reasoning | Supported | Not supported | 262,144 |

Structured output mechanisms (UNVERIFIED on these specific endpoints, no key): (a) OpenAI `response_format={"type":"json_schema",...}`; (b) NIM extension `extra_body={"nvext": {"guided_json": schema}}` (documented for LLM NIMs: https://docs.nvidia.com/nim/large-language-models/1.13.0/structured-generation.html). Most robust trick that works on hosted AND vLLM: force a tool call (`tool_choice={"type":"function","function":{"name":"extract"}}`) whose parameters are your JSON schema, with `enable_thinking=False`, then validate with pydantic and retry once.

```python
import json, os
from openai import OpenAI

client = OpenAI(base_url=os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
                api_key=os.environ["NVIDIA_API_KEY"])
MODEL = os.getenv("NEMOTRON_MODEL", "nvidia/nemotron-3-super-120b-a12b")
FAST = os.getenv("NEMOTRON_FAST_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b")

TOOLS = [{"type": "function", "function": {
    "name": "lookup_entity", "description": "Find a borrower/entity and its linked deals.",
    "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}}}]
REGISTRY = {"lookup_entity": lambda name: {"name": name, "deals": ["D-101", "D-207"]}}

def run_agent(question: str, max_steps: int = 8) -> str:
    msgs = [{"role": "system", "content": "You are a loan-fraud analyst. Use tools; cite deal ids."},
            {"role": "user", "content": question}]
    for _ in range(max_steps):
        r = client.chat.completions.create(
            model=MODEL, messages=msgs, tools=TOOLS, tool_choice="auto",
            temperature=1.0, top_p=0.95, max_tokens=4096,
            extra_body={"chat_template_kwargs": {"enable_thinking": True}})
        m = r.choices[0].message
        if not m.tool_calls:
            return m.content or ""
        msgs.append({"role": "assistant", "content": m.content or "", "tool_calls": [
            {"id": t.id, "type": "function",
             "function": {"name": t.function.name, "arguments": t.function.arguments}} for t in m.tool_calls]})
        for t in m.tool_calls:
            out = REGISTRY[t.function.name](**json.loads(t.function.arguments))
            msgs.append({"role": "tool", "tool_call_id": t.id, "content": json.dumps(out)})
    return "step limit reached"

def extract_json(text: str, schema: dict, name="extract") -> dict:   # forced-tool structured output
    r = client.chat.completions.create(
        model=FAST, temperature=0.2, max_tokens=2048,
        messages=[{"role": "user", "content": text}],
        tools=[{"type": "function", "function": {"name": name, "description": "Return fields", "parameters": schema}}],
        tool_choice={"type": "function", "function": {"name": name}},
        extra_body={"chat_template_kwargs": {"enable_thinking": False}})
    return json.loads(r.choices[0].message.tool_calls[0].function.arguments)
```

## 2. Vision / document models

- `nvidia/nemotron-3.5-parse` (Oct 2026, 630M params): NOT a chat endpoint. `POST https://ai.api.nvidia.com/v1/retrieval/nvidia/nemotron-3.5-parse/parse`, multipart: `document` = one PNG/JPEG page, `options` = JSON. Response `result["content"]` holds control-token text (classes, bboxes, markdown tables). Recommended input up to 1664x2048 px; ctx 9,000 tokens, so ONE page per call; no function calling/structured output.
- `nvidia/nemotron-parse-2.0` (Sep 2026, 905M): chat completions with the control-token prompt plus `image_url`; recommended 1024x1280 to 1664x2048 px; max output ~9,000 tokens (raise `max_tokens` from the 1024 default). Older `nvidia/nemotron-parse` (Oct 2025) is the legacy version (exact request shape UNVERIFIED).
- VLM for "read this appraisal and give me JSON": `nvidia/nemotron-3.5-super-vl-120b-a12b` (images, 262K ctx; use vision sampling temp 0.6). `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` also takes images/video/audio but structured output is flagged unsupported. Inline-base64 size limits on the hosted API: UNVERIFIED (keep each image <= ~1.5 MB: render PDF at 150 dpi, JPEG q85).
- Best pipeline for loan files: PDF -> pymupdf pages -> Parse (markdown + tables) -> text model with `extract_json` schema per document type; fall back to the VLM for pages Parse mangles.

```python
import base64, json, os, pymupdf, requests

def pdf_pages(path, dpi=150):
    with pymupdf.open(path) as pdf:
        for p in pdf:
            yield p.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, alpha=False).tobytes("png")

def parse_page(png: bytes) -> str:            # Nemotron 3.5 Parse (multipart HTTP)
    r = requests.post("https://ai.api.nvidia.com/v1/retrieval/nvidia/nemotron-3.5-parse/parse",
        headers={"Authorization": f"Bearer {os.environ['NVIDIA_API_KEY']}", "Accept": "application/json"},
        files={"document": ("page.png", png, "image/png"),
               "options": (None, json.dumps({"decoding": {"max_output_tokens": 8000}}), "application/json")},
        timeout=120)
    r.raise_for_status()
    return r.json()["content"]

PARSE_PROMPT = "</s><s><predict_bbox><predict_classes><output_markdown><predict_text_in_pic>"
def parse_page_v2(png: bytes) -> str:         # Parse 2.0 via OpenAI SDK (client from section 1)
    b64 = base64.b64encode(png).decode()
    r = client.chat.completions.create(model="nvidia/nemotron-parse-2.0", temperature=0, max_tokens=8000,
        messages=[{"role": "user", "content": [{"type": "text", "text": PARSE_PROMPT},
                  {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}])
    return r.choices[0].message.content

def vlm_fields(png: bytes, schema_hint: str) -> str:   # Super VL straight to JSON
    b64 = base64.b64encode(png).decode()
    r = client.chat.completions.create(model=os.getenv("NEMOTRON_VL_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b"),
        temperature=0.6, top_p=0.95, max_tokens=4096,
        messages=[{"role": "user", "content": [
            {"type": "text", "text": f"Extract these fields as JSON only: {schema_hint}"},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}],
        extra_body={"chat_template_kwargs": {"enable_thinking": False}})
    return r.choices[0].message.content
```

## 3. Safety, embeddings, rerank (ids only)

- `nvidia/nemotron-3.5-content-safety` : Gemma-3-4B based, text + one image, output lines `User Safety` / `Response Safety` / `Safety Categories`.
- `nvidia/llama-3.1-nemotron-safety-guard-8b-v3` and `nvidia/llama-3.1-nemoguard-8b-content-safety` : older text guards (also live).
- `nvidia/nemotron-3.5-embed-1b`, `nvidia/nemotron-3.5-embed-8b` (text + document images), `nvidia/nemotron-3-embed-1b`, `nvidia/llama-nemotron-embed-vl-1b-v2` : embeddings via `client.embeddings.create(...)`; whether `input_type` ("query"/"passage") is required on the 3.5 models is UNVERIFIED.
- Rerank: `nvidia/nemotron-3.5-rerank-8b` listed on build.nvidia.com but not in `/v1/models` and its page was not fetchable (UNVERIFIED endpoint). HF: `nvidia/Nemotron-3.5-Rerank-8B-BF16`, `nvidia/llama-nemotron-rerank-1b-v2`.

## 4. Speech (Riva gRPC on NVCF)

Not in `/v1/models`; these are NVCF functions. Function ids below were read from each build.nvidia.com page's embedded spec (`nvcfFunctionId`):

| Model | Function id | Notes |
|---|---|---|
| nemotron-asr-streaming (Nemotron 3 ASR, EN) | `bb0837de-8c7b-481f-9ec8-ef5663e9c1fa` | Cache-aware FastConformer-RNNT, punctuation+caps. NIM also has a 40-locale profile (`type=multi`), unclear if hosted fn uses it |
| parakeet-ctc-1.1b-asr (EN) | `1598d209-5e27-4d3c-8079-4751568b1081` | Page documents an HTTP route (below) |
| parakeet-1.1b-rnnt-multilingual-asr (25 langs) | `71203149-d3b7-4460-8231-1be2543a1fca` | |
| canary-1b-asr | `b0e8b4a5-217c-40b7-9b96-17d84e666317` | multilingual + translation |
| parakeet-tdt-0.6b-v2 | `d3fe9151-442b-4204-a70d-5fcc597fd610` | |
| magpie-tts-multilingual (TTS) | `877104f7-e885-42b9-8de8-f6e4c6303969` | voice `Magpie-Multilingual.EN-US.Aria` |
| magpie-tts-flow (TTS) | `9b129749-e999-455b-a4bc-3c16858bbbc4` | |
| nemotron-voicechat | `42c86b5f-545a-4b2f-a83b-90fd71da9912` | speech-to-speech, skip |

Audio: the pages say Riva ASR wants mono, 16-bit audio in WAV/OGG-OPUS/FLAC. Browser `MediaRecorder` yields WebM/Opus (Chrome/Firefox) or MP4/AAC (Safari), which is NOT Ogg-Opus, so convert server-side to 16 kHz mono PCM WAV:
`ffmpeg -y -i in.webm -ac 1 -ar 16000 -sample_fmt s16 out.wav`
pydub: `AudioSegment.from_file("in.webm").set_channels(1).set_frame_rate(16000).set_sample_width(2).export("out.wav", format="wav")` (still needs the ffmpeg binary).

HTTP/OpenAI-style: there is NO `/v1/audio/transcriptions` on integrate.api.nvidia.com (UNVERIFIED but absent from the model list). The Parakeet-CTC page documents an NVCF HTTP route: `POST https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions` with `Authorization: Bearer`, form fields `language=en-US`, `word_time_offsets=True`, `file=@a.wav` (not live-tested). Also `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` accepts `audio_url`/`input_audio` (wav/mp3, English only) through chat completions, but its card says diarization is out of scope.

Diarization: not offered by the hosted ASR pages. `riva.client.add_speaker_diarization_to_config` exists in the client (server-side support on the hosted functions UNVERIFIED). Self-host `nvidia/Nemotron-3-Diarization` (99M params, NeMo, up to 8 speakers, OpenMDW-1.1). Zero-risk hack for Huddle: one push-to-talk button per family member and label speakers in the UI.

```python
# pip install nvidia-riva-client   (2.28.0)   |  run blocking calls with asyncio.to_thread in FastAPI
import os, subprocess, tempfile, wave, riva.client

def to_wav16k(raw: bytes) -> str:
    src = tempfile.NamedTemporaryFile(suffix=".webm", delete=False); src.write(raw); src.close()
    dst = src.name + ".wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src.name, "-ac", "1", "-ar", "16000",
                    "-sample_fmt", "s16", dst], check=True)
    return dst

def riva_auth(function_id: str) -> riva.client.Auth:
    return riva.client.Auth(uri=os.getenv("NVIDIA_ASR_SERVER", "grpc.nvcf.nvidia.com:443"), use_ssl=True,
        metadata_args=[["function-id", function_id], ["authorization", f"Bearer {os.environ['NVIDIA_API_KEY']}"]])

def transcribe(wav_path: str, lang="en-US") -> str:
    asr = riva.client.ASRService(riva_auth(os.environ["NVIDIA_ASR_FUNCTION_ID"]))
    cfg = riva.client.StreamingRecognitionConfig(
        config=riva.client.RecognitionConfig(language_code=lang, max_alternatives=1,
               enable_automatic_punctuation=True, verbatim_transcripts=False), interim_results=False)
    parts = []
    with riva.client.AudioChunkFileIterator(wav_path, 1600) as chunks:      # same flow as transcribe_file.py
        for resp in asr.streaming_response_generator(audio_chunks=chunks, streaming_config=cfg):
            parts += [r.alternatives[0].transcript for r in resp.results if r.is_final and r.alternatives]
    return " ".join(parts).strip()

def speak(text: str, out_wav="reply.wav", voice="Magpie-Multilingual.EN-US.Aria") -> str:
    tts = riva.client.SpeechSynthesisService(riva_auth(os.environ["NVIDIA_TTS_FUNCTION_ID"]))
    resp = tts.synthesize(text, voice_name=voice, language_code="en-US", sample_rate_hz=22050,
                          encoding=riva.client.AudioEncoding.LINEAR_PCM)
    with wave.open(out_wav, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050); w.writeframes(resp.audio)
    return out_wav
```
Node/TS worker note: AGENTS.md says the worker is Node + TypeScript (ASR at `POST /asr`), not Python. Python snippets here port directly to the `openai` npm package (pass `chat_template_kwargs` / `reasoning_budget` as extra body fields) and `@grpc/grpc-js` + the Riva protos; the lowest-effort ASR from Node is the Parakeet-CTC HTTP route above (`fetch` + `FormData`), or a tiny Python sidecar running `transcribe()`.
Fallback already in the plan: browser Web Speech API. Nemotron-3.5-Transcribe-30B-A4B (`nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B`, 67 GB repo) and `nvidia/nemotron-3.5-asr-streaming-0.6b` (40 locales, 8.8 GB, OpenMDW-1.1) exist on HF for self-hosting but are not worth the setup time tonight.

## 5. Self-hosting on tenvor.io

Pick: `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` (30B total / 3B active, 1M ctx, OpenMDW-1.1 commercial OK, HF repo 25.2 GB, not gated). Card hardware: native FP4 on Blackwell, W4A16 on Hopper (H100/H200) and Ampere (A100 80GB). Plan on a 40-80 GB GPU; it will NOT fit 24 GB. Needs `vllm >= 0.27.1` (PyPI latest today is 0.33.0). Command below is the card's W4A16 recipe (A100/H100); `--served-model-name`, `--max-model-len`, `--port` are my additions:

```bash
pip install -U "vllm>=0.27.1"
VLLM_HUMMING_MOE_GEMM_TYPE=indexed \
vllm serve nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4 \
  --served-model-name nemotron --port 8000 --max-model-len 131072 \
  --moe-backend humming --linear-backend humming \
  --max-num-seqs 256 --max-num-batched-tokens 32768 \
  --enable-prefix-caching --async-scheduling --quantization modelopt_fp4 \
  --mamba-backend flashinfer --mamba-cache-mode align --mamba-ssu-algorithm simple \
  --reasoning-parser nemotron_v3 --tool-call-parser qwen3_coder --enable-auto-tool-choice
```
Client: `OpenAI(base_url="https://<tenvor-host>/v1", api_key=...)`, `model="nemotron"`, same `chat_template_kwargs` / `reasoning_content` / `tools` as section 1 (vLLM supports `tool_choice` auto/required/named: https://docs.vllm.ai/en/latest/features/tool_calling/).

Alternatives: (a) `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8` (32.7 GB repo, "Nemotron Open Model License", vllm >= 0.12): `wget https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8/resolve/main/nano_v3_reasoning_parser.py` then `VLLM_USE_FLASHINFER_MOE_FP8=1 vllm serve nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8 --served-model-name nemotron --max-num-seqs 8 --max-model-len 262144 --trust-remote-code --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser-plugin nano_v3_reasoning_parser.py --reasoning-parser nano_v3 --kv-cache-dtype fp8` (tested H100-80GB). (b) 24 GB card: `nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB` (2-bit, 24.1 GB, VLM, OpenMDW-1.1) but its recipe needs a nightly vLLM image, `pip install b12x`, a custom `ultra_v3` reasoning-parser plugin and `--linear-backend b12x`; likely Blackwell-oriented, so treat as UNVERIFIED/risky for tonight. Note vLLM's reasoning docs list no Nemotron parser by name; parser names above come from the model cards.

## 5b. Brev: our own Nemotron on an NVIDIA Brev GPU (team has $60 of Brev credits)

Brev credits buy GPU hours, not API quota. A Brev instance serving Nemotron gives an OpenAI-compatible endpoint with no
shared rate limit; the worker uses it as provider `brev` (order `nvidia,brev,tenvor_qwen`: the API's Ultra plans first,
and when it rate-limits, runs move to our Brev Nemotron instead of Qwen; trace badges read "Nemotron Lightning · brev").

1. brev.nvidia.com → New instance → a single GPU with **48–80 GB** (L40S 48 GB is the cheapest fit for Lightning NVFP4;
   A100 80 GB or H100 80 GB if L40S is unavailable). At roughly $1–3/hour, $60 covers the rest of the event. Stop it overnight if
   nobody is demoing.
2. On the instance: the `vllm serve nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4 ...` command from section 5, plus
   `--api-key <random>` (the endpoint will be public). On non-Blackwell GPUs, if the NVFP4/humming flags fail, use alternative (a),
   Nemotron 3 Nano 30B-A3B FP8.
3. Expose port 8000 with Brev's public share URL (Brev console → Access → share a port).
4. In `.env` / `.env.prod`: `BREV_BASE_URL=https://<share-url>/v1`, `BREV_API_KEY=<the --api-key>`, `BREV_NEMOTRON_MODEL=nemotron`
   (the `--served-model-name`). Redeploy (`infra/deploy.sh`). `GET /worker/health` should then list `brev`.
5. Smoke test: `curl -s https://<share-url>/v1/models -H "Authorization: Bearer <key>"`.

## 6. Rate limits / credits (personal key)

- Free tier: 40 requests/minute, per NVIDIA developer-forum threads (https://forums.developer.nvidia.com/t/request-for-nvidia-build-api-rate-limit-increase-40-rpm-200-rpm/378450); a moderator states the limit "depends on model, use-case and the amount of current overall traffic" and cannot be raised on the free tier. The NIM FAQ says limits vary per model and shows your account's limit in the build.nvidia.com nav bar (https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317). Speech pages say "Traffic from other users may cause throttling".
- Credits: older guides cite ~1,000 credits on signup; current status UNVERIFIED (not stated in the FAQ).
- Plan for judges: keep `DEMO_MODE=cache_first` (hash of prompt -> stored response), pre-run the demo deals, use an asyncio semaphore of 3-5 and exponential backoff on HTTP 429, never fan out parallel tool calls per judge, route small steps to Lightning, and keep a tenvor vLLM fallback in `LLM_PROVIDER_ORDER`.

## 7. Fraud blueprint, cuGraph, NeMo Agent Toolkit

- Financial Fraud Detection Blueprint (https://github.com/NVIDIA-AI-Blueprints/financial-fraud-detection): GNN training container (`financial-fraud-training`, NGC, cuGraph team) -> Dynamo-Triton inference with Shapley-value explanations; notebooks run on synthetic data, locally in Docker, NGC key + one GPU >= 32 GB (A6000/A100/H100). Apache-2.0 repo. README mentions GNNs only (XGBoost UNVERIFIED) and has no LLM/agent part. Not a few-hours job; borrow the ideas (graph structure as features, per-decision explanations) and do not run it tonight.
- cuGraph (RAPIDS, `cugraph-cu12` 26.10.0 on PyPI): GPU graph analytics (connected components, PageRank, Louvain, Jaccard similarity); a NetworkX GPU backend (`nx-cugraph`) exists per prior knowledge, UNVERIFIED this session. Heavy CUDA/conda install; for a seed-data entity graph, networkx on CPU is instant. Only mention cuGraph as the scale-up story.
- NeMo Agent Toolkit (`nvidia-nat` 1.9.0, YAML workflows, ReAct/tool-calling agents, MCP, FastAPI serving): its README now carries a deprecation notice (deprecated Oct 2026, EOL end of 2026; migrate to NeMo Relay/Helix/Fabric). Recommendation: hand-roll the tool loop (section 1), because the toolkit is deprecated and a 40-line loop gives full control over streaming, caching and the audit trail the judges will see.
- Fraud design that fits the track: entity graph (networkx) + deterministic signals (shared address/phone/EIN/bank account/appraiser across deals, circular ownership, rent-roll/appraisal mismatch) exposed as tools; the Nemotron agent calls `graph_neighbors`, `compare_documents`, `check_registry` etc. and writes the case narrative.

## 8. Capital One Nessie

Live: `https://api.nessieisreal.com/customers?key=x` returned HTTP 200 `[]` and nessieisreal.com serves "Nessie is Real" (2026-11-07). Use HTTPS only (plain HTTP to the api host timed out); `api.reimaginebanking.com` did not respond. Get a real key from nessieisreal.com before relying on it.

## Sources
- https://integrate.api.nvidia.com/v1/models (live list)
- https://build.nvidia.com/nvidia/<model-id>.md (cards: nemotron-3-ultra-550b-a55b, nemotron-3-super-120b-a12b, nemotron-3.5-lightning-30b-a3b, nemotron-3.5-bolt-e4b, nemotron-3.5-super-vl-120b-a12b, nemotron-3-nano-omni-30b-a3b-reasoning, nemotron-parse-2.0, nemotron-3.5-parse, nemotron-3.5-content-safety, nemotron-asr-streaming, parakeet-ctc-1_1b-asr, magpie-tts-multilingual)
- https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4 , .../NVIDIA-Nemotron-3-Nano-30B-A3B-FP8 , .../NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB , .../Nemotron-3.5-Parse , .../Nemotron-3-Diarization
- https://github.com/nvidia-riva/python-clients , https://pypi.org/project/nvidia-riva-client/
- https://github.com/NVIDIA-AI-Blueprints/financial-fraud-detection , https://github.com/NVIDIA/NeMo-Agent-Toolkit
- https://docs.vllm.ai/en/latest/features/tool_calling/ , https://docs.vllm.ai/en/latest/features/reasoning_outputs/
- https://docs.nvidia.com/nim/large-language-models/1.13.0/structured-generation.html
