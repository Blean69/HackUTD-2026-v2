# Contracts (binding)

Change a contract here first, then in code. The SpacetimeDB module (`spacetime/`) is the source of truth for types;
the web app and the worker use bindings generated from it (`spacetime generate`), never hand-written copies.

```
 phones/laptops (Next.js)  ──subscribe + call reducers──►  SpacetimeDB module "keystone"  ◄──subscribe + call reducers──  agent worker (Node)
                                                           tables · reducers · scheduled                                  Nemotron agents · tools · ASR
```

## 1. Seed data files (`data/seed/`)

Written by `data/generate.py`, loaded into SpacetimeDB by `services/worker/src/seed.ts` (calls the `seed_*` reducers in batches).
Ids are strings with a type prefix (`hh_`, `mem_`, `acct_`, `txn_`, `obl_`, `conv_`, `goal_`). Dates are ISO strings. Money is a number (USD).

```ts
Household     { id, name, city, state, persona, home_value: number /* 0 if renting */, vehicle_value: number }
Member        { id, household_id, name, age, role: "parent"|"child"|"grandparent"|"other", income_annual }
Account       { id, household_id, owner_member_ids: string[], type: "checking"|"savings"|"cd"|"ira"|"auto_loan"|
                "personal_loan"|"credit_card"|"mortgage", institution, nickname, balance, rate_pct?, credit_limit?,
                monthly_payment?, maturity_date?, opened_date }
Transaction   { id, household_id, account_id, date, amount /* negative = outflow */, merchant, category, description, is_recurring,
                anomaly?: "duplicate"|"garbled"|"impossible_value"|"card_testing"|"account_takeover"|"scam_payment"|"outlier" }  // ground truth; never shown in UI
CreditProfile { member_id, household_id, score, utilization_pct, hard_inquiries_12m, oldest_account_years, late_payments_24m }
Obligation    { id, household_id, name, amount, due_day, account_id, kind: "bill"|"loan"|"subscription"|"tuition"|"insurance"|"tax" }
Conversation  { id, household_id, title, turns: {speaker, text}[], expected_goals: Goal[], scam_signals?: string[] }
```
Conventions (from the generator):
- Debt accounts (`auto_loan`, `personal_loan`, `credit_card`, `mortgage`) store `balance` as the **positive amount owed**; a positive transaction on them is a payment received.
- `obligations` is the complete schedule of recurring outflows, loan and card payments included (`kind: "loan"`), paid from checking.
  Forecast = checking + savings now, plus recurring **inflows** (`is_recurring` and amount > 0), minus obligations on their `due_day`,
  minus average daily discretionary spend (non-recurring outflows). Do not also subtract recurring outflow transactions, or bills count twice.
- Net worth = checking + savings + cd + ira + `home_value` + `vehicle_value` − debt balances.
- `anomaly` is omitted when empty. Duplicate and impossible-value rows are excluded from true balances.

Households: `hh_rivera` (hero, bakery owners), `hh_okafor`, `hh_nguyen` (elder-scam target), `hh_patel` (messy data), `hh_brooks`.

## 2. SpacetimeDB module `keystone` — tables

All tables public for the hackathon (row-level security is P1). Arrays/objects that don't need querying are JSON strings (`*_json`).
Row ids are strings unless marked `u64 auto`. `ts`/`*_at` are SpacetimeDB `Timestamp`. Every household-scoped table has an index on `household_id`.

| Table | Columns | Written by |
|---|---|---|
| `household` | id pk, name, city, state, persona, home_value, vehicle_value, template_id (""=seed template), owner (Identity?), created_at | seed, `create_sandbox` |
| `member` | id pk, household_id, name, age, role, income_annual | seed, sandbox copy |
| `account` | id pk, household_id, type, institution, nickname, balance, rate_pct, credit_limit, monthly_payment, maturity_date, opened_date, owner_member_ids_json | seed, sandbox copy |
| `txn` | id pk, household_id, account_id, date, amount, merchant, category, description, is_recurring, anomaly_truth ("" if none) | seed, sandbox copy |
| `credit_profile` | member_id pk, household_id, score, utilization_pct, hard_inquiries_12m, oldest_account_years, late_payments_24m | seed |
| `obligation` | id pk, household_id, name, amount, due_day, account_id, kind | seed |
| `conversation` | id pk, household_id, title, turns_json, expected_goals_json, scam_signals_json | seed (sample Huddles) |
| `health_indicator` | id pk (`{household_id}:{key}`), household_id, key, label, value, unit, status, explanation, updated_at | reducer `recompute_household` (math runs in the DB) |
| `forecast_point` | id pk (`{household_id}:{date}`), household_id, date, balance, obligations_due | reducer `recompute_household` |
| `alert` | id pk, household_id, severity info/warn/critical, kind data_quality/fraud/scam/obligation/advisor, title, detail, related_ids_json, created_at, acknowledged_by ("" if open) | worker, `recompute_household` (rule hits) |
| `goal` | id pk, household_id, title, target_amount, target_date, priority, feasibility (""/on_track/stretch/off_track), evidence_quote, source huddle/manual/coach, created_at, updated_at | worker, family (`upsert_goal`) |
| `presence` | identity pk, household_id ("" = lobby), display_name, role family/advisor/guest, last_seen | lifecycle reducers + `join_room` |
| `huddle` | id pk, household_id, started_by_name, status live/analyzing/done, started_at, ended_at, consent_names_json | `start_huddle`, `end_huddle`, worker |
| `transcript_line` | id u64 auto pk, huddle_id, household_id, speaker, text, ts | `append_transcript` (any participant, ASR worker); **deleted** by `purge_transcript` after analysis |
| `scenario` | id pk, household_id, prompt, status queued/running/done/error, result_json, requested_by_name, created_at | `request_simulation`, worker |
| `coach_message` | id u64 auto pk, household_id, role user/assistant, author_name, text, run_id, created_at | `ask_coach`, worker |
| `advisor_note` | id u64 auto pk, household_id, author_name, text, created_at | `post_advisor_note` |
| `agent_job` | id u64 auto pk, workflow, household_id, subject_id, input_json, status queued/claimed/done/error, claimed_by (Identity?), run_id, created_at | reducers that enqueue work; worker claims |
| `agent_run` | run_id pk, job_id, workflow, household_id, status running/done/error, started_at, finished_at, providers_json, result_json | worker |
| `trace_event` | id u64 auto pk, run_id, household_id, seq, ts, workflow, agent, type, title, data_json, model, provider, latency_ms, tokens_in, tokens_out | worker (`emit_trace`) |
| `worker` (private) | identity pk, label, registered_at | `register_worker` |
| `phone_access` (private) | household_id pk, pin_hash, salt, updated_at, set_by (Identity) | `set_phone_pin`, `clear_phone_pin`. `pin_hash = sha256_hex("keystone/phone-pin/v1:" + salt + ":" + pin)`; the code itself is never stored or logged |
| `phone_access_status` | household_id pk, has_pin, updated_at | same reducers (what the UI reads; never the code or its hash) |

### Trace event semantics (the NVIDIA story)
`workflow` ∈ huddle | what_if | coach | scam_check | data_quality | plaid_sync | onboarding_insights | phone. `agent` e.g. planner, goal_extractor, reconciler, voice_agent,
scam_guard, data_auditor, simulator, coach. `type` ∈ run_started | plan | thought | tool_call | tool_result | handoff | message | final | error.
`title` is one human-readable line. `data_json` ≤ 4 KB. `provider` ∈ nvidia | brev | tenvor_nemotron | tenvor_qwen | cache | local.

## 3. Reducers

Client-callable (any identity):
| Reducer | Args | Effect |
|---|---|---|
| `join_room` | household_id, display_name, role | upsert caller's `presence` |
| `create_sandbox` | template_household_id, display_name | deep-copies a seed household (members, accounts, txns, credit, obligations, conversations) to a new id `hh_sbx_<short>` owned by caller; runs `recompute_household`; enqueues a `data_quality` job |
| `start_huddle` | household_id, consent_names_json | creates `huddle` (status live) |
| `append_transcript` | huddle_id, speaker, text | inserts `transcript_line` (rejects if huddle not live) |
| `end_huddle` | huddle_id | status → analyzing; enqueues `agent_job` workflow=huddle, subject_id=huddle_id |
| `request_simulation` | household_id, prompt | inserts `scenario` + enqueues `what_if` job |
| `ask_coach` | household_id, text | inserts user `coach_message` + enqueues `coach` job |
| `upsert_goal` / `delete_goal` | goal fields / id | family edits |
| `ack_alert` | alert_id, display_name | sets acknowledged_by |
| `post_advisor_note` | household_id, author_name, text | inserts note + an `advisor` alert |
| `recompute_household` | household_id | recomputes health indicators, 90-day forecast, rule-based data-quality alerts (pure math, deterministic) |
| `set_phone_pin` | household_id, pin | the household's 5-digit phone code (section 8). Caller must be the household owner or, for a seeded household (no owner), be in its room. Rejects: not exactly 5 digits, weak (same digit, a straight run up or down such as 12345 / 54321 / 67890, two alternating digits), or a code another household already uses (each other row's salted hash is recomputed and compared). New random salt on every change |
| `clear_phone_pin` | household_id | same callers; deletes the hash and sets `phone_access_status.has_pin` false |

Lifecycle: `client_connected` (no-op or lobby presence), `client_disconnected` (delete presence).
Scheduled: `tick_recompute` every 60 s recomputes households with recent changes.

Worker-only (reject unless `ctx.sender` is in `worker`):
| Reducer | Effect |
|---|---|
| `register_worker(secret, label)` | adds caller to `worker` if secret matches the module constant `WORKER_SECRET_SHA256` (set before publish) |
| `claim_job(job_id)` | queued → claimed (atomic; second claimer fails) |
| `agent_request_simulation(household_id, prompt, requested_by_name)` | `request_simulation` on the worker's behalf (Brian saving a what-if to the What-If Studio): the same `scenario` row and queued `what_if` job, shown under `requested_by_name` ("Brian (AI)") instead of "Someone" (the worker has no presence row) |
| `agent_enqueue_job(workflow, household_id, subject_id, input_json)` | queues a job on the worker's behalf (workflow must be one of the allowed ones, incl. `phone`; refuses a second queued job for the same workflow + subject). A live call is enqueued, claimed and run by the worker itself: no `WorkflowDef` exists for `phone`, so the `JobQueue` ignores those jobs |
| `start_run(run_id, job_id)` / `finish_run(run_id, status, providers_json, result_json)` | run lifecycle; also marks job done/error |
| `emit_trace(run_id, seq, workflow, agent, type, title, data_json, model, provider, latency_ms, tokens_in, tokens_out)` | inserts `trace_event` |
| `agent_upsert_goal`, `agent_create_alert`, `agent_update_scenario`, `agent_coach_reply`, `set_huddle_status` | write results |
| `purge_transcript(huddle_id)` | deletes that huddle's transcript lines (privacy: we keep goals + short evidence quotes only) |
| `worker_phone_access` (VIEW, `public` but empty for everyone who is not in `worker`) | the `phone_access` rows (household_id, pin_hash, salt, updated_at, set_by). The worker subscribes to `SELECT * FROM worker_phone_access` and checks a caller's digits against it. A view, not a `verify_phone_pin` reducer, because a 2.14.1 reducer returns nothing to its caller (same pattern as `worker_plaid_items`) |
| `seed_households`, `seed_members`, `seed_accounts`, `seed_txns`, `seed_credit`, `seed_obligations`, `seed_conversations` (rows_json) | bulk insert from `data/seed/` |

### As built (module agent, spacetimedb 2.14.1): deviations to know
- Card-testing alerts use kind `fraud` (critical). Extra rule alerts: `repost` (info) and a forecast `overdraft` (kind `obligation`). Rule alert ids start with `rule:`.
- The forecast also averages irregular deposits (owner draws); set `FORECAST_INCLUDE_IRREGULAR_INCOME=false` in the module for the strict formula.
- `goal.priority` is an `i32`. Optional account fields are `option` types. Clients see camelCase names in bindings (`healthIndicator`, `joinRoom`).
- `start_huddle` joins an already-live huddle and merges consent names; it rejects an empty consent list.
- Extras: `delete_sandbox` (owner only), `worker_plaid_items` view (registered workers only).
- Exact worker-reducer arguments: see `spacetime/README.md` and the generated bindings.
- `scenario.result_json` shape the UI expects: `apps/web/lib/types.ts` → `ScenarioResult` {summary, verdict fine/tight/risky, metrics[], series[], low_point, suggestion}.

- Worker as built: `agent_run.result_json` also carries `cache_key` and `effects` for cache replay, so UIs shouldn't depend on its shape. `what_if` results match `ScenarioResult` plus `scenario`, `assumptions`, `headline`. `/health` also returns `local`, `models`, `workflows`, `tools`, `demo_mode`. Plaid hooks: `services/worker/src/router.ts` (`router.add/addPrefix`) and `registerWorkflow()` in `src/workflows/index.ts`.

## 4. Worker HTTP (small; everything else goes through SpacetimeDB)
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | provider status `{nvidia, tenvor_nemotron, tenvor_qwen, spacetime}` |
| POST | `/asr?huddle_id=&speaker=` | audio chunk (webm/opus or wav) → NVIDIA ASR → calls `append_transcript` as the worker. 503 if ASR unavailable (browser speech fallback) |

## 5. Plaid Sandbox (real bank-API data)

Plaid is an external data source, never a second database: everything it returns is written into SpacetimeDB tables.
Plaid calls happen only in the worker (secrets in env: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox`).

Tables (added to the module):
| Table | Columns | Notes |
|---|---|---|
| `plaid_item` (**private**) | item_id pk, household_id, access_token, institution_id, institution_name, cursor, created_at | never visible to clients |
| `bank_connection` | item_id pk, household_id, institution_name, status linking/syncing/ok/error, accounts_count, txns_count, last_synced_at, error | what the UI shows |
| `account`, `txn` | + `source` column: `seed` or `plaid` | Plaid rows use ids `acct_plaid_<plaid account_id>`, `txn_plaid_<transaction_id>` |

Reducers: `request_bank_sync(household_id)` (any client; enqueues `plaid_sync`), and worker-only `agent_save_plaid_item`,
`agent_set_bank_connection`, `agent_upsert_accounts(rows_json)`, `agent_upsert_txns(rows_json)`, `agent_remove_txns(ids_json)`.
New workflow `plaid_sync`: fetch accounts, balances, liabilities and `/transactions/sync` → map Plaid types/subtypes to our 8 account
types (Nemotron explains any ambiguous mapping) → upsert → `recompute_household` → `data_quality` check. All of it traced.

Worker HTTP (adds to section 4):
| Method | Path | Purpose |
|---|---|---|
| POST | `/plaid/link_token` `{household_id}` | `/link/token/create` (products: transactions, liabilities, investments) → `{link_token}` for Plaid Link in the browser |
| POST | `/plaid/exchange` `{household_id, public_token}` | exchange → `agent_save_plaid_item` → queue `plaid_sync` |
| POST | `/plaid/sandbox_connect` `{household_id, username?}` | demo shortcut, no Link UI: `/sandbox/public_token/create` on First Platypus Bank (`ins_109508`) with `user_transactions_dynamic` (default) or `user_good`, then same as exchange |

Sandbox test login in Plaid Link: `user_good` / `pass_good` (shown as a hint in our UI; these are Plaid's public sandbox values).

## 6. Family voting (Spacetime multiplayer feature)

A family member proposes a purchase or decision; everyone in the room votes live; an agent attaches an affordability check.

| Table | Columns |
|---|---|
| `proposal` | id pk (`prop_…`), household_id, title, amount, details_json (e.g. `{"down_pct":20,"term_months":60,"rate_pct":6.2}`), created_by_name, created_at, closes_at, status open/closed, verdict (""/fine/tight/risky), analysis_json, run_id |
| `vote` | id pk (`{proposal_id}:{voter_key}`), proposal_id, household_id, voter_key (caller identity hex, or member id for seeded votes), voter_name, choice yes/no/abstain, updated_at |

Reducers: `create_proposal(household_id, title, amount, details_json, closes_in_days, author_name)` (also enqueues an
`agent_job` with workflow `what_if` and `subject_id` = proposal id, so the affordability check runs automatically),
`cast_vote(proposal_id, choice, voter_name)` (one vote per identity, can change until closed), `close_proposal(proposal_id)`,
worker-only `agent_update_proposal(proposal_id, verdict, analysis_json, run_id)`, and `seed_proposals(rows_json)` / `seed_votes(rows_json)`.
Seed files: `data/seed/proposals.json`, `data/seed/votes.json`. `create_sandbox` copies proposals and seeded votes.

## 7. Onboarding (connectors first): link a bank, pick accounts, answer questions, dashboard fills itself

Route `/onboarding` (web). Every step is SpacetimeDB state, so a second family member can join mid-flow and see progress.

1. **Welcome + consent.** What we read (balances, transactions, liabilities), sandbox data only.
2. **Create household.** `start_onboarding(household_name, display_name)` → new `household` (`hh_onb_<suffix>`, owner = caller,
   template_id ""), a `member` for the caller, and a `household_profile` row (status `connect`).
3. **Connect a bank.** Plaid Link (sandbox) or "Use the demo bank" one-tap. The worker routes take `{household_id, select: true}`.
   The worker exchanges the token, calls `/accounts/get`, writes `bank_account_option` rows, and sets `bank_connection.status = "selecting"`.
   The demo bank is a **Plaid Sandbox custom user** defined in `data/plaid/sandbox_user.json` (checking, savings, credit card, mortgage,
   auto loan, IRA, CD, about 6 months of realistic transactions). One-tap connect passes it as `override_username: "user_custom"` and
   `override_password: <json>`. The same JSON can be saved as a named sandbox user in the Plaid Dashboard for the Link UI path.
4. **Choose accounts.** Checkboxes (all on by default) → `select_bank_accounts(household_id, item_id, account_ids_json)` →
   enqueues `plaid_sync`, which imports only the selected accounts (status syncing → ok).
5. **Questions** (asked while the sync runs): members (name, role, age, income); own or rent plus home value; vehicle value;
   top priorities (emergency fund, home, college, retirement, debt payoff, travel, business, caring for parents) plus a free-text
   goal; risk comfort 1–5; family voting on/off; Table Mode voice consent. Saved with `save_onboarding_answers(household_id, answers_json)`,
   which upserts members, `home_value`/`vehicle_value`, goals (source `onboarding`) and the profile.
6. **Finish.** `finish_onboarding(household_id)` → `recompute_household` plus an `onboarding_insights` agent job: Nemotron reads accounts,
   transactions and answers, writes 3–5 plain-English insights (alert kind `insight`), checks each goal's feasibility, and
   suggests a first proposal. The UI then lands on the dashboard.

| Table | Columns |
|---|---|
| `household_profile` | household_id pk, onboarding_status welcome/connect/selecting/questions/done, answers_json, risk_comfort, priorities_json, voting_enabled, voice_consent, created_at, updated_at |
| `bank_account_option` | id pk (`{item_id}:{account_id}`), household_id, item_id, account_id, name, official_name, mask, type, subtype, balance, selected |

Worker-only: `agent_set_account_options(household_id, item_id, rows_json)`. Alert `kind` gains `insight`.

## 8. Voice line: "Talk to Keystone" button + optional phone number (built; design in `docs/voice-agent.md`, `docs/voice-selfhost.md`)

A warm voice explains the household's finances in plain words and runs what-ifs by voice. Constraints: Nemotron answers through
the same tools as the coach; every call is a traced `agent_run` (workflow `phone`, agent `voice_agent`), so the Agent Trail shows it;
synthetic data only; the first thing spoken is a disclosure that it is an AI assistant (no recording, demo data).

- **Browser (primary):** Pipecat SmallWebRTC. `POST {VOICE_BASE}/api/offer` with the standard SmallWebRTC offer JSON
  (`sdp`, `type`, `pc_id`, `restart_pc`, `requestData`/`request_data` = `{household_id, display_name}`); `PATCH` for trickle ICE.
  Local `VOICE_BASE=http://localhost:7860`, prod `https://<host>/voice` (Caddy strips the prefix). No PIN: the household comes from the request data.
  RTVI events carry the live captions, and one server message `{type: "run", run_id}` is sent as soon as the call's `agent_run` exists.
- **Phone (optional):** SignalWire number -> `POST /voice/twiml` (cXML `<Connect><Stream>`) -> `wss://<host>/voice/ws`; a 5-digit keypad code
  (3 tries per call) gates everything. Each household sets its own in the app (`set_phone_pin`, "Call Brian" in the header and as an optional last
  onboarding item; the number shown comes from `NEXT_PUBLIC_PHONE_NUMBER`). `/phone/identify` checks those household codes first (salted hashes read through
  the `worker_phone_access` view, constant-time compare against every row), then the worker env `PHONE_PINS=12345:hh_rivera` (the seeded demo
  households keep theirs there; the UI says "Demo code: ask the team"). A worker log line records only the outcome of each attempt, never the digits. Caller numbers are only ever stored as a salted hash.
- **Worker routes** (internal, `x-voice-secret` = `VOICE_SHARED_SECRET`; Caddy answers 404 for `/worker/phone/*`): `POST /phone/identify`,
  `POST /phone/start`, `GET /phone/tools`, `POST /phone/tool`, `POST /phone/trace`, `POST /phone/end`. Tools are `get_health_indicators, get_forecast,
  get_obligations, get_accounts, simulate_scenario, goal_feasibility, detect_scam_signals` (the list in `PHONE_TOOLS` also has `get_credit_score`, `find_savings`, the kids' tools and the
  confirm-first tools of section 8a); the model gets a trimmed `voiceView` of each result.
- **Trace of a call:** `run_started` "Voice call connected (Rivera family)" -> `plan` -> briefing `tool_call`/`tool_result` ->
  per turn `message` "Heard: ..." (model `nemotron-asr-streaming`) and "Said: ..." (Lightning; data has LLM first-token, TTS first-audio and voice-to-voice ms)
  with `tool_call`/`tool_result` between them -> `final` (turns, tool calls, p50/p95 voice-to-voice).
- **Hold-to-talk and the speakerphone guard (browser -> voice agent; added for echo/noise).** Pipecat's RTVI has no client event for
  "the user stopped speaking" (`user-stopped-speaking` is server -> client only), so the web client sends two RTVI *client messages*
  (`client-message`; on the wire `data: {t: <type>, d: <payload>}`; in Pipecat Python `on_client_message(rtvi, msg)` with
  `msg.type`, `msg.data`). The audio itself never changes shape: the browser keeps sending its single Opus audio track, and while
  the mic is gated (hold-to-talk idle, or the guard while the bot talks) the track is *disabled*, so RTP keeps arriving as digital
  silence. The client does **not** use `trackStatus` for this (only the Mute button does), so the server must not read silence as
  "the caller left" and Silero VAD still sees the pause that ends a turn.

  | `msg.type` | `msg.data` | Sent when | The voice agent should |
  |---|---|---|---|
  | `ptt` | `{state: "enabled"}` | the person turned "Noisy room? Hold to talk" on (also once right after connect if it was already on) | Expect silence between presses. Skip "are you still there?" idle prompts, and it is safe to shorten the turn-end wait (Smart Turn / hesitation hold) because the end of a turn is now explicit. |
  | `ptt` | `{state: "disabled"}` | turned off (also ends any held press) | Back to normal turn detection. |
  | `ptt` | `{state: "pressed"}` | the Hold button went down | Treat as a deliberate barge-in: interrupt the bot now (cancel TTS, flush audio) without waiting for VAD + `barge_in_words`. |
  | `ptt` | `{state: "released"}` | the button went up; the mic stayed open ~250 ms after the release so the last syllable is already on the wire | End the user's turn **now**: stop waiting for VAD `stop_secs`, Smart Turn and the hesitation hold, drain ASR for ~150-300 ms, then send the aggregated transcript to the LLM. Ignore it if nothing was transcribed. |
  | `interrupt` | none | the phone "Interrupt" button (speakerphone guard: the mic was closed while the bot spoke, and the tap re-opened it) | Stop speaking now (same as a barge-in). Best effort: a bot that ignores it simply hears the person next. |

  Unknown `state` values and unknown message types must be ignored (no `error-response`). Nothing here needs a reply. The client
  also reports `micLive` / `botSpeaking` locally from the RTVI `bot-started-speaking` / `bot-stopped-speaking` events the bot already
  sends, so those two events must keep being emitted around every spoken answer. Not implemented in `services/voice` yet: until it
  is, hold-to-talk still works (the mic is silent between presses and the VAD ends the turn on its own timers), just without the
  instant end-of-turn.

### 8a. What Brian can change (confirm-first tools; `services/worker/src/tools/`)

Besides the kids' jars, Brian does most of what a family member does by hand in the app, only when the caller asks and says yes.
Brian never moves real money: these are app records. The one place his words touch "money" stays the kids' allowance jars.

- **The confirm rule is enforced by the worker, not the prompt** (`tools/confirm.ts`, the call session's `act`). Every write tool takes `confirmed: boolean`.
  The first call for an action only returns `{done: false, ask, note}` (`ask` = the question to say back) and records the action's key (its essentials: what,
  which one, how much; never free text). A call with `confirmed: true` writes only if that key was proposed earlier in the same call at least 2.5 s before;
  the write uses the yes up, so the same call twice cannot write twice. A different amount, date or target needs its own yes.
- **Scope:** `act` exists only in Brian's call session. Writes go to the call's household as the worker, named "Brian (AI)" where a reducer takes a name. Ids are resolved
  from that household's own rows by a few spoken words (case, plural and spelling tolerant); no match or two equally good matches returns an error that lists the choices.
- **Not offered to the Ask coach, Table Mode or what-ifs:** every tool with a `confirmed` flag is in `WRITE_TOOLS` (a test enforces it).

| Tool | Kind | Caps and guards | What it writes |
|---|---|---|---|
| `get_goals` | read | 6 goals, priority order | none |
| `change_goal {action: add \| update \| delete, goal, target_amount?, target_date?}` | write | amount $1 to $1,000,000; a real future day within 50 years; no duplicate title; gambling and speculation are `not_advised` | add/update: `agent_upsert_goal` (source `manual`, id `goal_brian_…`, priority 2, and the same `goal_feasibility` verdict Table Mode saves; the Goals page's own `upsert_goal` leaves a hand-made goal unchecked); an update keeps the goal's id, title, priority, quote and source. delete: `delete_goal` |
| `save_what_if {question}` | write | 6 to 300 characters; any dollar figure at most $10,000,000 | `agent_request_simulation` (scenario row + queued `what_if` job, shown in the What-If Studio under "Brian (AI)") |
| `get_alerts` | read | open alerts only, worst first, 4 shown | none |
| `mark_alert_handled {alert}` | write | open alerts only; a critical one is asked about more firmly | `ack_alert` ("Mark handled") |
| `get_proposals` | read | 3 shown, open votes first, with the yes / no / not sure tally and the affordability check | none |
| `create_proposal {title, amount, days_open?}` | write | amount $1 to $1,000,000; 1 to 14 days (default 5); no duplicate open vote | `create_proposal` (the module queues the affordability check) |
| `approve_kid_chore {kid_name, chore?}` | write | only a chore the kid marked done; reward at most $100 | `approve_kid_task` (pays the reward into the jar once) |
| `set_kid_goal {kid_name, goal, target}` | write | target $1 to $5,000; says which goal it replaces | `set_kid_goal` |

Brian has **no voting tool**: `cast_vote` keys a vote by the caller's own SpacetimeDB identity, and the worker is one identity for every family, so Brian could only
fake a voter (and each new caller would overwrite the last). Family members vote in the app.
Skipped on purpose: deleting households, phone codes, Plaid/bank connections, onboarding, and Table Mode recording (consent has to be given in person).

## 7b. Sandbox bank profiles (PNC dataset → Plaid Sandbox custom users)

The demo bank offers several realistic customers built from PNC's HackUTD 2026 dataset, each a Plaid Sandbox custom user
(`data/plaid/profiles/<profile_id>.json`, plus `data/plaid/profiles/index.json`). They live on the **Log in** page, not in
sign-up: tapping a customer creates a household and runs the wizard's steps automatically (`start_onboarding` →
`sandbox_connect {profile_id}` → select all accounts → wait for the sync → `save_onboarding_answers` → `finish_onboarding`),
then opens the dashboard. The sign-up wizard offers only Plaid Link (primary, sandbox login shown) and a one-tap "demo bank"
(`sandbox_connect` without `profile_id` = `family_demo`), then the existing `bank_account_option` step.

| Method | Path | Returns / does |
|---|---|---|
| GET | `/plaid/sandbox_profiles` | `[{profile_id, display_name, summary, accounts: [{name, type, subtype, mask, balance}], txn_count}]` (no secrets) |
| POST | `/plaid/sandbox_connect` | `{household_id, profile_id?, select: true}` → creates the item from that profile's custom-user JSON (default: the existing family profile), writes account options, status `selecting` |


As built (worker): `GET /plaid/sandbox_profiles` serves `data/plaid/profiles/index.json` as is (an array, family demo first, then `pnc_c001`..`pnc_c030`; each entry may carry
extra fields such as `persona`, `first_name`, `monthly_income`, `cash`, `debts`, `window` and per-account `rate_pct` / `monthly_payment` / `keystone_type`), cached with `Cache-Control: max-age=300`,
and answers even without Plaid keys. `POST /plaid/sandbox_connect` takes an optional `profile_id`: missing or `family_demo` = the old default (still falls back to `user_transactions_dynamic`
if Plaid rejects it); a PNC id never falls back to another sandbox user; unknown id = 404 `{error:"unknown_profile", profiles:[...]}`; `profile_id` together with `username` = 400; the response
echoes `profile_id`. A second connect with the same profile on the same household reuses its item (matched by account masks); a different profile creates a second item on that household, so
call it once per household (there is no reducer to remove a `plaid_item`; `delete_sandbox` clears everything). Profile data and license: `data/pnc/README.md`.

## 9. Credit score monitoring (synthetic)

A transparent, synthetic 300–850 score per member, driven mainly by the household's overall financial health, so the
product can show "monitoring" without pulling real credit. Always labelled "Simulated score for this demo".

Formula (pure function in `spacetime/src/credit.ts`, unit-tested, explained in the UI):
- `household_health` = the 0–100 Household Health score the dashboard already shows (blend of the health indicators).
- Member factors from `credit_profile` (0–1 each, higher is better): payment history (late_payments_24m),
  utilization (utilization_pct, card balances / limits), history length (oldest_account_years), new credit (hard_inquiries_12m),
  credit mix (number of distinct debt account types in the household).
- `raw = 0.45*household_health/100 + 0.20*payment + 0.15*utilization + 0.08*history + 0.06*new_credit + 0.06*mix`
- `score = round(300 + 550*raw)`, clamped to 300–850. Band: <580 poor, 580–669 fair, 670–739 good, 740–799 very good, ≥800 exceptional.

| Table | Columns |
|---|---|
| `credit_score` | id pk (`{member_id}`), household_id, member_id, score, band, factors_json (each factor's value, weight, points and a one-line plain explanation), updated_at |
| `credit_score_history` | id pk (`{member_id}:{yyyy-mm-dd}`), household_id, member_id, date, score |

`recompute_household` updates `credit_score` and appends today's history point. A backfill (seed and `create_sandbox`/onboarding)
writes ~6 monthly points by recomputing household health from each past month's transactions. A change of ≥15 points creates an
`alert` (kind `credit`, warn on drops, info on rises) with the main reason. Brian and the coach get a `get_credit_score` tool.

As built (module agent): `credit_score` and `credit_score_history` as above (`credit_score.id` = `member_id`; `band` is the literal text `poor`,
`fair`, `good`, `very good` or `exceptional`; `factors_json` is an array of `{key, label, value 0..1, weight, points, max_points, explanation}` in
the order household_health, payment_history, utilization, history_length, new_credit, credit_mix; `points` add up to `score - 300`). Members
without a `credit_profile` (Plaid / PNC households) are scored from a profile derived from their accounts; children and members of seeded
households with no profile get no row. History: `recompute_household` writes today's point; worker-only reducer `backfill_credit_history(household_id)`
(`""` = all households without monthly history) writes the monthly points, and `create_sandbox`, `finish_onboarding` and the seed script call it
(five monthly points plus today for the seeded data, which starts 9 May). Alert: kind `credit`, id `credit:<household>:<yyyy-mm-dd>`, one per household
per day, `related_ids_json` = the member ids that moved. One tuning departure: the household-finances factor value is `(health/100) * 0.80`
(`HEALTH_CREDIT_SCALE`), plus demanding factor curves; see `spacetime/README.md`, "Credit score monitoring". Worker tool `get_credit_score`
`{member?}` -> `{available, simulated, note, as_of, count, members:[{member_id, member, score, band, change_6m:{points, since, months, from_score}|null,
top_factors:[{factor, effect: helping|holding back, points, max_points, detail}], history:[{date, score}]}]}`; it is a phone tool (voice view trimmed).

## 10. Phone callback with a critical alert (demo)

About 15 s after a phone call with Brian ends (`VOICE_CALLBACK_SECS`, default 15; `VOICE_CALLBACK_ENABLED`, default 1), Brian
calls the same number back from the SignalWire number and says there is a critical alert, then stays on the line for questions.
- Only the number that just called, once per call, only after a successful PIN unlock. The raw number is held in memory
  for the callback only, never stored or logged (logs use the salted hash).
- Before hanging up, Brian says he may ring back if something urgent comes up.
- Outbound call: SignalWire Compatibility API `POST /api/laml/2010-04-01/Accounts/{project}/Calls.json` with `From` = our number,
  `To` = caller, `Url` = `https://<host>/voice/twiml?cb=<signed token>`. `/twiml` sees the token and streams a callback session:
  household already unlocked, opening line "Hi, it's Brian again, sorry to call right back. I've got a critical alert on your account…".
- The alert is generated from the household's real signals when possible (a rule `alert` or anomaly: card testing, a large
  overnight transfer to a new payee, overdraft risk on a date, a credit score drop, a scam-pattern payment), otherwise drawn
  from a set list of templates filled with plausible amounts and merchants. It's written as a critical `alert` row
  (via the worker), so it appears on the dashboard while the caller is listening. Every callback is a traced `phone` run.

As built (voice + worker agent, 2026-11-08):
- Voice (`services/voice/callback.py`, `alerts.py`): `VOICE_CALLBACK_ENABLED` (1), `VOICE_CALLBACK_SECS` (15), `VOICE_CALLBACK_RING_SECS` (20), `VOICE_CALLBACK_AMD` (off), cooldown 60 s per caller and 20 per hour. The `cb` token is
  HMAC-signed with `VOICE_SHARED_SECRET`, single use, 120 s, and carries household + alert + a nonce (never the number). `/twiml?cb=` verifies the SignalWire signature as usual, then streams with a second single-use
  `cb_session` token. Skipped for WebRTC, calls that never unlocked, errored calls, anonymous numbers and callbacks themselves. 7 templates: card charge in another city, new payee + large 3 a.m. transfer, checking below zero
  when two bills collide, credit drop after a hard inquiry, gift-card pattern, double charge, card-testing burst.
- Worker routes (both `x-voice-secret`): `GET /phone/alert_candidates?household_id=` -> `{household_id, family, as_of, candidates[{id, type, source, severity, kind, title, detail, alert_id?, related_ids, facts, priority}], context}`
  and `POST /phone/callback_alert {run_id, alert{kind, title, detail, related_ids, existing_alert_id?, origin}}` -> `{ok, alert_id, written, reused}` (writes a critical `alert` with id `callback:<household>:<call>` through
  `agent_create_alert`; refuses a run that was not started as a callback). `POST /phone/start` takes `callback: true` (the run is titled "Voice callback connected").

## 11. Product scope change
The Advisor Console is removed: the product is entirely end-user facing. Advisor UI, routes and copy are gone; the
`advisor_note` table and reducer stay in the module (removing a table is a breaking change) but nothing uses them.

## 12. Kids and teens (chores, allowance jar; Teen planner is client-only)

Page `/room/[id]/kids`. Kids (age 12 and under) get a jar and chores; 13 and up also get Teen mode (student-loan payoff, 50/30/20 first budget, credit checklist), which are pure calculators and store nothing.

| Table (public) | Key | Columns |
|---|---|---|
| `kid_task` | `id` | `household_id`, `member_id`, `title`, `reward` (USD), `status` (`open` -> `done` -> `approved`), `created_by_name`, `created_at`, `updated_at` |
| `kid_jar` | `member_id` | `household_id`, `balance`, `earned_total`, `goal_title`, `goal_target` (0 = none), `updated_at` |

Client reducers (hackathon scope: anyone in the room may call them, like voting):
`add_kid_task(household_id, member_id, title, reward, author_name)`, `complete_kid_task(task_id)` (open -> done),
`approve_kid_task(task_id)` (done -> approved, pays `reward` into the jar exactly once), `reopen_kid_task(task_id)` (done -> open),
`delete_kid_task(task_id)`, `set_kid_goal(household_id, member_id, title, target)`, `redeem_kid_goal(member_id)` (needs balance >= target).

The web app tolerates a module published before this section: `lib/data/mock/kids.ts` runs the same rules in the browser store until the tables exist.

## 14. Shared cash numbers (one source for every monthly cash figure)

Every monthly cash figure on screen and in the agents comes from the recompute (`finance.ts` `CashFlowResult`). It uses the
same rules as the savings-rate and runway indicators:

- **Income:** deposits into checking and savings, excluding refunds.
- **Spending:** outflows from checking, savings and cards. A card bill payment is skipped when the card's own purchases are
  present. Transfers between the household's own accounts are skipped, and refunds are netted.

| Table | Columns |
|---|---|
| `cash_flow` | household_id pk, as_of, window_days (90 or less), income_monthly, expense_monthly, net_monthly, savings_rate (equals the `savings_rate` indicator), categories_json (`[{category, total}]` spending over the window), updated_at |
| `cash_month` | id pk (`{household_id}:{YYYY-MM}`), household_id, month, income, expenses, net, partial (the current month, or a first month the data covers only in part) |

Readers:

- Dashboard: the Cash flow tile (`net_monthly`, "last 90 days"), the Savings rate ring and the "Where the money went" donut
  (`categories_json`, adding up to `expense_monthly` × window).
- Analytics: Net cash flow, Savings rate, Spending by category, and the monthly charts (`cash_month`, completed months only).
- Brian's brief and Ask, through the health indicators, which carry the same figures.

Without these rows (mock mode, or an older module), the web falls back to its own derivation. `tick_recompute` backfills any
household that has no `cash_flow` row yet, so a module upgrade fills them within a minute or two.
