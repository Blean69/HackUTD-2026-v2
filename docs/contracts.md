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

### Trace event semantics (the NVIDIA story)
`workflow` ∈ huddle | what_if | coach | scam_check | data_quality. `agent` e.g. planner, goal_extractor, reconciler,
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

Lifecycle: `client_connected` (no-op or lobby presence), `client_disconnected` (delete presence).
Scheduled: `tick_recompute` every 60 s recomputes households with recent changes.

Worker-only (reject unless `ctx.sender` is in `worker`):
| Reducer | Effect |
|---|---|
| `register_worker(secret, label)` | adds caller to `worker` if secret matches the module constant `WORKER_SECRET_SHA256` (set before publish) |
| `claim_job(job_id)` | queued → claimed (atomic; second claimer fails) |
| `start_run(run_id, job_id)` / `finish_run(run_id, status, providers_json, result_json)` | run lifecycle; also marks job done/error |
| `emit_trace(run_id, seq, workflow, agent, type, title, data_json, model, provider, latency_ms, tokens_in, tokens_out)` | inserts `trace_event` |
| `agent_upsert_goal`, `agent_create_alert`, `agent_update_scenario`, `agent_coach_reply`, `set_huddle_status` | write results |
| `purge_transcript(huddle_id)` | deletes that huddle's transcript lines (privacy: we keep goals + short evidence quotes only) |
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

## 8. Phone line (planned, later): call the family's agent

Call a phone number and get a warm, human-sounding voice that explains the household's finances in plain words, and that
can run a what-if by voice and narrate the result. Design lives in `docs/voice-agent.md` (research first, build after the
core demo is solid). Constraints already decided: Nemotron answers through the same tools as the coach; every call is a traced
`agent_run` (workflow `phone`), so the Agent Trail shows it; callers are matched to a member (phone number on file plus a PIN);
synthetic data only; a spoken disclosure at the start of every call that it's an AI assistant.
