# Brianotron · HackUTD 2026

**A family's financial room.** One live, shared space where the whole family and a team of Nemotron agents see the full
financial picture together, plan out loud, and can just call Brian, an AI that checks every idea against the real numbers.

- **Live:** https://brianotron.us (tap "Use the demo account" for your own private copy of the demo family)
- **Call Brian:** +1 (945) 403-0355, with a 5-digit family code. He says he's an AI, and calls you back with critical alerts.
- **Demo video:** https://youtu.be/aHd01BcEPJc
- **Devpost:** https://devpost.com/software/keystone-o10hqc
- **Tracks:** PNC (360° Financial Health Navigator) · NVIDIA (Nemotron beyond a chatbot) · SpacetimeDB

All data is synthetic (5 families, 2.9k transactions with labelled anomalies) or Plaid Sandbox. No real customer information
anywhere. `keystone` is the old codename and stays in the database and container names.

## What it does

| | |
|---|---|
| **Link a bank in one tap** | Plaid Sandbox brings in accounts and months of transactions; bills are detected from recurring payments; the dashboard scores the family's health right away |
| **360° dashboard** | Six product tiles (checking, savings, CDs & IRAs, loans, cards, mortgage), net worth, cash flow, eight health indicators with "show the math", a 90-day forecast with the low point, and a "your next move" card with dollar-sized actions |
| **Make it yours** | On desktop, drag any card to reorder it, or into the card bank to hide it; the layout is saved per viewer |
| **Live on every phone** | The whole family joins one room with presence; votes, goals and agent results land on every screen at once |
| **Table Mode** | Opt-in voice, sample or typed conversation; Nemotron agents pull out the goals and check each against the real balances; the transcript is then deleted |
| **What-If Studio & family votes** | Plain-language scenarios simulated month by month, with a fine / tight / risky / not advised verdict |
| **Credit, Analytics, Kids & Teens** | A simulated 300–850 score per member with factors and trend, spending trends, and chores, jars and a teen budget planner |
| **Scam check & data quality** | In-database rules catch duplicates, garbled merchants, impossible values and card testing; agents link the Nguyens' "grandson in jail" call to $2,000 of gift cards |
| **Ask Brianotron** | Answers from tool calls on the family's data; every dollar figure is checked against the tool results |
| **Brian, the voice** | Talk in the app or call the number. He answers in plain words, makes app changes only after a spoken yes, and calls back about 15 s after you hang up when there's a critical alert. He never asks for codes, PINs or money |
| **Agent Trail** | Every plan, tool call, model, provider and latency, streaming live |

## Architecture

```
phones (Next.js) ──wss──► SpacetimeDB "keystone" ◄── agent worker (Node) ──► NVIDIA API: Nemotron 3 Ultra, 3.5 Lightning
                          tables · reducers · job queue    claims agent_job rows,     Plaid Sandbox · FRED · College Scorecard
                          presence · in-DB health,         writes trace_event rows
                          forecast and cash-flow math
phone line (SignalWire) ─┐
Talk button (WebRTC) ────┴► voice service (Python, Pipecat) ──► Nemotron ASR · Nemotron 3.5 Lightning on an NVIDIA L40S (Brev,
                                                                vLLM, NVFP4) · ElevenLabs voice · the worker's household tools
```

- **SpacetimeDB is the whole backend.** State, the agent job queue, presence and the finance math live in one TypeScript module.
  The browser calls reducers and subscribes to tables; there is no other database and no REST API for data.
- **Agents are a queue, not a chat box.** Reducers enqueue jobs (Table Mode ended, a vote opened, a bank synced, a what-if
  asked); the worker claims each one and runs plan → tools → observe → decide, writing every step as a `trace_event` row.
- **Guardrails in code:** a grounding check on every figure, an advice reviewer, confirm-first voice actions, labelled fallbacks.
- **Production:** one EC2 t3.medium with Docker Compose (Caddy with Let's Encrypt, web, worker, voice, self-hosted SpacetimeDB
  2.14.1). Every merge to `main` deploys itself within a minute, with health checks and automatic rollback ([infra/DEPLOY.md](infra/DEPLOY.md)).
- **Tests:** 1,000+ across the module (vitest against a real in-memory datastore), the worker and the voice service.

## Tech stack

| Layer | Stack |
|---|---|
| Frontend | Next.js 16 (App Router), React, TypeScript, Tailwind CSS |
| Backend & data | SpacetimeDB 2.14.1, self-hosted TypeScript module: tables, reducers, scheduled recompute, subscriptions |
| AI agents | NVIDIA Nemotron 3 Ultra (planning, tool calls) and Nemotron 3.5 Lightning (fast steps) via the NVIDIA API; a Node worker with a hand-rolled tool loop and 26 tools; Qwen on tenvor.io as a labelled fallback |
| Voice | Python + Pipecat; Nemotron streaming ASR; Nemotron 3.5 Lightning self-hosted on an NVIDIA L40S via Brev (vLLM, NVFP4); ElevenLabs TTS; SignalWire phone line; WebRTC; NVIDIA Parakeet for Table Mode recordings |
| Integrations | Plaid Sandbox, FRED, College Scorecard |
| Infra | AWS EC2, Docker Compose, Caddy, Let's Encrypt, pull-based auto-deploy with rollback |
| Quality & tooling | Vitest, pytest, ESLint, Claude Code, Codex, Remotion (demo video) |

## Start here

| Doc | What's in it |
|---|---|
| [AGENTS.md](AGENTS.md) | Rules, architecture, how to run. Every coding agent and human reads this first |
| [docs/contracts.md](docs/contracts.md) | Tables, reducers, seed data, trace events, Plaid, phone (binding) |
| [docs/tracks.md](docs/tracks.md) | What each sponsor asked for and how we answer it |
| [docs/demo-script.md](docs/demo-script.md) | The 3-minute judging demo |
| [docs/nvidia-stack.md](docs/nvidia-stack.md) | Nemotron model ids, ASR, rate limits |
| [docs/voice-selfhost.md](docs/voice-selfhost.md) | The voice pipeline design |
| [docs/stress-test-2026-11-08.md](docs/stress-test-2026-11-08.md), [docs/production-readiness.md](docs/production-readiness.md) | What a stress test found, and what has to change before real families |
| [infra/DEPLOY.md](infra/DEPLOY.md) | AWS deploy, publish, seed, auto-deploy |
| [data/README.md](data/README.md) | The five synthetic families and every planted anomaly |
| [spacetime/README.md](spacetime/README.md), [services/worker/README.md](services/worker/README.md) | Module and worker internals |

Tasks, ideas, questions and decisions: [GitHub issues](https://github.com/Blean69/HackUTD-2026-v2/issues) on the team [Project board](https://github.com/users/Blean69/projects/4).
Concept map: https://claude.ai/artifact/15RkwA4UTwAaN8g3spMcnk

## Run it locally

Copy `.env.example` to `.env`, then follow [AGENTS.md § Running locally](AGENTS.md#running-locally).
To see the UI without any backend: `cd apps/web && npm install && NEXT_PUBLIC_USE_MOCKS=1 npm run dev`, then open http://localhost:3001.
