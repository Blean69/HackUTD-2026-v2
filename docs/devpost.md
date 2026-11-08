# Devpost submission (paste-ready)

Four Devpost fields, in the order the form asks for them. Final submit: Sunday 12:00 PM.

- Repo (public): https://github.com/Blean69/HackUTD-2026-v2
- Live: https://brianotron.us · Brian's line: +1 (844) 468-1795
- Video: upload `brianotron-demo-v2.mp4` (1:54, under the 2-minute cap) to YouTube and paste the link.

---

## Elevator pitch

A live money room for the whole family. Plan together on every phone, or just call Brian, the AI who checks every idea against your real numbers and calls you back when something needs you.

---

## About the project

## Inspiration

Americans get fewer than half of basic money questions right: 47% in the 2026 TIAA Institute–GFLEC Personal Finance Index, the lowest in its ten years. Gen Z, our generation, scored 38%. The problem usually isn't a lack of advice. A family's money is scattered across checking, savings, a CD, an IRA, a mortgage, a car loan and a couple of cards at half a dozen institutions, and nobody can see how the whole thing is doing or what to do next.

That is exactly PNC's challenge: a 360° Financial Health Navigator that helps people see the whole picture, understand it, and act with confidence.

We added the part finance apps skip: a household is several people, and big money decisions happen out loud. At the dinner table, in the car, on the phone with a parent. Apps assume one person on one screen, so the family's real conversation never touches the numbers. We wanted one room where the whole family, and a team of AI agents, look at the same live numbers and plan together. And for the people in the family who will never open an app, a number they can just call.

The name is in memory of Brian. B.R.I.A.N. stands for "Be Rich In A Night", which is exactly the plan Brian will talk you out of.

## What it does

**Brianotron is one live, shared financial room for a family.**

- **Link a bank in one tap.** Plaid Sandbox brings in the accounts and months of transactions. Bills are detected from the family's own recurring payments, and the dashboard scores their financial health right away.
- **The 360° dashboard.** Net worth, assets and debts, monthly cash flow, eight health indicators, and a 90-day cash forecast with the low point called out. Plus Analytics, a simulated credit score per family member, and Goals. One number for each thing, computed once in the database, so every screen, agent and voice says the same figure.
- **Live on every phone.** Family members join the room from their own phones. A vote, a goal or an agent result shows up everywhere at once.
- **Table Mode.** The family talks it out; every phone shows the transcript. When they finish, Nemotron agents pull out the goals, check each one against the real balances, and post goal cards marked On track, Stretch or Not advised. Then the transcript is deleted. Gambling is never a plan.
- **What-If Studio and family votes.** "Open a second bakery location" becomes a structured scenario, simulated month by month, with a verdict (fine, tight, risky or not advised) before anyone signs anything.
- **Kids & Teens.** Chores, allowance jars and a teen budget and loan planner.
- **Ask Brianotron.** Answers come from tool calls on the family's own data, and every dollar figure is checked against those results before you see it.
- **Brian, the voice.** Tap Talk in the app, or call +1 (844) 468-1795 and enter the family's 5-digit code. Brian says up front that he's an AI. He answers in plain words, finds bills you could cut, and can do most of what you'd do by hand: add a chore, put money in a kid's jar, create a goal, save a what-if. He confirms every change out loud first, and the code enforces that confirmation. About 15 seconds after you hang up, if there's a critical alert, **Brian calls you back.** He never asks for codes, PINs or money.
- **The Agent Trail.** Every plan, tool call, result, model and latency for every run, live. Nothing the AI does is hidden.

All data is synthetic or Plaid Sandbox. There is no real customer information anywhere.

## How it answers PNC's challenge

PNC suggested a conversational coach, three or more health indicators, forecasting of balances and obligations, a what-if simulator, or something nobody has thought of yet. We built all four, then the something new.

- **The whole picture.** Plaid Sandbox links a bank in one tap and maps everything into eight account types: checking, savings, CD, IRA, auto loan, personal loan, credit card and mortgage. Recurring payments are detected from the family's own transactions and become bills with amounts and due days, so nobody types their obligations in by hand.
- **Health indicators: eight, not three.** Liquidity runway (months of cushion), emergency fund, debt-to-income, credit utilization, savings rate, net-worth trend, the 90-day low point and a simulated credit score. They roll up into a 0–100 household health score. Each comes with one plain sentence ("$40,109 in checking and savings covers 3.3 months of spending"). They're computed *inside the database* by scheduled reducers and recomputed whenever data changes, so the score is never stale.
- **Forecasting balances and obligations.** A 90-day cash forecast that places every bill and loan payment on its date, with a best-to-worst band and the low point called out ("cash dips to about $40k on November 24 when the bills stack up"). Cash flow uses the same trailing-90-day numbers everywhere.
- **What-if simulator.** Type a decision in plain words. A Nemotron agent turns it into a structured scenario (loan amount and rate, start month, cost cuts) and simulates it month by month for 12 to 24 months against the real balances. It returns a verdict (fine, tight, risky or not advised), the low point and a safer suggestion.
- **Conversational coach, in two forms.** *Ask Brianotron* in the app, and *Brian* on the phone. Both answer by calling tools on the family's own data (26 tools: ledger, bills, forecast, simulator, savings finder, credit, scam detectors, live FRED interest rates and College Scorecard tuition), not from a script.
- **Something new.** Table Mode turns a dinner-table conversation into checked goals; family votes put an affordability check on every big purchase; Kids & Teens gives children chores, jars and a budget; a scam check links a suspicious call to the gift cards bought right after it.

### What makes us different

- **Built for a household, not one person on one screen.** Everyone joins the same live room from their own phone. A vote, a goal or a chore lands on every screen at once, and Table Mode works at the dinner table, where money decisions actually happen.
- **It meets people where they are.** Not everyone in a family will open a finance app. Anyone can call Brian, hear the picture in plain words ("a little over three months of cushion", not "liquidity runway"), and get **called back** when something critical needs them.
- **AI you can check.** Every agent step is visible in the Agent Trail. Every dollar figure in an answer is checked in code against the tool results before anyone sees it. Brian confirms every change out loud, never moves money, and never asks for codes or PINs.
- **One source of truth.** Cash flow, health, forecast and bills are computed once in SpacetimeDB, so the dashboard, the agents and Brian always say the same number.
- **It teaches by doing.** Every number explains itself in one sentence, and every what-if shows what would happen before the family commits. That's financial literacy built into the everyday picture, not a separate course.

## How we built it

**SpacetimeDB is the whole backend.** One TypeScript module (SpacetimeDB 2.14.1, self-hosted) holds every table: households, accounts, transactions, goals, votes, presence, the agent job queue and the trace log. Reducers are the API. The health indicators, the 90-day forecast, cash flow, bill detection and the data-quality rules run *inside* the database on a schedule. Phones subscribe to tables and get every change pushed to them. There is no separate database and no REST API for data.

**Agents are a job queue, not a chat box.** Reducers enqueue `agent_job` rows when a Table Mode session ends, a vote opens, a what-if is asked or a bank finishes syncing. A Node worker, which is just another SpacetimeDB client, claims each job atomically. It runs a hand-rolled tool loop: plan, call tools (26 of them: ledger, forecast, simulator, feasibility, savings finder, scam detectors, FRED rates, College Scorecard and more), observe, decide. Then it writes back through worker-only reducers. Every step is a `trace_event` row, so the Agent Trail streams live for free.

**Nemotron, each model where it fits.**
- **Nemotron 3 Ultra** (550B) plans and calls tools for the agent team.
- **Nemotron 3.5 Lightning** (30B-A3B) handles the fast steps and structured extraction.
- For Brian's voice, Lightning runs **self-hosted on an NVIDIA L40S via Brev** (vLLM, NVFP4), which removes the shared rate limit and keeps responses quick.
- **Nemotron streaming ASR** (NVIDIA cloud) turns speech into text.

Every trace event records which model and provider answered. A fallback is labelled, never silent.

**Guardrails in code, not just prompts.**
- A grounding check rejects any answer containing a dollar figure or percentage that isn't in the tool results, and rewrites it from the data. The trace shows "Check: 24 of 24 figures match".
- An advice reviewer blocks moving money, gambling and plans the family can't afford.
- Voice actions are confirm-first.
- Credit scores are always labelled simulated.

**Voice.** Python + Pipecat: Silero VAD, Smart Turn and barge-in. SignalWire for the phone line, WebRTC for the in-app Talk button, ElevenLabs for Brian's voice. The voice service calls the same worker tools as the agents.

**Deploy.** One EC2 t3.medium runs Docker Compose with Caddy (Let's Encrypt), the Next.js app, the worker, the voice service and self-hosted SpacetimeDB at brianotron.us. Every merge to main deploys itself within a minute: the database module publishes first, then the services, with health checks and automatic rollback. Over 1,000 automated tests cover the module, worker and voice service.

We built it as a team working alongside Claude Code and Codex, against one binding contracts doc so people and agents could work in parallel without breaking each other.

## Challenges we ran into

- **The model made up numbers.** Early on, Nemotron sometimes invented figures, and three screens showed three different "monthly surplus" numbers. We moved every cash number into one table computed in the database. We also made the grounding check mandatory, so an unbacked figure gets rewritten before anyone sees it.
- **Voice latency.** A shared API endpoint is too slow for a phone call. We self-hosted Lightning in NVFP4 on a Brev L40S and keep it warm between calls.
- **An AI that calls you sounds like a scam.** ElevenLabs' moderation flagged one of our early callback scripts. Fair: "there's a critical alert on your account" is exactly what a scammer says. We rewrote it so Brian always says he's an AI from your app (not your bank), and never asks for codes, PINs or money.
- **Letting an AI change things safely.** Brian once put money in a kid's jar before the caller said yes. Now every write needs a spoken confirmation, enforced in code rather than the prompt.
- **Rate limits with a hall full of judges.** NVIDIA's free tier is about 40 requests a minute. We added a limiter, backoff, labelled failover and replay of identical earlier runs.
- **Deterministic reducers.** A module can't call a model or fetch a URL, and has no synchronous crypto. All model and Plaid calls live in the worker, and we wrote SHA-256 ourselves.
- **One demo room, many judges.** "Use the demo account" now gives every visitor a private copy of the demo family, so nobody steps on anybody else's demo.

## What we learned

- **A table is a great job queue.** Enqueue a row, claim it atomically, stream results back as rows. Live progress came free with subscriptions.
- **Ground every number.** Telling a model to stick to the data isn't enough. Checking its figures in code is.
- **Show your work.** Making every agent step visible changed what we built, because each step had to read as a plain sentence.
- **Say which model answered.** Fallbacks are fine; silent fallbacks are not.
- **Write voice copy for trust.** Disclose the AI first, keep answers short, and never sound like a bank.

## What's next

- Row-level security per family. Today it's a demo with synthetic data.
- Real bank connections, which need consent flows and a security review first.
- A warm handoff from Brian to a human advisor.
- Goals that update themselves as new transactions arrive.

---

## Tell us about your technology experience this weekend

- **SpacetimeDB.** The biggest speedup of the weekend. Writing the backend as one module meant live sync, presence and a live agent trace came for free, and a table worked as our AI job queue.
  - Friction: reducers are deterministic (no fetch, no synchronous crypto), so anything external lives in a separate client.
  - Every schema change means republishing and regenerating bindings in two places.
  - When self-hosting in Docker, the CLI inside the image is a symlink, which tripped our auto-deploy script until we copied the real binary.
- **NVIDIA Nemotron and Brev.** Nemotron 3 Ultra is strong at multi-step tool planning, and Lightning is fast enough for live voice.
  - The free-tier rate limit (about 40 requests a minute) is tight for a judged demo.
  - Model availability per key wasn't obvious: a Super model we planned around returned 404, and Ultra doesn't support structured output.
  - Brev was the fix for latency. An L40S running Lightning in NVFP4 on vLLM gave Brian his own model with no shared limit.
  - Nemotron streaming ASR over gRPC plugged straight into Pipecat.
- **Plaid Sandbox.** Custom sandbox users let us build realistic sample customers with months of history. Mapping Plaid's sign conventions and account subtypes took real work. The default transaction window silently clipped older history until we asked for 365 days.
- **SignalWire.** A toll-free number, inbound calls and outbound callbacks through a familiar LaML API, with signed webhooks, all quick to set up. One snag: after a teammate's burst of test calls, our toll-free number hit an outbound throttle ("exceeded outbound call rate") that isn't in the rate-limit docs, which say over-limit calls queue. Through the API the failed calls carried no error code. We added a second number for callbacks.
- **ElevenLabs.** The Brian voice is great. Its moderation catching our callback script was annoying in the moment, but it made the product safer.
- **Pipecat.** Made the voice pipeline composable (VAD, turn detection, barge-in, function calls) in Python.
- **Agentic coding (Claude Code, Codex).** We gave the coding agents one contracts doc and an AGENTS.md of hard rules: no secrets in git, synthetic data only, never touch the shared demo room. Then we ran them in parallel worktrees. Overnight they ran judge-style UX audits, verified fixes end to end on production in private copies, and produced our demo video in Remotion. The lesson: agents go fast when they have a way to check their own work (tests, live checks) and clear lines they can't cross.

---

## Did you implement a generative AI model or API in your hack this weekend?

Yes.

- **NVIDIA Nemotron 3 Ultra (550B-A55B)** via the NVIDIA API: the planner for our agent team. It calls tools on the family's data for Table Mode, What-If Studio, family votes, Ask Brianotron, onboarding insights and the scam check.
- **NVIDIA Nemotron 3.5 Lightning (30B-A3B):** fast steps and structured extraction through the NVIDIA API, and the brain of Brian, our voice assistant, **self-hosted on an NVIDIA L40S with Brev** (vLLM, NVFP4).
- **NVIDIA speech recognition:** Nemotron streaming ASR for phone calls and the Talk button, and Parakeet (NVIDIA cloud) for Table Mode recordings.
- **ElevenLabs:** text-to-speech for Brian's voice.
- **Qwen on tenvor.io:** a labelled fallback only, used if NVIDIA is unavailable.

Every model call shows up in the Agent Trail with its model, provider and latency. Figures in AI answers are checked in code against the tool results before anyone sees them. We also built the project with Claude Code and Codex as coding assistants.
