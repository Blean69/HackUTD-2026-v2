# Devpost submission draft

**Fill-ins before pasting**

- `{{URL}}`: `https://52-72-164-85.sslip.io` until the new domain is live.
- `[verify]` marks a claim the repo docs do not confirm. Resolve or delete every one before the final submit (Sun 12:00 PM).
- Features tagged *(shipping tonight)* must be cut from the text if they are not on the deployed build by then.
- Ask at the Help Desk whether one submission can enter PNC, NVIDIA and Spacetime together. [verify]
- Repo: https://github.com/Blean69/HackUTD-2026. It must be public before judging (Spacetime rule). [verify]
- Video link: add it where Devpost asks. [verify whether a video is required]

---

## Title

Brianotron

## Tagline (159 characters)

A live money room for the whole family: link a bank, then plan, vote and run what-ifs together while Nemotron agents check every idea against the real numbers.

## Initial submission, 11 PM (short version)

Brianotron is a shared financial room: a family links a bank, sees every account, health indicator and 90-day cash forecast in one place, and plans together on their own phones. Nemotron agents plan, call tools and check each goal, what-if and scam signal against the real balances, and every step shows up in an Agent Trail. All state, the AI job queue and the finance math run in SpacetimeDB, self-hosted on one EC2 box, and the code is public at https://github.com/Blean69/HackUTD-2026. [verify public]

---

## Inspiration

PNC's challenge describes a common problem. Money sits in checking, savings, CDs, an IRA, loans, cards and a mortgage, and nobody can see how the whole thing is doing or what to do next.

We added a second problem. A household has several people in it, and big money decisions get made out loud: at the dinner table, in the car, on a call with a parent. Finance apps usually assume one person on one screen, so the family's real conversation never touches the numbers.

Then there is the call nobody plans for. In our synthetic data, a retired couple, the Nguyens, get a call from a "grandson in jail" and buy $2,000 of gift cards before anyone else in the family hears about it. We wanted a place where a plan, a purchase or a worry gets checked against the real accounts while the family is still in the room.

## What it does

Brianotron is one live space that a family and a team of Nemotron agents share.

- **Onboarding.** Link a bank through Plaid (Sandbox), choose which accounts to import, and answer a few questions while the sync runs. The dashboard fills itself and Nemotron writes the first three to five insights in plain English. *(shipping tonight)*
- **Dashboard.** Accounts across eight account types (checking, savings, CD, IRA, auto loan, personal loan, credit card, mortgage), eight health indicators with a one-line explanation each, and a 90-day cash forecast with bills and loan payments marked and the low point called out. The math runs inside the database.
- **Table Mode.** The family opts in, talks (or plays a sample conversation, or types), and every phone shows the same live transcript. When they end it, Nemotron pulls out the goals, checks each one against the real balances, and posts goal cards with a feasibility chip to every screen. The transcript is then deleted; we keep the goals and a short evidence quote. Voice is opt-in per session with named consent and a visible recording indicator. Transcription uses NVIDIA ASR with browser speech as the fallback. [verify ASR path tested live]
- **Family vote.** Anyone proposes a purchase or a decision. Everyone votes from their own phone, the tally updates live, and an agent attaches an affordability check with a verdict of fine, tight or risky. *(shipping tonight)*
- **What-If Studio.** Type a scenario in plain words ("open a second bakery location"). An agent turns it into a structured scenario, runs the simulator over 12 to 24 months, and shares the verdict, the low point and a suggestion with the whole family.
- **Scam check and data quality.** Rules inside the database catch duplicates, garbled merchants, impossible values and card testing. Agents link the Nguyens' "grandson in jail" call to the $2,000 of gift cards.
- **Agent Trail.** Every plan, tool call, result, model, provider, latency and token count for every run, streaming live from every session.
- **Ask Brianotron.** A coach panel that answers by calling tools on the family's own data, with each call visible in the trail.
- **Credit monitoring.** A simulated 300–850 score per family member, mostly driven by the household's financial health, with the factors explained, a 6-month trend and alerts on big moves.
- **Brian calls you back.** About 15 seconds after a phone call, Brian rings back with a critical alert from your own accounts and stays on the line.

All data is synthetic or Plaid Sandbox. There is no real customer information anywhere.

## How we built it

**SpacetimeDB is the backend.** One TypeScript module (`spacetimedb` 2.14.1) holds every table: households, accounts, transactions, goals, proposals, votes, presence, the agent job queue and the trace log. The health indicators, the 90-day forecast and the data-quality rules are reducers, and a scheduled reducer recomputes them every 60 seconds. The browser subscribes to tables and calls reducers. It never asks an API server for data.

**Agents are a queue, not a chat box.** Reducers enqueue `agent_job` rows when a Table Mode session ends, a proposal is created, a what-if is requested or onboarding finishes. A Node worker, which is just another SpacetimeDB client, claims a job atomically and runs a multi-step workflow on a hand-rolled tool loop: write a plan, call tools, read the results, decide, write the outcome back through worker-only reducers. Every step is a `trace_event` row, so every phone sees it as it happens.

**Two Nemotron models, each in the job it fits.** Nemotron 3 Ultra plans and calls tools. Nemotron 3.5 Lightning does structured extraction through a forced tool call checked against a schema, with one retry. The tools are ledger queries, forecast, scenario simulator, goal feasibility, anomaly and scam detectors, FRED interest rates and College Scorecard tuition data. A separate workflow syncs Plaid.

**Failover that says what happened.** The worker rate-limits itself to stay under NVIDIA's free tier, waits out a 429, then moves down a list: NVIDIA Brev self-hosted Nemotron (configured as the no-rate-limit tier), Qwen on tenvor.io, and last, keyless local rules. Every trace event records the provider and model that answered. A Qwen answer is badged Qwen. An identical earlier input can be replayed from cache with realistic timing, and the badge says `cache`.

**Data.** A seeded Python generator makes five synthetic families with 2,918 transactions, 41 of them labelled anomalies. The labels never reach the math: the module has no field for them, and a test flips every label and checks that nothing changes. Plaid Sandbox supplies real bank-API data.

**Deploy.** One EC2 t3.medium runs Docker Compose with Caddy (HTTPS), the Next.js app, the Node worker and a self-hosted SpacetimeDB 2.14.1. The repo is public, so the production worker secret is a hash set at publish time and never lives in source, and Caddy only allows publishing from the team's IP. We built it with Codex and Claude Code in parallel, against generated TypeScript bindings and a shared contracts doc.

## Challenges we ran into

- **Rate limits.** NVIDIA's free tier allows about 40 requests a minute, and a hall of judges starts a lot of runs. We added a request limiter, backoff on 429, failover, and cache replay for identical inputs, and kept the labels honest at each step.
- **The right model for each job.** Nemotron 3 Ultra's model card lists structured output as unsupported, and the Super model we planned around returned 404 for our key. So Ultra plans, and Lightning extracts through a forced tool call with schema validation.
- **Deterministic reducers.** A module cannot call a model or fetch a URL, so every LLM and Plaid call lives in the worker and comes back through reducers. The module runtime also has no synchronous crypto, so we wrote SHA-256 ourselves and tested it against `node:crypto`.
- **Detectors that do not cheat.** It is easy to score well by reading the answer key. Ours cannot see it, and the measurements below come from that setup.
- **A public repo with a real deployment.** The module ships with a public dev secret for tests. Production overrides it with a hash set by an admin-only reducer.
- **Voice and privacy.** Bank judges will ask whether we are always listening. We are not: sessions are opt-in, consent is named, and the transcript is deleted after analysis.
- **Plaid's data shape.** Plaid's sign conventions and account subtypes do not match ours. We map them to our eight types and call Nemotron only for the ambiguous ones.

## Accomplishments that we're proud of

- All five agent workflows pass on real Nemotron in 9 to 31 seconds: Table Mode, what-if, coach, scam check and data quality.
- In-database rules caught card testing 7 of 7, garbled merchants 10 of 10, impossible values 3 of 3 and duplicates 10 of 11, with zero false positives on the seed.
- The scam check links the Nguyens' "grandson in jail" call to $2,000 of gift cards, four $500 purchases in one afternoon.
- Plaid Sandbox sync verified end to end: 7 accounts and 331 transactions.
- 2,918 synthetic transactions across five families, with 41 planted anomalies we can measure against.
- Tests: 32+ in the SpacetimeDB module (run against a real in-memory datastore) and 138 in the worker.
- The whole stack, self-hosted SpacetimeDB included, runs on one t3.medium, roughly $1.15 a day.
- Every trace step names the model and provider that produced it, including when that is not Nemotron.

## What we learned

- **A table is a good job queue.** Enqueue a row, claim it atomically, and stream results back as rows. Live trace streaming came free with subscriptions.
- **Show the plan.** Making every run visible changed what we built. Each step has to be a one-line human sentence, or nobody reads it.
- **Measure against planted ground truth.** One miss in duplicate detection (10 of 11) is on the table, not hidden.
- **Say which model answered.** Fallbacks are fine. Silent fallbacks are not.
- **Write the contracts first.** A binding doc for tables, reducers and trace events let several agents and people build in parallel without breaking each other.

## What's next

- **Phone line (planned, not built).** Call a number and a human-sounding voice explains the household's finances and runs a what-if by voice. It will use the same tools as the coach, appear in the Agent Trail as a traced run, match the caller by phone number and PIN, and say up front that it is an AI assistant.
- **Row-level security.** Today any identity can call any client reducer on any household. That is acceptable for a hackathon with synthetic data and not for anything else.
- **Brev as the default tier.** Move Nemotron on our own NVIDIA Brev GPU from backup to first choice for busy periods. [verify instance is running]
- **Living goals.** Goal progress that updates as new transactions arrive, and a spoken read-back of the plan.
- **Beyond Sandbox.** Real bank connections need consent flows and a security review first.

## Built with

SpacetimeDB 2.14.1 (TypeScript module, self-hosted) · NVIDIA Nemotron 3 Ultra · NVIDIA Nemotron 3.5 Lightning · NVIDIA API Catalog · NVIDIA ASR · NVIDIA Brev · Qwen on tenvor.io (vLLM) · Plaid Sandbox and Plaid Link · FRED API · College Scorecard API (data.gov) · Next.js · React · TypeScript · Tailwind CSS · Node.js 24 · Python (data generator) · Vitest · Docker Compose · Caddy · AWS EC2 · sslip.io · Codex · Claude Code

## Track fit

**PNC: 360° Financial Health Navigator.** A judge can link the demo bank on their own phone and watch the dashboard fill itself with accounts, eight health indicators and a 90-day forecast, then read the first insights Nemotron wrote. PNC listed a coach, health indicators, a forecast and a what-if simulator; each is a screen: Ask Brianotron, the Dashboard, the cash forecast, What-If Studio. The new parts are Table Mode (the family plans out loud, agents check it), the Family vote with an affordability verdict, and the Nguyens' scam check. Check the numbers on the Riveras: six institutions and a net worth of $344,800 on the seed. The forecast low point lands around December 1, when the mortgage and several other bills post together. [verify against the live card]

**NVIDIA: Use Nemotron beyond a chatbot.** Most runs start without a chat message: finishing onboarding, ending a Table Mode session, creating a proposal, opening a sandbox. Open the Agent Trail and pick any run to see plan, tool calls, tool results and the decision, each with model, provider, latency and token counts. Nemotron 3 Ultra plans and calls tools, Nemotron 3.5 Lightning extracts structured fields, the tools reach FRED and College Scorecard, the `plaid_sync` workflow reaches Plaid Sandbox, and voice goes through NVIDIA ASR [verify ASR path tested live]. All five workflows pass on real Nemotron in 9 to 31 seconds. `{{URL}}/worker/health` lists the live providers and models. Qwen on tenvor.io is a labelled fallback, and our own Nemotron on NVIDIA Brev is configured as the tier with no shared rate limit. [verify `brev` appears as a provider in the trace]

**Spacetime: main track.** SpacetimeDB holds all application state. There is no other database and no REST data API. The health indicators, the 90-day forecast and the data-quality rules are reducers, a scheduled reducer recomputes them every minute, and the AI job queue is a table with an atomic `claim_job`. Presence, the Table Mode transcript, goal cards, votes, onboarding progress and agent trace events all sync to every phone as row updates. The worker is an ordinary SpacetimeDB client. Everything is in the public repo (`spacetime/src`): 32+ module tests run against a real in-memory datastore. We self-host SpacetimeDB 2.14.1 on EC2 instead of using Maincloud. [verify sponsors accept this]

## Try it: the 60-second judge path

Phone, no account, no real data. Start at `{{URL}}/onboarding`. [verify route, that the questions can be skipped, and that this really takes 60 seconds on a phone]

1. **0:00** Name your household and accept the consent screen (sandbox data only).
2. **0:10** Tap **Use the demo bank**. Prefer the real flow? Tap **Link with Plaid** and sign in with `user_good` / `pass_good`, Plaid's public sandbox login.
3. **0:20** Keep all accounts selected and continue. Pick two priorities and finish.
4. **0:45** Your dashboard has filled itself: accounts, health indicators, 90-day forecast. The first insights appear as Nemotron finishes (9 to 31 seconds).
5. **0:55** Open **Agent Trail** and find the run you just started: plan, tool calls, the model that answered.

Two more minutes:

- Open `{{URL}}/me` for the Riveras' room. In **Table Mode**, play the sample conversation and watch goal cards land with feasibility chips.
- Vote on the SBA loan proposal on the Dashboard. The tally moves on every phone, and the affordability verdict appears when the agent finishes.
- In **What-If Studio**, tap "Open a second bakery location".
- Switch to the Nguyens to see the scam alert tie a phone call to $2,000 of gift cards.

With a laptop: the code is at https://github.com/Blean69/HackUTD-2026, and `spacetime/src` is the entire backend.
