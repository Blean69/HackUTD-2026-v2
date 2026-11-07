# Keystone (codename) · HackUTD 2026

**A family's financial room.** One live, shared space where the whole family and a team of Nemotron agents see the full
financial picture together and plan out loud.

Tracks: **PNC** (360° Financial Health Navigator) · **NVIDIA** (Nemotron beyond a chatbot) · **Spacetime** (main track)

## What works today

| Piece | Status |
|---|---|
| **Family room** (`/room/:id`) | Accounts across all 8 PNC account types, 8 health indicators, 90-day cash forecast, alerts, goals, what-if, coach. Live on every phone in the room, with presence |
| **Huddle** | Opt-in voice, sample or typed conversation → shared live transcript → Nemotron extracts goals and checks each against real balances → goal cards on every phone → transcript purged |
| **Scam Shield + data quality** | In-DB rules catch duplicates, garbled merchants, impossible values and card testing (no false positives on the seed). Agents link the Nguyens' "grandson in jail" call to $2,000 of gift cards |
| **Agent glass box** (`/agents`) | Every plan, tool call, thought, model and latency, streaming live from all sessions |
| **Advisor console** (`/advisor`) | Households by urgency; advisor notes appear live in the family's room |
| **SpacetimeDB module** | The whole backend: state, job queue, presence, finance math as reducers, scheduled recompute |
| **Agent worker** | Hand-rolled tool loop. Nemotron 3 Ultra plans, Nemotron 3.5 Lightning extracts, Qwen on tenvor.io is the fallback. FRED and College Scorecard tools. All five workflows pass on real Nemotron in under 45 s |
| **Plaid Sandbox** | Connect a bank (Plaid Link or one-tap sandbox connect) → `plaid_sync` workflow → tables. Verified live: 7 accounts, 331 transactions from First Platypus Bank |
| **Deploy** | **Live at https://52-72-164-85.sslip.io** · EC2 t3.medium: Caddy (HTTPS) + web + worker + self-hosted SpacetimeDB via Docker Compose ([infra/DEPLOY.md](infra/DEPLOY.md)) |

All data is synthetic (5 families, 2.9k transactions with labelled anomalies). No real customer information anywhere.

## Architecture

```
phones (Next.js) ─wss─► Caddy ─► SpacetimeDB "keystone"   ◄─ agent worker (Node) ─► NVIDIA API (Nemotron) · tenvor.io (Qwen)
                          │       tables · reducers ·          claims agent_job rows,     Plaid Sandbox · FRED · College Scorecard
                          │       scheduled recompute          writes trace_event rows    NVIDIA ASR
                          ├─► web (Next.js)
                          └─► /worker/* → worker HTTP (ASR upload, Plaid Link)
```

## Start here

| Doc | What's in it |
|---|---|
| [AGENTS.md](AGENTS.md) | Rules, architecture, how to run. Codex and Claude both read this |
| [docs/contracts.md](docs/contracts.md) | Tables, reducers, seed data, trace events, Plaid (binding) |
| [docs/tracks.md](docs/tracks.md) | What each sponsor asked for and how we answer it |
| [docs/demo-script.md](docs/demo-script.md) | 3-minute demo per judge panel |
| [docs/scope.md](docs/scope.md) | Timeline, P0/P1/P2, owners |
| [docs/nvidia-stack.md](docs/nvidia-stack.md) | Nemotron model ids, ASR/TTS, rate limits |
| [infra/DEPLOY.md](infra/DEPLOY.md) | AWS deploy, publish, seed, teardown |
| [data/README.md](data/README.md) | The five families and every planted anomaly (demo cheat sheet) |
| [spacetime/README.md](spacetime/README.md), [services/worker/README.md](services/worker/README.md) | Module and worker internals |

Tasks, ideas, questions and decisions: [GitHub issues](https://github.com/Blean69/HackUTD-2026/issues) on the team [Project board](https://github.com/users/Blean69/projects/4).
Concept map: https://claude.ai/artifact/15RkwA4UTwAaN8g3spMcnk

## Run it locally

Copy `.env.example` to `.env`, then follow [AGENTS.md § Running locally](AGENTS.md#running-locally).
To see the UI without any backend: `cd apps/web && npm install && NEXT_PUBLIC_USE_MOCKS=1 npm run dev`, then open http://localhost:3001.
