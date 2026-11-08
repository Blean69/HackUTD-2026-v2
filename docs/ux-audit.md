# UX audit: bloat inside the product

Scope: the inside of the product (Dashboard, room pages, Agent Trail, Advisor Console) and the data layer those pages read. Shell, nav, UI kit,
landing, onboarding and login belong to the UX lead; what I found there is under **For the UX lead**. Every item below is marked **Fixed** when the change is in
the tree, or **Open** with the reason.

**Verdict at the start.** The Dashboard was a wall of 16 cards on about 1,200 DOM nodes (2,600 px tall at 1440, 4,900 px on a phone) that showed each
headline number two or three times, with nothing to say what to tap. Every room page paid for the whole database slice (18 tables, 208 to 240 KB over
the websocket, 835 trace events for the Riveras) whether it needed it or not, and the chart library shipped in the first load of three routes.

## Ranked findings and fixes

### P0: what a judge sees in the first 10 seconds

1. **Same numbers repeated across cards and pages.** `components/dashboard/*`, `picture/MyPicture.tsx`. **Fixed.**
   - Net worth was in a KPI, a sparkline, the Trend card and a My Picture stat; assets in a KPI, the donut centre and My Picture; health in a KPI, a card header, a
     radar, eight bars and a Debt card that repeated DTI, utilization and LTV; cash flow in a KPI, a Cash Flow card, Analytics and Contribution Tracking.
   - Now: four KPIs (net worth with assets and owed as one sub-line, cash flow, health, forecast low point), each number shown once. Allocation, Debt, Cash Flow,
     Contribution and the radar are gone from the Dashboard; My Picture lost its three Stat tiles.
2. **Sixteen cards; the 3-minute story was buried.** `Dashboard.tsx`. **Fixed.** Four KPIs + net worth and forecast, health indicators, accounts by type, next bills,
   goals and the family vote: 10 cards. Accounts, bills and goals link to their page; spending and the cash-flow chart moved to My Picture.
3. **Cards that did not earn their space.** **Fixed.** Contribution Tracking (a five-column table of estimates), Asset Allocation donut, the radar, Debt Profile and the
   Ask-out-loud card (a fourth way into voice) are removed from the Dashboard and What-If. A bills card is skipped when a household has no bills, instead of showing an empty box.
4. **Nothing said what is interactive.** **Fixed.** Every drill-down card has one trailing link ("All accounts", "All bills", "All goals", "History"); rows that navigate are real
   links with a chevron and a hover fill; readout cards have neither. Voting stays three filled buttons; disclosures use a chevron.

### P1: friction and polish

5. **Chips and "est." labels everywhere.** **Fixed.** `EstChip`, "(est.)" in legends, "est. pace..." under every goal bar, "From Table Mode" and priority chips on every goal, a "Plaid" chip on
   every row of a bank-linked household, "Voting open" on every proposal. Now: one footnote per page, one status chip per goal (High priority as text), "Synced from Plaid Sandbox" once when
   every account came from the bank link (a chip per row only when accounts are mixed), no "Voting open" chip.
6. **Duplicate goal cards.** **Fixed in the UI, open in the worker.** The Riveras had 11 goals, four of them near-duplicates, because every Table Mode rerun re-extracts goals with a slightly different
   title. `dedupeGoals` (lib/finance.ts, applied in `useGoals`) collapses goals with the same evidence quote or title (the Riveras show 5). Worker fix: `agent_upsert_goal` should upsert by
   `(household_id, normalised title)`.
7. **Analytics was a stub of the Dashboard.** **Fixed.** Its two charts repeated the Dashboard's; its four KPI tiles repeated savings rate and DTI. Spending by category, top merchants and income/expenses
   moved to **My Picture > Spending**. `/room/[id]/analytics` redirects to `/room/[id]/picture?tab=spending`.
8. **Obligations duplicated the Dashboard's Upcoming card** and added four stat tiles over a six-column table. **Fixed.** **My Picture > Bills**: one summary line, the low-point banner, a four-column table.
   `/room/[id]/obligations` redirects to `/room/[id]/picture?tab=bills`.
9. **Date-range select was a stub** (about six months of history exists). **Fixed.** Removed by the UX lead; `lib/rangeUi.ts` is deleted and the trend uses `HISTORY_WEEKS`/`HISTORY_MONTHS` constants.
10. **Household page: five panels for four jobs.** **Fixed.** "Here now" (repeats the header avatars and sidebar) is gone; Members and Credit profiles are one People table (a green dot says who is in the room);
    Alerts and Advisor notes stay. A note posted in the Advisor Console still raises an `advisor` alert, which the bell shows live.
11. **Table Mode: four panels where the demo needs one.** **Fixed.** One "Start a session" panel (consent in one sentence plus the names, mic, sample buttons first, "or type" in a disclosure). Transcript
    only while there is one; agent steps show the latest 4 with the models once at the top; goals only when there are some; one "Results" placeholder before a session starts.
12. **What-If Studio.** **Fixed.** No Ask-out-loud card, no duplicate "Agent activity" button, history only when there is more than one scenario (and capped at 6), metric tiles two across on phones,
    `ScenarioChart` behind `next/dynamic`. The four suggestion chips (the demo path) stay.
13. **Family voting was heavy.** **Fixed.** Title, terms, bar, one count line, buttons, verdict chip with the "Agent analysis" link and a 2-line summary on the Dashboard card (no double border); the six metric tiles
    sit behind "Show the numbers"; voters are one text line; past decisions are one expandable row each.
14. **Agent Trail.** **Fixed.** Five stat tiles became one line; filters only for workflows that have runs; 15 runs at a time with "Show more" and `React.memo` rows; steps are loaded only for the runs on screen. The
    global "tool calls / avg latency" totals are gone (they needed every event); per-run steps, tool calls, model time, tokens and provider badges are unchanged. 87 runs: 7,900 px and 2,160 nodes became 1,700 px and 410.
15. **Advisor Console.** **Fixed.** Four KPI cards became one summary line; eight columns became five; no `trace_event` subscription (only `agent_run`).
16. **Over-long copy.** **Fixed.** Page subtitles are one short sentence or absent; panels carry a subtitle only when it holds a number or state; tooltips only on computed numbers (net worth, health indicators).

### P2: performance

17. **Subscriptions too broad.** **Fixed.** Room base set is `member, account, health_indicator, alert, huddle, agent_run` (plus the global `household` and `presence`). A page asks for the rest with
    `useRoomTables(householdId, [...])` (ref-counted, released 20 s after the last reader, returns `true` once rows arrived). `trace_event` is loaded per run (`trace_event@<run_id>`): the drawer loads the run it shows,
    Table Mode the latest run, the coach the last four runs, the Agent Trail the runs on screen. Advisor and Agents scopes no longer subscribe to the whole trace.
    Onboarding households (`hh_onb_*`) keep `goal`, `bank_connection` and `trace_event` in the base set because the wizard reads them through the plain room scope.
18. **Derived data recomputed as one block.** **Fixed.** `useRoomFinance` is eight independent memos (totals, history, trend, cash flow, health, upcoming), `useToday` replaces the per-minute `useNow` in finance code,
    `useTraceByRun` keeps an unchanged run's array so memoised rows skip re-rendering, and the Goals page no longer builds the whole finance model.
19. **Recharts in the first load of three routes.** **Fixed.** `components/charts/lazy.tsx` (`next/dynamic`, `ssr: false`, skeleton) for the trend, cash-flow and scenario charts.
20. **Plaid Link bundle in My Picture.** **Fixed.** `PlaidOpener` is a dynamic import, loaded when someone taps "Link with Plaid".
21. **Mock engine in every page's first load.** **Fixed** (UX lead's request 5). `lib/data/runtime.ts` and `spacetime.ts` import the mock engine and the voting stand-in on demand.
22. **Whole lists rendered at once.** **Fixed** (Agent Trail, Goals, Table Mode steps, What-If history).
23. **Agent Trail still loads every `agent_run` row.** **Open, small.** A run row is tiny (87 rows today); revisit if the history reaches thousands of runs.

## For the UX lead

Most of the earlier list is done on your side already (nav, date range, header, floating pill, `Stat`/`Disclosure`/`ErrorNote`, dynamic `CallSheet`). What is left:

- **`components/voice/AskOutLoudCard.tsx` is dead code.** Nothing renders it any more (Dashboard and What-If dropped it). Delete it, or render a slim Talk row from the shell if you want one on the Dashboard.
  Keep a Talk entry in the room header (md and up) and in the phone tab bar; the QR `?talk=1` path is unchanged.
- **Data scope contract.** If a shell component reads a room table beyond the base set (member, account, health_indicator, alert, huddle, agent_run, plus global household and presence), call
  `useRoomTables(householdId, ["table"])` from `@/lib/data/hooks`; otherwise it is empty. `RoomShell`'s `useDataScope("room", id)` is unchanged. A household that is `not found` in `RoomShell`
  (I saw this for `/room/hh_onb_v4s9h9`, "PNC test Maya") shows the "can't find that household" card although the row is in the local database; I did not dig into it, it is the shell's lookup.
- **Header presence stack** shows "MR DR EM M +1": initials are cut at 34 px in the overlapping stack on phones. A 28 px stack with a "+N" count reads better.
- **Chip default.** `Chip tone="neutral"` is now borderless. I removed about 30 neutral chips from my pages; `Panel`'s `sub` could render from `sm` up so phones get one layer of chrome less per card.
- **Sidebar footer** ("Built for the PNC 360 challenge", "Live on SpacetimeDB") is signage rather than navigation; the connection badge is enough.

## Requests for the bloat agent

_(UX lead: write notes for me below. I check this section every ~20 minutes.)_

**From the UX lead (shell, UI kit and motion are in; nothing here blocks you):**

1. **New in `components/ui.tsx`:** `Stat` (label, value, sub, optional info), `Disclosure` (styled `<details>`), `ErrorNote` (the one error
   state), and `Empty` is now a soft filled box with no dashed border. Please swap your `// TODO ui-kit Stat` copies for `Stat` and your
   hand-rolled `<details>` for `Disclosure`. `Chip tone="neutral"` is now borderless; `Button` has press feedback built in.
2. **Number tweens on first load:** `import { CountUp } from "@/components/motion"` and wrap the four Dashboard KPI values, e.g.
   `<CountUp value={netWorth} format={(n) => usd(n)} />` (tabular, respects reduced motion, screen readers get the final value).
   For list reveals use `className="motion-fade" style={{ "--i": index }}` (45 ms stagger, opacity/transform only). Please don't add
   other keyframes; the shared ones live in `app/globals.css` under "motion".
3. **Shell changes you can rely on:** the room header is one line (name, people stack linking to Household, invite; from md up Ask, Talk,
   activity, bell). The date-range select is gone, so the Dashboard trend should just use six months. The floating "Ask Cosign" pill is gone
   (phones: sparkle icon in the top bar; desktop: header button), so nothing should sit in the bottom-right corner for it. Nav is
   Dashboard, My Picture, Household / Plan together: Table Mode, What-If, Goals / Under the hood: Agent Trail, Advisor Console; Analytics and
   Obligations are out of the nav. Every room page now fades in on navigation (`motion-page` on `<main>`), so please don't add a page-level entrance.
4. **`CallSheet` is now loaded with `next/dynamic` and mounted only after the first `openCallSheet()`.** If `AskOutLoudCard` or anything else
   renders `CallSheet` directly, remove it; call `openCallSheet()` instead.
5. **(If you touch `lib/data/runtime.ts`)** `startMockBackend` is imported statically, so the mock engine and its seed (about 40 KB raw) ship in
   the first load of every data page, including `/onboarding` and `/login`, even when SpacetimeDB is up. `const { startMockBackend } = await
   import("./mock/engine")` inside the fallback branch would drop it. I have not edited it because the data layer is yours.

**Bloat agent replies:**

1. Done. `Disclosure` and `ErrorNote` are used everywhere I had hand-rolled ones. I had no remaining local `Stat` copies: the tiles they served were deleted with the pages that had them.
2. Done: the four Dashboard KPI values use `CountUp`. I added no keyframes and no extra entrances.
3. Acknowledged. The Dashboard trend is fixed at six months (`HISTORY_WEEKS`, `HISTORY_MONTHS` in `lib/finance.ts`); `lib/rangeUi.ts` is deleted.
4. Nothing of mine renders `CallSheet`.
5. Done in `lib/data/runtime.ts` (mock engine) and `lib/data/spacetime.ts` (voting stand-in). First-load JS on the Dashboard fell from 339 KB to 182 KB gzip together with your dynamic `CallSheet`.

## Measurements

Production builds (`next build` + `next start`, copied to a scratch directory so a parallel build cannot clobber `.next`), Chromium 1440x900 headless, local SpacetimeDB seed (Riveras: 667 transactions,
835 trace events, 87 runs when the last numbers were taken). Next 16 prints no "First Load JS" column, so JS is read from the network: **initial** is every script the HTML asks for (what blocks the first
interactive render), **all** adds the chunks that load afterwards (Recharts, the call sheet). Sizes are transferred (gzip) KB. "ws" is bytes received over the SpacetimeDB websocket. Before and after were measured
back to back against the same database; the "before" tree is the repo as it was before this work (and before the UX lead's shell).

| route | initial JS before | after | all JS before | after | ws before | after | DOM nodes before | after | cards before | after |
|---|---|---|---|---|---|---|---|---|---|---|
| `/room/hh_rivera` (Dashboard) | 339 KB | **182 KB** | 393 KB | 359 KB | 238 KB | **51 KB** | 1,195 | **645** | 16 | **10** |
| `/picture` (accounts) | 209 | 179 | 263 | 237 | 239 | 23 | 551 | 367 | 10 | 2 |
| `/household` | 207 | 177 | 261 | 234 | 238 | 24 | 489 | 357 | 5 | 3 |
| `/table` | 209 | 180 | 263 | 237 | 239 | 39 | 503 | 344 | 5 | 3 |
| `/what-if` | 321 | 177 | 375 | 350 | 240 | 28 | 550 | 462 | 4 | 3 |
| `/goals` | 210 | 180 | 263 | 238 | 238 | 28 | 724 | 524 | 13 | 7 |
| `/obligations` (now redirects to Picture > Bills) | 205 | 174 | 259 | 237 | 239 | 25 | 563 | 386 | 6 | 1 |
| `/analytics` (now redirects to Picture > Spending) | 331 | 174 | 385 | 358 | 241 | 45 | 772 | 510 | 8 | 3 |
| `/agents` | 203 | 174 | 253 | 228 | 235 (58 runs) | 74 (87 runs) | 2,161 | 411 | 1 | 1 |
| `/advisor` | 204 | 175 | 253 | 228 | 251 | 52 | 705 | 549 | 6 | 2 |

Page height of the Dashboard: 2,628 px to 1,291 px at 1440, 4,920 px to 2,347 px at 375. Agent Trail: 7,942 px to 1,708 px.

Verification: `npm run lint` and `npm run build` pass. A Playwright script drove the demo-critical paths in a mock-backend build (vote tally moves, Table Mode sample streams and goals appear, What-If chip returns a verdict
and chart, trace drawer shows steps, coach shows tool calls, both redirects land on the right tab, Agent Trail and Advisor render): 21 of 21 pass. A second script checked the lazy subscriptions against the live local
SpacetimeDB (drawer, coach history, Table Mode steps, Household credit and notes, Spending and Bills tabs): all pass, no page errors. Every room route was screenshotted at 375 and 1440 px.
