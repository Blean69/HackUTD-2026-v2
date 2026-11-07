# Keystone agent worker

Node 24 + TypeScript (strict) service that turns `agent_job` rows in SpacetimeDB into visible, multi-step Nemotron
agent runs. It is the only place LLMs, outside APIs and audio conversion live; the browser never calls it for data
(only `GET /health` and `POST /asr`).

```
SpacetimeDB "keystone"  --subscribe agent_job(queued)-->  worker  --claim_job-->  run workflow
        ^                                                    |  Nemotron (NVIDIA API -> tenvor.io -> local rules)
        |   start_run / emit_trace x N / agent_upsert_goal / agent_create_alert /          tools: ledger, forecast,
        +-- agent_update_scenario / agent_coach_reply / set_huddle_status /                simulator, anomalies, scam,
            purge_transcript / finish_run  <-----------------+                             FRED, College Scorecard
```

## Run it

```bash
spacetime start                                             # local DB on :3000 (CLI 2.14.1)
spacetime publish -s local -p spacetime keystone -y         # from the repo root
spacetime generate --lang typescript -p spacetime --out-dir services/worker/src/module_bindings -y
cd services/worker
npm install
npm run seed      # data/seed/*.json -> seed_* reducers (batched) -> recompute_household. Idempotent.
npm run dev       # tsx watch: claims jobs, serves :8787
npm test          # 79 unit/integration tests, no network, no database, no keys
npm run typecheck
```

With no API keys everything still works: the keyless `local` provider answers every LLM step with deterministic rules
that still call the real tools, and every trace event says `provider: local`.
Docker: `docker build -t keystone-worker services/worker` (node:24-slim + ffmpeg); pass the env vars below.

## Environment (loaded from the repo-root `.env` if present; real env vars win)

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER_ORDER` | `nvidia,tenvor_qwen` | Failover order. Nemotron on NVIDIA first, Qwen on tenvor.io as fallback only. `tenvor_nemotron` is still accepted if you list it. A provider whose key, model or base URL is empty is skipped silently. `local` (keyless rules) is appended last unless `LLM_LOCAL_FALLBACK=0`; set the order to `local` for a fully offline run. |
| `NVIDIA_API_KEY`, `NVIDIA_BASE_URL` | none, `https://integrate.api.nvidia.com/v1` | Provider `nvidia`. Enabled only with a key. |
| `NEMOTRON_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Planning + tool use ("agent" role). |
| `NEMOTRON_FAST_MODEL` | `nvidia/nemotron-3.5-lightning-30b-a3b` | Extraction / classification / structured output ("fast" role). |
| `TENVOR_BASE_URL`, `TENVOR_API_KEY`, `TENVOR_QWEN_MODEL` (optional `TENVOR_NEMOTRON_MODEL`) | | Provider `tenvor_qwen` (vLLM). Needs base URL, key and model id; an empty `TENVOR_BASE_URL=` line disables tenvor. |
| `NVIDIA_RPM` / `TENVOR_RPM` | `36` / `0` | Requests per minute per provider (free NVIDIA tier is about 40). 0 = unlimited. |
| `LLM_CONCURRENCY`, `LLM_TIMEOUT_MS`, `LLM_RETRIES` | `4`, `60000`, `1` | Global in-flight cap, per-request timeout, retries per provider before failing over. |
| `LLM_429_WAIT_MS` | `3000` | On HTTP 429 the worker waits/backs off on the same provider for up to this long (honouring Retry-After) before failing over, so Nemotron answers whenever possible. |
| `AGENT_THINKING` | `1` | Enable Nemotron reasoning for plans, tool-loop steps and the huddle summary; `reasoning_content` is shown as `thought` events. `0` = fastest. |
| `AGENT_MAX_STEPS` | `6` | Tool-loop iterations for the coach. |
| `DEMO_MODE` | `cache_first` | `cache_first` replays an earlier identical run (see below); `live` always calls the LLM. |
| `SPACETIME_URI`, `SPACETIME_DB`, `WORKER_SECRET` | `ws://localhost:3000`, `keystone`, `keystone-dev-secret` | Must match the published module. The identity token is saved in `.worker-token` (gitignored) so the worker keeps its identity. |
| `WORKER_PORT` | `8787` | HTTP port. |
| `DATA_DIR` | `../../data/seed` | Seed files (relative to `services/worker`). |
| `FRED_API_KEY` | none | Without it, `fred_series` answers from a fixed reference table and says `source: fixed_table`. |
| `DATA_GOV_API_KEY` | `DEMO_KEY` | College Scorecard. DEMO_KEY allows few calls per hour, so results are cached on disk (`.cache/`, 30 days). |
| `NVIDIA_ASR_FUNCTION_ID`, `NVIDIA_ASR_HTTP_FUNCTION_ID` | Parakeet CTC | See ASR. The `.env.example` value (nemotron-asr-streaming) is gRPC-only, so the HTTP route falls back to Parakeet CTC unless `NVIDIA_ASR_HTTP_FUNCTION_ID` is set. |

## What a run looks like (the glass box)

Every workflow emits `run_started`, then `plan` (the model writes a short numbered plan), then `thought` / `tool_call` /
`tool_result` / `handoff` / `message` steps, and ends with `final` (or `error`). Titles are human one-liners; `data_json`
stays under 4 KB (`fitJson` shrinks long arrays and strings; the module truncates anything bigger). Each event carries
`provider`, `model`, `latency_ms`, `tokens_in`, `tokens_out`. Non-LLM steps (tools, handoffs) inherit the provider/model
of the model that is driving the run.

| Workflow | Subject | Agents | What it does |
|---|---|---|---|
| `huddle` | huddle id | planner, goal_extractor, scam_guard, reconciler | transcript -> structured goals/concerns/dates (fast model) -> `detect_scam_signals` -> accounts/obligations/health/forecast -> `goal_feasibility` per goal (College Scorecard for college, FRED for home/business/debt) -> `agent_upsert_goal` with `evidence_quote` -> scam alert -> `set_huddle_status done` -> `purge_transcript` |
| `what_if` | scenario id | planner, simulator | prompt -> structured Scenario -> `simulate_scenario` (12-24 months) -> `get_forecast` -> narrative -> `agent_update_scenario` (shape = `ScenarioResult` in `apps/web/lib/types.ts`) |
| `coach` | message id | coach | plan -> real tool loop (up to `AGENT_MAX_STEPS`) -> `agent_coach_reply` (with `run_id`) |
| `data_quality` | household id | data_auditor | `detect_transaction_anomalies` -> plain-English explanation -> alerts (one summary for the rules `recompute_household` already alerts on, separate alerts for scam/outlier findings) |
| `scam_check` | household id | scam_guard | optional pasted text + gift-card/wire/card-testing payment scan -> alerts |

Goal ids are `goal_<household>_<slug>` and alert ids `agent:<household>:<key>`, so re-running a huddle updates instead of duplicating.

### DEMO_MODE=cache_first

Before a live run the worker fingerprints the input (lowercased, punctuation stripped; household mapped to its template
id so a sandbox equals its seed household; for data checks, a hash of the ledger). If a finished run exists with the same
workflow and fingerprint, it re-emits that run's trace events under the new run (provider `cache`, original model
name kept, original gaps compressed so the whole replay takes at most 8 s) and re-applies its results (goals, alerts,
scenario, coach reply, transcript purge) to the new subject. A worker that has a real provider configured only replays runs a real model answered (so a keyless test run can never
stand in for Nemotron); a keyless worker also replays `local` runs. New input always runs live.

## Tools (`src/tools/`)

One registry (`buildRegistry()` in `src/tools/index.ts`), each tool = zod schema (becomes the JSON schema the model sees)
+ a plain function returning small JSON + optional `describe`/`summarize` for the trace titles.

`get_accounts`, `get_transactions` (filters, `group_by`), `get_obligations`, `get_credit_profiles`,
`get_health_indicators`, `get_forecast` (the last two read what `recompute_household` computed in the DB),
`simulate_scenario` (purchase / income_change / payoff / new_loan / rate_change), `goal_feasibility`
(on_track / stretch / off_track with numbers), `detect_transaction_anomalies` (rules + median/MAD outlier score; the loader
drops `anomaly_truth`, so ground truth is unreachable), `detect_scam_signals` (phrase rules cross-checked against recent
gift-card / wire / crypto payments), `fred_series` (live FRED or fixed table), `college_scorecard` (live API with disk cache,
fixed UT Dallas / UT Austin fallback). External calls time out after 5 s and always say which path answered.

**Add a tool:** create `defineTool({ name, description, schema: z.object({...}), run: (args, { data, external }) => ... })`
in a new file and add it to `buildRegistry()`. Household data (`ctx.data`) comes from the SDK's client cache. Return small JSON.

**Add a workflow** (e.g. the upcoming `plaid_sync`): write a `WorkflowDef` (`name`, optional `cacheKey`, `run(run, job, env)`,
optional `onError`) and call `registerWorkflow(def)` in `src/workflows/index.ts`. Inside `run`, use `emitPlan` / `runAgentLoop`
(`src/agent/loop.ts`) or the primitives on `RunContext`: `run.tool(agent, name, args)`, `run.chat(...)`, `structured(...)`,
`run.emit(...)`, `run.goal/alert/scenario/coachReply/huddleDone` (these also record the effects that make cached replays work).
Jobs whose workflow is not registered stay `queued` for another worker.

## LLM layer (`src/llm/`)

`openai` npm client against any OpenAI-compatible endpoint; `chat_template_kwargs: {enable_thinking}` is sent in the body
(`low_effort` for Super, `reasoning_budget` on NVIDIA when thinking), `reasoning_content` becomes a `thought` event.
Failover on error / timeout with exponential backoff, and on 429 a short wait (up to `LLM_429_WAIT_MS`, honouring Retry-After)
before moving on, a cooldown for dead providers, a global concurrency cap and a per-provider sliding-window RPM limiter.
Whatever provider answers is what the trace says: a Qwen answer is labelled `tenvor_qwen` with the model id the server returned,
and a `Switched provider after nvidia: ...` message precedes it. `run_started` carries the provider that was tried first. Structured output = forced tool call + zod validation,
one retry with the validation error, then the local provider.

## HTTP (`src/http.ts`)

`GET /health` (provider states, models, SpacetimeDB state, workflows, tools). `POST /asr?huddle_id=&speaker=` takes
webm/ogg/wav/mp4, runs `ffmpeg -ac 1 -ar 16000 -sample_fmt s16`, posts the WAV to
`https://<function-id>.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions` and calls `append_transcript` as the
worker. It returns **503 `{"error":"asr_unavailable"}`** when there is no key, no ffmpeg, or the call fails, so the browser
falls back to Web Speech. **This route is untested against the live NVIDIA endpoint (no API key was available while it was
written);** the conversion, request shape and error handling are covered by tests with a fake `fetch`.
CORS is open. Routes live in a small `Router`: register more with `router.add('POST', '/path', handler)` or
`router.addPrefix('POST', '/plaid/', handler)` on the shared `router` exported from `src/router.ts` (import your route module at the top of `src/index.ts`).

## Layout

```
src/index.ts        wiring: HTTP, SpacetimeDB connection, job intake
src/jobs.ts         dedupe + claim (races handled) + bounded concurrency
src/agent/          RunContext (trace + effects), agent loop, runner, cache_first replay, sink interface
src/workflows/      huddle, what_if, coach, audit (data_quality, scam_check), registry
src/tools/          registry + tools + finance helpers + external APIs
src/llm/            providers, failover client, limiter, structured output, local rule-based provider
src/db/             SpacetimeDB adapters: connection, sink (reducer calls), household loader, run history
src/module_bindings generated by `spacetime generate` -- never edit
src/seed.ts         npm run seed
```
