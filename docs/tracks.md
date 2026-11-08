# Tracks → how Brianotron wins each

Paraphrased from the opening-ceremony slides (Nov 7, 2026). If anything here is wrong, ask a sponsor mentor.

> **Verify first:** can one Devpost submission enter PNC + NVIDIA + Spacetime at the same time? Ask at the Help Desk
> before the 11:00 PM initial Devpost deadline. (Spacetime's slide says you can enter both of *its* tracks; check the others.)
> Goldman Sachs was dropped. Three tracks remain. Submission text lives in [devpost.md](devpost.md).

**Status column.** *Verified* = tested on the deployed build. *Building* = in progress on Nov 7; re-check before the final
submit and cut it from the pitch if it is not live. *Planned* = designed, not built; never present it as working.

**Names.** Huddle is now **Table Mode**. The glass box is now **Agent Trail**. The simulator is **What-If Studio**. The coach
panel is **Ask Brianotron**. The code keeps the old names (`huddle` workflow and table, `/agents` route), so a Table Mode run
reads `huddle` in the trail and in SQL.

## PNC: 360° Financial Health Navigator
**Their ask:** people hold money in checking, savings, CDs & IRAs, loans, credit cards and mortgages, but have no single
clear view of how they're doing or what to do next. Help them see the whole picture, understand it, and act with confidence.
Example directions on their slide: a conversational coach, 3+ health assessment indicators, forecasting balances &
obligations, a "what if" simulator, or something nobody has thought of yet.

| Their example | Our feature | Status | Evidence a judge can check |
|---|---|---|---|
| Whole picture across institutions | **Onboarding**: link a bank through Plaid Sandbox (one-tap demo bank, or Plaid Link) → choose accounts → answer questions → the dashboard fills itself → first insights | Sync verified; onboarding flow building | Plaid sync: 7 accounts, 331 transactions. Judge links the demo bank on their own phone at `https://brianotron.us/onboarding` and watches the dashboard fill. The demo bank is a Plaid Sandbox custom user [verify it exists and the one-tap path works] |
| Conversational coach | **Ask Brianotron** panel: answers by calling tools on the family's own (synthetic) data | Verified (coach workflow); panel building | Every tool call is visible in the Agent Trail |
| 3+ health indicators | **Eight** indicators computed in the database: liquidity runway, debt-to-income, credit utilization, savings rate, net-worth trend, emergency fund, forecast low point, credit score. (This file said six before; the module computes eight.) | Verified | Dashboard cards each carry a one-line explanation. Math is in `spacetime/src/finance.ts` |
| Forecast balances & obligations | 90-day cash forecast with bills and loan payments marked, plus the low point | Verified | Riveras' low point lands around Dec 1 [verify on the live card]. Patel's room should show an overdraft alert when the forecast goes negative [verify] |
| What-if simulator | **What-If Studio**: plain-language scenarios → simulated impact, shared with the whole family | Verified (what_if workflow); studio UI building | "Open a second bakery location" returns runway impact and an SBA-loan suggestion |
| *Something new* | **Table Mode**: the family plans out loud on their own phones; agents turn the talk into goals checked against real balances | Verified (huddle workflow); rename and UI building | Goal cards with feasibility chips on every phone; transcript purged after analysis |
| *Something new* | **Family vote**: a member proposes a purchase, everyone votes live, an agent attaches a fine / tight / risky affordability check | Building | Five seeded proposals and 12 seeded votes (`data/seed/proposals.json`, `votes.json`). The check is the `what_if` workflow with the proposal as subject |
| *Something new* | **Scam check**: catches elder-fraud patterns in the conversation and the transactions | Verified | The Nguyens' "grandson in jail" call is linked to $2,000 of gift cards (four $500 purchases, Oct 21) |
| *Something new* | **Credit monitoring**: a simulated 300–850 score per family member, driven mostly by the household's financial health, with a 6-month trend, the factors behind it and alerts on big moves. **Brian calls you back** about 15 s after a call with a critical alert from your own data | Built tonight |
| *Something new* | **Phone line**: call a number, a human-sounding voice explains the household's finances and runs a what-if by voice | **Planned. Not built.** | Constraints are set in contracts.md section 8: same tools as the coach, traced as `phone` runs, caller matched by phone number plus PIN, spoken AI disclosure on every call |

Judge pitch: *"Families already plan out loud at the table. Brianotron joins only when they ask, and checks every plan against their real accounts."*

Bank-judge question to be ready for: voice is opt-in per session, with named consent and a visible recording indicator. The transcript is deleted after analysis. We keep goals and short evidence quotes.

## NVIDIA: Use Nemotron beyond a chatbot
Requirements: (1) beyond a chatbot, (2) multi-step agent workflows that plan and execute, (3) tool integration with
external APIs/services, (4) real-world applicability.

| Requirement | Evidence a judge can see | Status |
|---|---|---|
| Beyond a chatbot | Most runs start without a chat: finishing onboarding (`onboarding_insights`), ending a Table Mode session, creating a proposal, a new sandbox (data audit), a simulation request | Verified: Table Mode end, sandbox data audit, simulation request. Building: onboarding and vote triggers |
| Multi-step workflows | `huddle`, `what_if`, `coach`, `scam_check`, `data_quality` all pass on real Nemotron in 9 to 31 s. Plus `plaid_sync` and `onboarding_insights`. Each emits plan → tool calls → results → decision, live in the Agent Trail | Five verified; `plaid_sync` verified; `onboarding_insights` building |
| Tool integration | Internal tools (ledger queries, forecast, simulator, goal feasibility, anomaly classifier, scam detector) and external APIs (Plaid Sandbox, FRED rates, College Scorecard tuition). Voice goes through NVIDIA ASR | Verified, except ASR [verify tested live; browser speech is the fallback]. FRED answers from a fixed table without a key, and the trace says which path answered |
| Real-world | Elder scams and opaque household finances are real, expensive problems | n/a |
| NVIDIA stack depth | **Nemotron 3 Ultra** plans and calls tools. **Nemotron 3.5 Lightning** extracts structured fields (forced tool call, schema-checked, one retry). NVIDIA ASR for voice. **NVIDIA Brev**: our own self-hosted Nemotron, configured as a no-rate-limit tier | Ultra and Lightning verified. Brev configured [verify an instance is running and `brev` appears as a provider in the trace; contracts.md lists nvidia, tenvor_nemotron, tenvor_qwen, cache, local] |

**Provider tiers and honest labelling.** Failover order: NVIDIA API (Ultra, Lightning) → Brev self-hosted Nemotron →
Qwen on tenvor.io → keyless local rules. The worker rate-limits itself (36 requests a minute against NVIDIA's free tier of
about 40), waits out a 429, and only then fails over. Every trace event records the provider and model that answered:
a Qwen answer is badged Qwen with the model id the server returned, preceded by a "Switched provider" message; a cache replay is badged
`cache`; a rules answer is badged `local`. We never present a Qwen or cache run as live Nemotron. Qwen is a safety net, not a
selling point. Brev credits buy GPU hours, not API quota, so Brev only helps if an instance is up when we demo.

Voice by itself does not satisfy this track. The multi-step agent workflow that the voice triggers does.

## Spacetime: Main track ("Build your project on Spacetime")
**Their rule:** Spacetime must power the app's primary functionality, not just chat or player movement. Public source
code on GitHub is required to win. Free Maincloud credit: code `HACKUTD2026` (one per GitHub account).

| What they'll look for | Our evidence | Status |
|---|---|---|
| Primary functionality on Spacetime | 100% of app state lives in SpacetimeDB tables. There is no other database and no REST data API. The worker is an ordinary SpacetimeDB client | Verified |
| Server logic in the DB | Eight health indicators, the 90-day forecast and the data-quality rules run as reducers inside the module. A scheduled reducer (`tick_recompute`) recomputes every 60 s. Rules caught card testing 7/7, garbled 10/10, impossible values 3/3, duplicates 10/11, with zero false positives on the seed | Verified |
| Multiplayer by default | A family room on several phones: presence, live Table Mode transcript, goal cards, simulations and votes sync instantly to everyone | Verified; redesign building |
| Family vote | `proposal` and `vote` tables; one vote per identity, changeable until closed; every phone sees the tally move. The agent verdict is written back to the same row | Building |
| Onboarding as shared state | Every onboarding step (`household_profile`, `bank_connection`, `bank_account_option`) is a row, so a second family member can join mid-flow and watch progress | Building [verify the join path in the UI] |
| Not just glue | The AI job queue *is* a table: reducers enqueue, the worker claims atomically (`claim_job`), trace events stream back as rows | Verified |
| Agents love it | We built it with Codex and Claude Code against generated TypeScript bindings. One type system end to end | Verified |
| Quality | 32+ module tests against a real in-memory datastore; 138 worker tests. A module test flips every anomaly label and shows the math does not change | Verified |
| Deploy | Self-hosted SpacetimeDB 2.14.1 in Docker Compose behind Caddy on one EC2 t3.medium, with Next.js and the Node worker. Not Maincloud [verify the sponsor counts self-hosted the same] | Verified |
| Public source | https://github.com/Blean69/HackUTD-2026. No secrets in git; production worker secret is a hash set at publish time | [verify the repo is public before judging] |

Checkable live: `spacetime sql -s aws keystone "SELECT workflow, status FROM agent_job WHERE household_id = 'hh_rivera'"`
(set up the server once with `spacetime server add --url https://brianotron.us aws`; `keystone` is the database name). [verify it works from a non-team network]

Judge pitch: *"Three phones, one family, zero backend code outside the database."*

Side quest: Spacetime's **ScrabbleBot tournament** (live at 10:45 PM Saturday; TypeScript starter). Only send someone who
would otherwise be idle. It collides with the 11 PM Devpost deadline.

## Cheap extra shots (only if multi-entry is allowed and it takes under 30 min)
- **MLH Best Domain (GoDaddy Registry)**: register the demo domain with code `MLHUTD84`. A new domain is coming anyway; if it
  is registered through that registrar, enter it. [verify the registrar qualifies]
- **Capital One Best Use of Nessie**: a Nessie-backed account import tool. Only if the API is live and it fits cleanly.
