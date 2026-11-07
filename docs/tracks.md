# Tracks → how Keystone wins each

Paraphrased from the opening-ceremony slides (Nov 7, 2026). If anything here is wrong, ask a sponsor mentor.

> **Verify first:** can one Devpost submission enter PNC + NVIDIA + Spacetime at the same time? Ask at the Help Desk
> before the 11:00 PM initial Devpost deadline. (Spacetime's slide says you can enter both of *its* tracks; check the others.)

## PNC — 360° Financial Health Navigator
**Their ask:** people hold money in checking, savings, CDs & IRAs, loans, credit cards and mortgages, but have no single
clear view of how they're doing or what to do next. Help them see the whole picture, understand it, and act with confidence.
Example directions on their slide: a conversational coach, 3+ health assessment indicators, forecasting balances &
obligations, a "what if" simulator, or something nobody has thought of yet.

| Their example | Our feature |
|---|---|
| Conversational coach | Coach that answers by calling tools on the family's own (synthetic) data, with every call visible |
| Whole picture across institutions | Real bank-API data: connect a bank through **Plaid Sandbox** (Link on the judge's phone, or one-tap sandbox connect). Accounts, liabilities and transaction history flow into the same room |
| 3+ health indicators | Six indicators computed live: liquidity runway, DTI, credit utilization, savings rate, net-worth trend, emergency fund |
| Forecast balances & obligations | 90-day cash forecast with bills and loan payments marked, plus the low point |
| What-if simulator | Natural-language scenarios ("open a second bakery location") → simulated impact, shared with the whole family |
| *Something new* | **Huddle**: the family plans out loud, together, on their own phones. Agents turn the talk into goals checked against real balances. **Scam Shield** catches elder-fraud patterns in the conversation and the transactions. **Advisor console**: a PNC advisor sees consenting families' health and can drop a note into their room live |

Judge pitch: *"Families already plan out loud at the dinner table. Keystone joins only when they ask, and checks every plan against their real accounts."*

## NVIDIA — Use Nemotron beyond a chatbot
Requirements: (1) beyond a chatbot, (2) multi-step agent workflows that plan and execute, (3) tool integration with
external APIs/services, (4) real-world applicability.

| Requirement | Evidence a judge can see |
|---|---|
| Beyond a chatbot | Most runs start without a chat: a Huddle ending, a new sandbox (data audit), a simulation request |
| Multi-step workflows | huddle, what_if, coach, scam_check, data_quality. Each emits plan → tool calls → results → decision, live in the glass box |
| Tool integration | Internal tools (ledger queries, forecast, simulator, anomaly classifier, scam detector) and external APIs (Plaid Sandbox banking, FRED interest rates, College Scorecard tuition data, NVIDIA ASR) |
| Real-world | Elder scams and opaque household finances are real, expensive problems |
| NVIDIA stack depth | Nemotron reasoning model for planning, a small Nemotron for extraction, NVIDIA ASR for voice, visible Nemotron reasoning. Qwen on our own NVIDIA GPU cloud (tenvor.io) is only a safety net, and every trace badge says honestly which model answered |

Voice by itself does not satisfy this track. The multi-step agent workflow that the voice triggers does.

## Spacetime — Main track ("Build your project on Spacetime")
**Their rule:** Spacetime must power the app's primary functionality, not just chat or player movement. Public source
code on GitHub is required to win. Free Maincloud credit: code `HACKUTD2026` (one per GitHub account).

| What they'll look for | Our evidence |
|---|---|
| Primary functionality on Spacetime | 100% of app state lives in SpacetimeDB tables. There is no other database and no REST API |
| Server logic in the DB | Health indicators, 90-day forecast and data-quality rules run as reducers inside the module. A scheduled reducer recomputes every minute |
| Multiplayer by default | A family room on several phones: presence, live transcript, goals, simulations and advisor notes sync instantly to everyone |
| Not just glue | The AI job queue *is* a table: reducers enqueue, the worker claims atomically, trace events stream back as rows |
| Agents love it | We built it with Codex + Claude Code against generated TypeScript bindings. One type system end to end |

Judge pitch: *"Three phones, one family, zero backend code outside the database."*

Side quest: Spacetime's **ScrabbleBot tournament** (live at 10:45 PM Saturday; TypeScript starter). Only send someone who
would otherwise be idle. It collides with the 11 PM Devpost deadline.

## Cheap extra shots (only if multi-entry is allowed and it takes under 30 min)
- **MLH Best Domain (GoDaddy Registry)**: register the demo domain with code `MLHUTD84`. We need a domain for HTTPS anyway.
- **Capital One Best Use of Nessie**: a Nessie-backed account import tool. Only if the API is live and it fits cleanly.
