# Demo script: 3 minutes per judge panel

Fill-ins: `{{URL}}` is `https://52-72-164-85.sslip.io` until the new domain is live. `{{NAME}}` is the undecided product name.
`[verify]` marks a step or label to check on the deployed build before judging; fix the script, not the judge.

Hand out the QR code first, so judges hold the app while we talk. Every path opens the same way (the onboarding opener),
then splits by track. Each path works on its own. Close with the 20-second kicker.

**Names to use out loud.** Table Mode (was Huddle), What-If Studio, Agent Trail (was the glass box), Credit, Analytics,
Ask {{NAME}} (the coach panel). Code and tables still say `huddle`, so a Table Mode run shows `workflow: huddle` in the
Agent Trail and in SQL. Say so if a judge asks.

**Where things are.** Side nav: Dashboard, Table Mode, What-If Studio, Goals, Credit, Analytics, Agent Trail. The Family voting
card is on the Dashboard (and under Goals). `/me` opens the Riveras' room. Onboarding is `{{URL}}/onboarding`. [verify all labels after the redesign lands]

## Opener, all paths (0:00 to 0:55): a judge links the demo bank on their own phone

One judge only. A second live onboarding in the same minute can push runs onto the fallback model (see hygiene).

1. **0:00** Judge scans the QR and lands on onboarding. Welcome and consent: "We read balances, transactions and liabilities. Sandbox data only." They name the household.
2. **0:10** They tap **Use the demo bank**. No login needed. If the judge wants the real flow, tap **Link with Plaid** and sign in with `user_good` / `pass_good` (Plaid's public sandbox login). [verify the demo bank user exists in Plaid Sandbox and the one-tap path works on a phone]
3. **0:20** **Choose accounts**: all on by default, tap continue. The `plaid_sync` workflow starts.
4. **0:25** **Questions**, asked while the sync runs. Tap two priorities and a risk comfort, leave the rest on defaults. Use the judge's own answers. [verify the rest can stay default]
5. **0:45** Finish. The dashboard fills itself: accounts by type, health indicators, 90-day forecast. First insights land as Nemotron finishes (9 to 31 s). Talk over the wait: "Nothing here was typed in. It came from the bank link."

Onboarding runs on a brand-new household, so it always runs live and is never a `cache` replay. [verify] Rehearse it on a phone off the team Wi-Fi and write the real time on this page.

## PNC path (judge's phone)

Angle: the whole financial picture, understood, then acted on.

1. **0:00** Opener. Onboarding on the judge's own phone.
2. **0:55** Read their dashboard together: "Seven kinds of account, eight health indicators and a 90-day forecast with the low point marked, built a minute ago." Read one first insight aloud. [verify the demo bank covers the account types you name]
3. **1:20** Hop to the Riveras (`/me`): "This family has been here for months. They run a bakery in Oak Cliff and keep money in six places." Show net worth ($344,800) and the forecast low point (around Dec 1). [verify against the live card]
4. **1:35** **Table Mode**: tap the sample conversation. The transcript streams in. End it, and the agents pull out "second location", "college fund" and "Grandma's care". Each goal gets a feasibility chip from the real balances. "Families already plan out loud. {{NAME}} joins only when they ask." [verify the sample button label]
5. **2:05** **What-If Studio**: tap "Open a second bakery location" for the runway impact and an SBA-loan suggestion.
6. **2:25** Switch to the Nguyens: the scam alert links the "grandson in jail" call to a $2,000 gift-card purchase.
7. **2:40** Kicker.

Optional if the judge leans in: **Credit** (`/room/hh_rivera/credit`): the simulated score, what's shaping it and how household health drives about 45% of it. Or call the line, hang up, and let Brian ring back with a critical alert.

## Spacetime path (2 or 3 judges' phones + laptop)

Angle: the database is the backend, and a family shares it live.

1. **0:00** Opener. Judge A runs onboarding on their phone. Judges B and C scan the same QR, open `/me` and join the Riveras' room. "Everyone's in the room now": presence chips show each name. Point out that every onboarding step A taps is a row in SpacetimeDB. If a second member can join A's household mid-flow and watch progress, show it. [verify the join path]
2. **0:55** **Table Mode on two phones**: B taps start and both B and C enter their names as consent. The sample conversation streams to both phones at once. End it: agent steps appear, then the goal cards land on both phones at the same moment.
3. **1:35** **Family vote**: on the Dashboard's voting card, open "Take the SBA loan for the second bakery location" (Marisol yes, Daniel abstain, Elena yes are already in). B votes no, C votes yes; the tally moves on every phone. The affordability verdict (fine, tight or risky) lands on the card when the agent finishes. [verify seeded proposals carry a verdict, or pre-warm them]
4. **2:10** Laptop: open `spacetime/src` ("tables, reducers, the forecast math, the job queue; no API server, no cache, no websocket server of our own"). Then three queries:
   ```
   spacetime sql -s aws keystone "SELECT workflow, status FROM agent_job WHERE household_id = 'hh_rivera'"
   spacetime sql -s aws keystone "SELECT voter_name, choice FROM vote WHERE proposal_id = 'prop_rivera_second_location'"
   spacetime sql -s aws keystone "SELECT COUNT(*) AS n FROM transcript_line WHERE household_id = 'hh_rivera'"
   ```
   The last one returns 0: the transcript was purged after analysis. (`keystone` is the database name, not the product name. Set `aws` up once with `spacetime server add --url {{URL}} aws`. Run all three once from the venue Wi-Fi beforehand: the table names follow contracts.md section 6 and Caddy may block a laptop that is not in `ADMIN_IPS`. [verify])
5. **2:40** Kicker.

## NVIDIA path (Agent Trail on a big screen + a judge's phone)

Angle: Nemotron plans, calls tools and decides, and we show every step.

1. **0:00** Agent Trail on the big screen. "Every phone holding our QR code is starting agent runs. This is the live wall." Opener runs on the judge's phone; its `plaid_sync` run and then its `onboarding_insights` run appear in the trail as they happen. Nobody typed a question into a chat box.
2. **0:55** Expand the `onboarding_insights` run: plan, tool calls on the accounts, transactions and goals, a `thought` step with Nemotron's reasoning, then the insights it wrote. Point at the badges: Nemotron 3 Ultra planned and called tools, Nemotron 3.5 Lightning extracted structured fields, each with latency and token counts.
3. **1:30** **What-If Studio**: the judge types their own scenario. New input always runs live (9 to 31 s). In the trail: natural-language scenario, structured scenario, simulator tool, narrative. The verdict lands on the judge's phone. (Run a canned scenario first so there is a cache fallback if rates are tight.)
4. **2:10** **Family vote**: create a proposal with a number the judge picks. The same `what_if` workflow starts with the proposal as its subject; a second run appears in the trail and the verdict lands on the vote card. Say the label out loud: "provider `nvidia`", or "`cache`" if it is a replay.
5. **2:30** Honesty beat: "Every step names the provider and model that answered. If NVIDIA rate-limits us, we move to our own Nemotron on Brev, then Qwen, and the badge changes. We do not hide it." Only say Brev if it is up. [verify]
6. **2:40** Kicker.

Spare beats if a judge asks: open a Table Mode run and point at `goal_feasibility` calling College Scorecard (tuition) and FRED (rates); the `tool_result` says whether the call was live or answered from the fixed table [verify which one prod does]. Voice by itself does not satisfy this track; the agent workflow the voice triggers does.

## Kicker (20 s)

"{{NAME}} is a room the whole family shares, live, with a team of Nemotron agents that never stop checking the plan against the numbers."

## If a judge asks

- **"Is that really Nemotron?"** Each step has a provider and model badge, and `{{URL}}/worker/health` lists the live providers.
- **"Is it always listening?"** No. Voice is an opt-in session with named consent and a visible recording indicator. The transcript is deleted after analysis; we keep goals and short evidence quotes.
- **"Whose data is this?"** Synthetic households, plus a Plaid Sandbox bank. No real customer data anywhere.
- **"What does the phone line do?"** Planned, not built: call a number, a voice explains the household's finances and runs a what-if. Same tools as the coach, traced in the Agent Trail, AI disclosure at the start of every call.

## Demo hygiene

- **Pre-warm** (the day of, on the deployed box, after the last redeploy):
  1. `curl -s {{URL}}/worker/health | jq '{ok, spacetime, demo_mode, nvidia, jobs_run}'` must say `spacetime: connected`. Open the app on a phone off the team Wi-Fi: the header badge reads **Live**.
  2. Run every canned input once, with the exact text you will use at the table: the Riveras' two sample Table Mode conversations, the Nguyens' conversation, "Open a second bakery location", the Nguyens' scam check, and each proposal you will vote on (SBA loan at minimum).
  3. Open each run in the Agent Trail and confirm the provider is `nvidia`. A worker with a real provider only replays runs a real model answered, so a run that fell back to `local` will not be reused. Rerun it.
  4. Replay each once more and check it finishes in 8 seconds or less with provider `cache`.
  5. Rehearse the opener (new household, runs live) twice on a phone and note the time.
  6. Do not publish with `-c always` after this. It wipes the run history and the replay cache. [verify the cache survives a worker restart]
- **Rate limit.** The free NVIDIA tier is about 40 requests a minute, and the worker caps itself at 36. One live onboarding at a time per panel; everyone else joins the Riveras' room. Prefer canned inputs for what-ifs and votes, and let a judge type their own only when the Agent Trail is quiet.
- A noisy hall breaks live voice. Lead with the sample conversation in Table Mode, and use the live mic only if the judge asks.
- QR on a printed card and on the laptop lock screen. Test it with 3 phones at once, one of them on cellular.
- **Backup video.**
  1. After the pre-warm, record one screen capture per path on a laptop (about 60 seconds each) and one phone screen recording of the onboarding opener.
  2. Record against the deployed build. Add an on-screen caption wherever a run is a `cache` replay.
  3. Save the files on the laptop and a phone, not only in a cloud drive. Name them `pnc.mp4`, `spacetime.mp4`, `nvidia.mp4`, `onboarding.mp4`. Keep a 3-minute cut for the Devpost video.
  4. Call it a recording when you play it. If the venue Wi-Fi dies, switch to the video and say so.
- **If something breaks.** LLM outage: `cache_first` replays identical inputs (say "that is a replay"); new input falls to the fallback tiers and the badge changes. Worker down: show the Dashboard and the SQL queries, then the video. Plaid fails: skip the opener, go straight to `/me`, and say why.
