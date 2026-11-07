# `spacetime/`: the Keystone SpacetimeDB module

The whole backend: every table, the agent job queue, presence, and the deterministic finance math. Written in
TypeScript against **`spacetimedb` 2.14.1** (the version the web app and worker must use) and published as the database
`keystone`. The Node worker does all LLM and Plaid work and talks to this module only through reducers and
subscriptions.

> **Version pin.** `apps/web` and `services/worker` must depend on `"spacetimedb": "2.14.1"` (exact, no caret) and the
> CLI must be 2.14.x (`spacetime version list` shows `2.14.1 (current)`). Generated bindings are only guaranteed to
> work with the same SDK version that the CLI generated them for.

## Layout

```
spacetime/
  package.json, tsconfig.json        what `spacetime init --lang typescript` generates, plus vitest
  vitest.config.ts                   module tests (real in-memory datastore, no server)
  src/
    index.ts                         entry: default export = schema, re-exports every reducer
    schema.ts                        all tables (docs/contracts.md sections 2, 5 and 6)
    util.ts                          validation, id helpers, job enqueue (not part of the module surface)
    config.ts                        worker-secret hash resolution (private module_config row, else the dev hash), publisher
    proposals.ts                     family-voting helpers: details validation, deadline check, check enqueue, expiry sweep
    recompute.ts                     tables <-> finance.ts glue for recompute_household
    finance.ts                       PURE math: indicators, 90-day forecast, rule alerts. No imports.
    sha256.ts                        PURE SHA-256 (the V8 module runtime has no sync crypto)
    reducers/{lifecycle,room,huddle,family,proposal,plaid,onboarding,recompute,worker,admin,seed}.ts
    finance.test.ts                  `node --test`, no SpacetimeDB needed
    module.test.ts                   vitest + SpacetimeDB test harness: every reducer path
```

Only the schema and reducers are exported from `index.ts` (SpacetimeDB treats every export as part of the module).

## Table map

| Table | Public | Written by |
|---|---|---|
| `household` (+ `home_value`, `vehicle_value`), `member`, `account`, `txn`, `credit_profile`, `obligation`, `conversation` | yes | `seed_*`, `create_sandbox`, Plaid reducers |
| `health_indicator`, `forecast_point`, `alert` (rule rows have ids `rule:...`) | yes | `recompute_household`, `tick_recompute`; worker adds alerts |
| `goal`, `presence`, `huddle`, `transcript_line`, `scenario`, `coach_message`, `advisor_note` | yes | family reducers, worker |
| `agent_job`, `agent_run`, `trace_event` | yes | enqueuing reducers, worker |
| `bank_connection` | yes | worker (Plaid) |
| `household_profile`, `bank_account_option` (onboarding, docs/contracts.md section 7) | yes | `start_onboarding`, `save_onboarding_answers`, `select_bank_accounts`, `finish_onboarding`, worker `agent_set_account_options` |
| `proposal`, `vote` (family voting, docs/contracts.md section 6) | yes | `create_proposal`, `cast_vote`, `close_proposal`, worker `agent_update_proposal`, `seed_proposals` / `seed_votes`, `create_sandbox` |
| `account.source`, `txn.source` = `seed` or `plaid` | yes | seed / Plaid reducers |
| `worker`, `plaid_item` (tokens), `module_config` (publisher + worker-secret hash override), `dirty_household`, `recompute_tick` | **no** | `register_worker`, `agent_save_plaid_item`, `admin_set_worker_secret_hash`, seed reducers, `init` |

Client bindings turn snake_case into camelCase (`household_id` -> `householdId`, table `health_indicator` ->
`db.healthIndicator`, reducer `join_room` -> `reducers.joinRoom`).

`worker_plaid_items` is a **view**: registered workers get the private `plaid_item` rows (a worker is an ordinary client
identity, not the database owner, so it could not otherwise read its tokens back after a restart); everyone else gets an
empty result.

## Reducer map

Client-callable (any identity): `join_room`, `create_sandbox`, `delete_sandbox` (owner only, extra), `start_huddle`,
`append_transcript`, `end_huddle`, `request_simulation`, `ask_coach`, `upsert_goal`, `delete_goal`, `ack_alert`,
`post_advisor_note`, `recompute_household`, `request_bank_sync`, family voting (`create_proposal`, `cast_vote`, `close_proposal`) and
onboarding (`start_onboarding`, `save_onboarding_answers`, `select_bank_accounts`, `finish_onboarding`).

Operator-only: `admin_set_worker_secret_hash(sha256_hex)` (publisher identity only; see "Worker secret" below).

Lifecycle: `init` (records the publisher, starts the 60 s tick), `onConnect` (lobby presence), `onDisconnect` (delete presence).
Scheduled (private, fired by SpacetimeDB): `tick_recompute`, every 60 s (recomputes dirty households and closes proposals past their deadline).

Worker-only (rejected with `worker only` unless the sender is in `worker`):
`claim_job`, `start_run`, `finish_run`, `emit_trace`, `agent_upsert_goal`, `agent_create_alert`,
`agent_update_scenario`, `agent_update_proposal`, `agent_set_account_options`, `agent_coach_reply`, `set_huddle_status`, `purge_transcript`,
`seed_households`, `seed_members`, `seed_accounts`, `seed_credit`, `seed_txns`, `seed_obligations`,
`seed_conversations`, `seed_proposals`, `seed_votes`, and the Plaid set `agent_save_plaid_item`, `agent_set_bank_connection`,
`agent_upsert_accounts`, `agent_upsert_txns`, `agent_remove_txns`. `register_worker(secret, label)` is open to everyone
but only succeeds with the right secret.

Behaviours worth knowing:

- `create_sandbox(template, display_name)` copies members, accounts, txns, credit, obligations, conversations (ids become
  `<id>__<suffix>`, foreign keys remapped), not goals, alerts, agent output, `plaid_item` or `bank_connection`. It
  recomputes the health math, moves the caller's presence into the sandbox and queues a `data_quality` job.
- `start_huddle` requires at least one consent name. If the household already has a live huddle it joins it and merges
  the consent names (several phones can press "start").
- `end_huddle` is a no-op unless the huddle is live and enqueues exactly one `huddle` job.
- `claim_job` is atomic: the second claimer gets `job N is already claimed`.
- `emit_trace` takes `household_id` from the run, and swaps a `data_json` over 4 KB for `{"truncated":true,...}`.
- **Family voting.** `create_proposal(household_id, title, amount, details_json, closes_in_days, author_name)` inserts an open proposal
  (`closes_in_days` is a number in (0, 90], fractions allowed; `details_json` a JSON object or `""`) and enqueues one `what_if` job whose
  `subject_id` is the proposal id and whose `input_json` carries `{proposal_id, title, amount, details, created_by, closes_at}`; the worker answers with
  `agent_update_proposal` (verdict `""`/`fine`/`tight`/`risky` + `analysis_json`). `cast_vote(proposal_id, choice yes|no|abstain, voter_name)` keys
  the vote by the caller's identity hex (`vote.id = proposal_id:identity`), so calling again changes it; it is rejected once the proposal is
  closed or past `closes_at`. `close_proposal` is idempotent and open to anyone, like every client reducer. `tick_recompute` flips expired
  open proposals to `closed` (a failing `cast_vote` cannot do it: errors roll back). `seed_proposals` takes `details` (object) or `details_json`,
  ISO `created_at`/`closes_at` (or `closes_in_days`), queues the check for each NEW row without a verdict (re-seeding queues nothing);
  `seed_votes` uses a member id as `voter_key`. `create_sandbox` copies proposals (verdict and analysis kept, `run_id` cleared; open ones get a fresh
  window of the same length) plus the seeded member votes with remapped ids; votes by real identities stay in the template. `delete_sandbox` removes them.
- **Onboarding** (docs/contracts.md section 7). `start_onboarding(household_name, display_name)` makes `hh_onb_<suffix>` (owner = caller, `template_id ""`), a member
  for the caller and a `household_profile` in `connect`, and moves the caller's presence into it. The worker links a bank and calls
  `agent_set_account_options(household_id, item_id, rows_json)` (one `bank_account_option` per Plaid account, selected by default;
  the bank connection and the profile move to `selecting`). `select_bank_accounts(household_id, item_id, account_ids_json)` marks the
  choice, sets the connection to `syncing`, queues one `plaid_sync` (which imports only the selected accounts) and moves the profile to
  `questions`; adding an account that was not selected before resets the item's transaction cursor so its history is pulled. Statuses only
  move forward. `save_onboarding_answers(household_id, answers_json)` takes `{members:[{id?,name,role,age,income_annual}], own_home,
  home_value, vehicle_value, priorities:[emergency_fund|home|college|retirement|debt_payoff|travel|business|caring_for_parents],
  goal_text, risk_comfort 1-5, voting_enabled, voice_consent}` (every key optional), upserts members (by id, else by name),
  `home_value`/`vehicle_value` (0 when renting), goals `goal_<household>_<priority>` with source `onboarding` (a dropped priority is removed;
  the worker fills amount, date and feasibility) and the profile; repeating it is safe. `finish_onboarding(household_id)` refuses while a
  bank is `selecting` ("choose which accounts to import first") or `linking`/`syncing`, then runs `recompute_household`, sets `done`
  and queues one `onboarding_insights` job whose `input_json` carries the answers; calling it again does nothing. `delete_sandbox` also
  deletes an owner's `hh_onb_*` household (test cleanup). Alert `kind` gains `insight`, goal `source` gains `onboarding`, bank connection
  `status` gains `selecting`.
- `request_bank_sync` enqueues a `plaid_sync` job unless one is already queued for that household.
- Seed reducers take a JSON array string in the shape of `data/seed/*.json`, skip ids that exist, and mark the household
  dirty so `tick_recompute` refreshes it within a minute. `anomaly` is stored as `txn.anomaly_truth` (`""` when absent).

## The math (`src/finance.ts`)

`recompute_household(id)` reads the household's rows, calls `analyzeHousehold(input, today)` and replaces
`health_indicator` (8 rows), `forecast_point` (90 rows) and the `rule:` alerts. It is idempotent: same rows, same output;
acknowledgements and `created_at` of findings that persist are kept, findings whose cause disappeared are deleted.
`tick_recompute` runs it for households flagged dirty and for any whose indicators are from a previous day.

**Indicators** (value, unit, status good/watch/risk, one-line explanation): `liquidity_runway` (months; >=6 good, >=3
watch), `debt_to_income` (%; <=36 good, <=43 watch), `credit_utilization` (%; <=30 good, <=50 watch), `savings_rate`
(%, last 3 months; >=15 good, >=5 watch), `net_worth_trend` (USD change over 90 days; net worth = checking + savings + cd +
ira + home + vehicle - debts), `emergency_fund` (% of a 3-month cushion held in savings), `forecast_low_point` (lowest
projected balance), `credit_score` (average; late payments cap it at watch).

**Forecast** follows contracts.md: checking+savings now, plus recurring inflows by cadence (weekly, biweekly,
semi-monthly, monthly, ...), minus obligations on their `due_day`, minus average daily discretionary spend. Recurring
outflow transactions are not subtracted again. One addition: non-recurring deposits (owner draws) are averaged in too;
set `FORECAST_INCLUDE_IRREGULAR_INCOME = false` in `finance.ts` for the strict formula. The forecast starts the day after
the newest trustworthy transaction ("as of"), not the wall clock.

**Rule alerts** use visible columns only. `anomaly_truth` is never copied into the math (`FinTxn` has no such field) and
`module.test.ts` proves that flipping every label changes nothing.

| Rule (alert id) | Kind / severity | Trigger |
|---|---|---|
| `rule:<hh>:duplicate:<txn>` | data_quality / warn | same day, amount and merchant; extra copies are excluded from the math |
| `rule:<hh>:repost:<txn>` | data_quality / info | same account, merchant and amount on consecutive days (not fees, recurring, transfers) |
| `rule:<hh>:garbled:<hash>` | data_quality / info | control chars, U+FFFD, mojibake, stray symbols inside words, mostly symbols |
| `rule:<hh>:impossible:<txn>` | data_quality / critical or warn | amount over $1M, non-numeric, unparseable or future date (future-only is warn); excluded from the math |
| `rule:<hh>:burst:<txn>` | **fraud** / critical | >= 5 charges under $2 at one merchant within an hour (same-day when the data has no clock time) |
| `rule:<hh>:overdraft` | obligation / warn or critical | the forecast goes negative |

Measured on the seeded households (evaluation only, outside the module): duplicates 10 of 11, garbled 10 of 10,
impossible 3 of 3, card testing 7 of 7, no false positives.

## Run it locally

```bash
spacetime start                                    # localhost:3000 (leave running)
cd spacetime && npm install
spacetime publish -s local -p spacetime keystone   # from the repo root; -c always wipes data (see below)
```

Notes on the CLI in 2.14.x, which differs from older docs and from `AGENTS.md`:

- The default server is **Maincloud**. Always pass `-s local` for local work (or run `spacetime server set-default local`).
- The module path flag is `-p` / `--module-path` (not `--project-path`).
- `--delete-data` takes a value: `--delete-data=always` (also `-c always`), `on-conflict` or `never`. Add `-y` to skip prompts.
- A schema change that is not backwards compatible (a new column on `account`, for example) needs `--delete-data=always`
  and a re-seed.

Seed with the worker (`cd services/worker && npm run seed`), or by hand: `spacetime call -s local keystone register_worker
'"keystone-dev-secret"' '"cli"'` then call `seed_households` ... with a JSON-encoded array string. Query with
`spacetime sql -s local keystone "SELECT key, value, status FROM health_indicator WHERE household_id = 'hh_rivera'"`
(aggregates need aliases: `COUNT(*) AS n`). Logs: `spacetime logs -s local keystone`.

## Regenerate client bindings

After any change to a table, reducer or view, republish, then from the repo root:

```bash
spacetime generate --lang typescript -p spacetime -o apps/web/lib/module_bindings -y
spacetime generate --lang typescript -p spacetime -o services/worker/src/module_bindings -y
```

Both folders are generated, never edited, and committed. Use `--import-extension js` only if a consumer runs with
`moduleResolution: nodenext` (the web app and worker both use bundler resolution, so the default is right).

## Deploy to Maincloud

The team has a HACKUTD2026 credit code for Maincloud; apply it to the account you publish from (check the hackathon instructions for where).

1. **Pick a long random worker secret** and give the worker the same value as `WORKER_SECRET` (env, never git). No source edit is needed:
   after publishing (step 3), set its hash with `spacetime call -s maincloud keystone admin_set_worker_secret_hash '"<sha256>"'`
   (`printf %s 'your-secret' | sha256sum`), from the same identity that published. Until then the module accepts the public
   dev secret `keystone-dev-secret`.
2. `spacetime login` (opens the browser)
3. `spacetime publish --server maincloud keystone -p spacetime` (add `-c always` only for a clean first deploy)
4. Point the web app and worker at `wss://maincloud.spacetimedb.com` with database name `keystone` (the name must be free
   on Maincloud; otherwise publish under another name and change it in both clients).
5. Seed once: `cd services/worker && npm run seed` against Maincloud.

## Worker secret

`register_worker(secret, label)` compares `sha256(secret)` with (1) `module_config.worker_secret_hash` when it is non-empty, else (2) the
SHA-256 of the public dev secret `keystone-dev-secret` (`DEV_WORKER_SECRET_SHA256` in `src/config.ts`; local development and `npm test` use it).
`module_config` is a private single-row table: `init` stores the **publisher** identity in it (verified against a real 2.14.1
server: `ctx.sender` inside `init` is the identity that ran `spacetime publish`), and `admin_set_worker_secret_hash(sha256_hex)`,
callable only by that publisher, sets or (with `""`) clears the override. `infra/deploy.sh --publish` calls it after publishing,
inside the spacetime container (infra/DEPLOY.md, step 3a). `init` does not re-run on a plain republish, so a database that was
published before this existed has no recorded publisher; for that one case the reducer accepts an identity that is already a
registered worker, but only while no override exists, and then records that identity as the publisher. A `-c always` publish
wipes the override: set it again. Workers that registered before an override was set stay registered.

The secret could also move into a module environment variable (`schema(..., { env })`, set at publish time); not done here.

## Tests

```bash
npm run typecheck        # tsc --noEmit
npm run test:pure        # node --test src/finance.test.ts : math, rules, SHA-256 vs node:crypto (Node >= 22.18 runs .ts directly)
npm test                 # vitest: every reducer against the real in-memory datastore (needs spacetimedb >= 2.12)
```

## Procedures

SpacetimeDB 2.14.1 supports **procedures** (functions that may call `ctx.http.fetch` and open transactions with
`ctx.withTx`). The docs mark them unstable for C#, Rust and C++ and do not label the TypeScript API beta, but it is
newer than reducers and behaves differently (no automatic transaction). **This module uses none**: reducers stay
deterministic, and the Node worker does all LLM, ASR and Plaid calls.

## Assumptions and limits

- Presence is per identity: two tabs share one row and closing either removes it. There is no heartbeat pruning.
- Any identity may call any client reducer on any household (hackathon scope; row-level security is P1).
- Obligations are assumed monthly on `due_day` (clamped to short months), including tuition and tax rows.
- Debt balances are read as positive amounts owed; a positive transaction on a debt account is a payment received.
- Transfers are recognised by category (`transfer`, `savings`) or a merchant named "Transfer"; a deposit whose category
  is income is never a transfer, even if its description says "ONLINE TRANSFER FROM ...".
- Card payments are not counted as spending when card purchases are present (the purchases already are).
