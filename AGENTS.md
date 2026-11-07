# AGENTS.md — shared context for every coding agent (Codex, Claude, humans)

Read this first. It is the source of truth for what we are building and the rules we build by.
`docs/contracts.md` is binding for any code that crosses the web / SpacetimeDB / worker boundary.

## The product (codename: Keystone — rename freely)

**A family's financial room: one live, shared space where the whole family and a team of Nemotron agents see the
full financial picture together and plan out loud.**

| Surface | Route | Who | Track it wins |
|---|---|---|---|
| Family room | `/room/[householdId]` (`/me` → demo room) | Family members on their own phones, together | **PNC**: 360° Financial Health Navigator |
| Advisor console | `/advisor` | A PNC advisor (bank-internal view) | PNC (bonus), Spacetime (multiplayer) |
| Agent glass box | `/agents` + a trace drawer on every page | Judges, engineers | **NVIDIA**: Nemotron beyond a chatbot |
| The whole app | — | — | **Spacetime**: every byte of state, the job queue, presence, the in-DB health/forecast math and live sync run on SpacetimeDB |

Hero story: the Riveras (bakery owners in Oak Cliff, Dallas) open a Huddle at the dinner table. Every phone in the room
shows the live transcript. When they end it, Nemotron agents pull out their goals (second bakery location, college fund,
Grandma's care), check each one against the real accounts, and post goal cards with feasibility to every screen.
Meanwhile the scam guard catches the Nguyens' "grandson in jail" call and links it to a $2,000 gift-card purchase.

## Architecture

```
Next.js (phones)  ⇄  SpacetimeDB module "keystone" (tables, reducers, scheduled recompute, presence)  ⇄  Node agent worker
                                                                                                      Nemotron (NVIDIA API; Qwen on tenvor.io as fallback)
                                                                                                      tools: ledger, forecast, simulator, anomaly + scam
                                                                                                      detectors, external APIs; NVIDIA ASR at POST /asr
```
- The browser never calls the worker for data. It calls reducers and subscribes to tables.
- Work is queued as `agent_job` rows by reducers. The worker subscribes, claims, runs a multi-step Nemotron workflow,
  and writes `trace_event`s plus results back through worker-only reducers. Every phone sees each step live.
- Deterministic math (health indicators, 90-day forecast, rule-based data-quality alerts) runs inside SpacetimeDB reducers.
- Production: one EC2 t3.medium (52.72.164.85). Caddy terminates HTTPS and routes the SpacetimeDB API (wss), `/worker/*` and the web app.
  SpacetimeDB is self-hosted in a container there (not Maincloud). Publishing is only allowed from the team IP.

## Hard rules

1. **Spacetime powers the primary functionality.** No side database, no REST data API, no websockets of our own.
   External sources (Plaid Sandbox, FRED, College Scorecard) are read by the worker and written into tables.
   If state matters, it is a SpacetimeDB table.
2. **Nemotron is the primary model for every agent.** Qwen on tenvor.io is fallback only. Every trace event records the
   provider and model that answered. Never silently swap models in a judged demo.
3. **Every agent run emits trace events.** If a step is not in the trace, judges cannot see it. Agents plan → call tools →
   observe → decide. A single prompt→answer call is not an agent.
4. **Synthetic data only.** No real PII. Generators are seeded and deterministic (`data/`).
5. **The demo must survive an LLM outage.** `DEMO_MODE=cache_first` replays a previous identical run with realistic timing
   (provider shows `cache`). New input always runs live.
6. **Voice is opt-in and session-based.** Visible recording indicator, explicit start/stop, names of who consented. The
   transcript is purged after analysis (`purge_transcript`). We keep goals and short evidence quotes. A "passive mode" is
   always an opt-in Huddle session, never always-on listening. Bank judges will ask about this.
7. **Mobile-first.** Judges arrive by QR code on their phones, often several at once in the same room.
8. **The repo must be public on GitHub before judging** (Spacetime rule). No secrets in git. Ever.
9. **Main is always deployable.** If you break it, fix it right away.

## Repo layout

```
spacetime/        SpacetimeDB module (TypeScript): tables, reducers, scheduled recompute
apps/web/         Next.js (App Router, TS, Tailwind). Generated bindings in apps/web/lib/module_bindings/ (never edit)
services/worker/  Node + TypeScript agent worker. Generated bindings in services/worker/src/module_bindings/ (never edit)
data/             Synthetic data generator (Python) + generated seed JSON in data/seed/ (committed)
infra/            Docker Compose (Caddy + web + worker + self-hosted SpacetimeDB) for one EC2 box; deploy.sh; DEPLOY.md
docs/             tracks, contracts, demo script, scope, NVIDIA stack notes
```

## Running locally

```bash
spacetime start                                                     # local SpacetimeDB on :3000 (CLI 2.14.1)
spacetime publish -s local -p spacetime keystone -y                 # (re)publish; default server is Maincloud, so pass -s local
spacetime generate --lang typescript -p spacetime --out-dir apps/web/lib/module_bindings -y
spacetime generate --lang typescript -p spacetime --out-dir services/worker/src/module_bindings -y
cd services/worker && npm install && npm run seed && npm run dev    # seeds, then runs agents + :8787 HTTP. Uses real keys from .env;
                                                                    # prefix LLM_PROVIDER_ORDER=local to save the shared NVIDIA rate limit
cd apps/web && npm install && npm run dev                           # http://localhost:3001
cd data && python3 generate.py --seed 2026                          # only if you change the generator
```
After any change to a table or reducer: republish (add `--delete-data=always` if the schema change is breaking, then re-seed) and
regenerate both binding folders. Commit the regenerated bindings.

## Deploying

See `infra/DEPLOY.md`. In short: `.env.prod` (gitignored, never committed) holds production values; `infra/deploy.sh`
rsyncs the tree to the box and runs Docker Compose; the module is published from inside the spacetime container;
`infra/deploy.sh --seed` seeds. The production worker secret is set in the database with `infra/deploy.sh --publish`
(or `--set-worker-hash`), which calls the publisher-only `admin_set_worker_secret_hash` reducer; no source edit. Never commit
`.env`, `.env.prod`, or a production hash. Don't run `docker compose config` without `-q`; it prints secrets.

## Configuration

Secrets live in env only (`.env`, never committed). See `.env.example`. LLM providers are OpenAI-compatible endpoints
tried in `LLM_PROVIDER_ORDER` (default `nvidia,tenvor_qwen`), with a keyless `local` fallback so the
whole app runs without keys.

## Conventions

- TypeScript everywhere except `data/`. Strict mode.
- Agent tools are plain functions with a JSON schema in one registry (`services/worker/src/tools/`). Each returns small JSON.
- Money: numbers in USD; format with `Intl.NumberFormat` in the UI; tabular numerals.
- Prefer boring and visible over clever and hidden. A judge has 3 minutes.
- Work is tracked as GitHub issues on the team Project (labels: `kind:*`, `track:*`, `P0/P1/P2`, `effort:*`). When you think of
  an idea instead of building it, open an issue labelled `kind:idea`. Reference issues in commits (`Fixes #12`).
