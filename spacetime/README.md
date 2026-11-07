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
    schema.ts                        all tables (docs/contracts.md section 2 + 5)
    util.ts                          validation, id helpers, job enqueue (not part of the module surface)
    recompute.ts                     tables <-> finance.ts glue for recompute_household
    finance.ts                       PURE math: indicators, 90-day forecast, rule alerts. No imports.
    sha256.ts                        PURE SHA-256 (the V8 module runtime has no sync crypto)
    reducers/{lifecycle,room,huddle,family,plaid,recompute,worker,seed}.ts
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
| `account.source`, `txn.source` = `seed` or `plaid` | yes | seed / Plaid reducers |
| `worker`, `plaid_item` (tokens), `dirty_household`, `recompute_tick` | **no** | `register_worker`, `agent_save_plaid_item`, seed reducers, `init` |

Client bindings turn snake_case into camelCase (`household_id` -> `householdId`, table `health_indicator` ->
`db.healthIndicator`, reducer `join_room` -> `reducers.joinRoom`).

`worker_plaid_items` is a **view**: registered workers get the private `plaid_item` rows (a worker is an ordinary client
identity, not the database owner, so it could not otherwise read its tokens back after a restart); everyone else gets an
empty result.

## Reducer map

Client-callable (any identity): `join_room`, `create_sandbox`, `delete_sandbox` (owner only, extra), `start_huddle`,
`append_transcript`, `end_huddle`, `request_simulation`, `ask_coach`, `upsert_goal`, `delete_goal`, `ack_alert`,
`post_advisor_note`, `recompute_household`, `request_bank_sync`.

Lifecycle: `init` (starts the 60 s tick), `onConnect` (lobby presence), `onDisconnect` (delete presence).
Scheduled (private, fired by SpacetimeDB): `tick_recompute`, every 60 s.

Worker-only (rejected with `worker only` unless the sender is in `worker`):
`claim_job`, `start_run`, `finish_run`, `emit_trace`, `agent_upsert_goal`, `agent_create_alert`,
`agent_update_scenario`, `agent_coach_reply`, `set_huddle_status`, `purge_transcript`,
`seed_households`, `seed_members`, `seed_accounts`, `seed_credit`, `seed_txns`, `seed_obligations`,
`seed_conversations`, and the Plaid set `agent_save_plaid_item`, `agent_set_bank_connection`,
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

1. **Change the worker secret first.** `WORKER_SECRET_SHA256` in `src/reducers/worker.ts` is the SHA-256 of the dev secret
   `keystone-dev-secret`, and the repo is public. Pick a long random secret, put its hash in the file
   (`printf %s 'your-secret' | sha256sum`), give the worker the same value as its secret (env, never git), then publish.
2. `spacetime login` (opens the browser)
3. `spacetime publish --server maincloud keystone -p spacetime` (add `-c always` only for a clean first deploy)
4. Point the web app and worker at `wss://maincloud.spacetimedb.com` with database name `keystone` (the name must be free
   on Maincloud; otherwise publish under another name and change it in both clients).
5. Seed once: `cd services/worker && npm run seed` against Maincloud.

The secret could also move out of source into a module environment variable (`schema(..., { env })`, set at publish
time); that is not done here because the contract asks for a constant.

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
