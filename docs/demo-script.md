# Demo script: 3 minutes per judge panel

Hand out the QR code first, so judges hold the app while we talk. Each path works on its own.
Open with that track's angle and close with the 20-second kicker.

## PNC path (judge's phone)
1. **0:00** "This is the Rivera family. They run a bakery in Oak Cliff and keep money in six places." Show net worth, accounts and health cards.
2. **0:30** Forecast: "Here's the low point in 23 days. Payroll and the mortgage hit the same week."
3. **0:50** Huddle: the judge taps **Play a sample Huddle** (or talks, if the room is quiet). The transcript streams in. End the Huddle and the agents extract "second location", "college fund" and "Grandma's care". Each goal gets a feasibility chip based on the real balances.
4. **1:50** What-if: tap "Open a second bakery location" to see the runway impact and an SBA-loan suggestion.
5. **2:20** Switch to the Nguyens: a Scam Shield alert links the "grandson in jail" call to a $2,000 gift-card purchase.
6. **2:45** Kicker.

## Spacetime path (2–3 judges' phones + laptop)
1. **0:00** "Everyone scan this. You're all in the Riveras' room now." Presence chips show each judge's name.
2. **0:20** One judge starts a Huddle and talks. Every phone shows the transcript live.
3. **0:50** End the Huddle. Agent steps and then goal cards appear on every phone at the same moment.
4. **1:20** Laptop: open `spacetime/src`. "This module is the entire backend: tables, reducers, the forecast math, the job queue. No API server, no cache, no websockets of our own."
5. **2:00** Run `spacetime sql` on `agent_job` and `trace_event` to show the AI pipeline as rows. Then show that the transcript is purged after analysis (privacy by design).
6. **2:45** Kicker.

## NVIDIA path (`/agents` on a big screen + judges' phones)
1. **0:00** "Every phone holding our QR code is starting agent runs. This is the live wall."
2. **0:20** Expand a huddle run: plan → extract goals → query ledger → forecast → feasibility per goal → scam check → post results. Point at the badges: Nemotron reasoning model planned it, a small Nemotron extracted fields, and FRED and College Scorecard were called live.
3. **1:20** Expand a what_if run: natural-language scenario → structured scenario → simulator tool → narrative.
4. **2:00** Failover: disable the NVIDIA key and the next run lands on our self-hosted Nemotron on tenvor.io GPUs. The badge changes and the run keeps going.
5. **2:45** Kicker.

## Kicker (20 s)
"Keystone is a room the whole family shares, live, with a team of Nemotron agents that never stop checking the plan against the numbers."

## Demo hygiene
- Pre-warm: run every seed workflow once in `live` mode before judging so `cache_first` replays are instant.
- A noisy hall breaks live voice. Lead with **Play a sample Huddle**, and use the live mic only if the judge asks.
- Have a 60-second screen recording of each path on a laptop in case the venue Wi-Fi dies.
- QR on a printed card and on the laptop lock screen. Test it with 3 phones at once.
