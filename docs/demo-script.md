# Demo script: judging, Sunday 1–4 PM

Three minutes, two people. **Driver** runs the laptop; **Caller** holds the phone and calls Brian on speaker.
Words in quotes are what we say. Everything else is what we tap.

## The table

| What | Setup |
|---|---|
| **Laptop, between judges** | Our video, full screen, looping, muted. It pulls people over. |
| **Laptop, when a judge sits down** | Switch to the live app, because live beats video. Chrome, dark mode, tabs in this order (Ctrl+1…4): **1** Rivera dashboard `brianotron.us/me` · **2** Kids & Teens · **3** What-If Studio · **4** Agent Trail. It must be the shared Rivera room, not a private copy: Brian's phone changes land there. |
| **Caller's phone** | Speaker on, volume up. Brian's callback number **+1 (945) 403-0355** saved as a contact named "Brian", so Call Screen doesn't eat the callback. The family code memorised (never on a slide). |
| **Printed QR card** | Points to `brianotron.us/me`, so judges watch the same room on their own phone. Card text: "Call Brian: +1 (844) 468-1795". |

## The 3-minute script

**0:00 Hook (Driver, laptop on the dashboard)**
> "Americans get fewer than half of basic money questions right: 47%, the lowest in ten years. For Gen Z, us, it's 38%.
> The problem isn't a lack of advice. Your money is scattered across six apps, and the real decisions happen out loud,
> at the dinner table, where nobody has the numbers. Brianotron puts the whole family's financial picture in one live room,
> and gives you Brian, an AI you can just call."

**0:25 The big picture (Driver)**
- Point at the top row: "The Riveras: **$344,800** net worth across six banks, **+$1,177** a month left over, a health score of **79 out of 100**. Their cash dips to about **$40k** on November 24 when bills stack up."
- "Every number is computed once, inside SpacetimeDB, so the dashboard, the agents and Brian always say the same figure."
- Hand a judge the QR card: "That's the same room on your phone. It's live."

**0:50 Ask a real question (Driver, tab 3: What-If Studio)**
- Tap **Open a second bakery location**. "Nemotron agents turn that into a scenario and run it month by month… **Tight**: it works, but it leaves them half a month of cushion."
- Tab 4, Agent Trail, open the newest run: "Not a chatbot. You see the plan, every tool call, the model that answered, and this line: every figure was checked against their real data before anyone saw it."

**1:25 "Or just call Brian" (Caller, phone on speaker)**
1. Dial **+1 (844) 468-1795**. Brian says he's an AI, then asks for the family code. Type it.
2. Ask: **"How are we doing?"** (a short answer with real numbers).
3. Ask: **"Add a chore for Mateo: feed the dog, five dollars."** Brian asks "want me to do that?". Say **"Yes."**
4. Driver flips to **tab 2, Kids & Teens**: the chore appears live on the laptop *and* on the judge's phone.
   > "That's SpacetimeDB: one write, every screen in the room updates."
5. Caller: "Thanks Brian, bye." Hang up.

**2:15 The 15-second gap (Driver fills it while the phone stays face up)**
> "While we wait: Brian hears you through Nemotron speech recognition, and thinks with Nemotron 3.5 Lightning that we
> self-host on an NVIDIA L40S through Brev, so he's fast. The agent team runs on Nemotron 3 Ultra. And he only
> calls back when something is actually wrong…"

**2:30 The callback (Caller)**
- The phone rings: **"Brian"**. Answer on speaker. He says it's him again, from the app (not your bank), with a critical alert.
- Ask: **"What's the alert about?"** He explains it.
- "Thanks Brian." Hang up.

**2:50 Close (Driver)**
> "One live room for the whole family, agents that check their own math, and a voice you can just call.
> That's Brianotron." *(Then: "Happy to go deeper on any part.")*

## 30-second deep dives (pick by judge)

**PNC: 360° Financial Health Navigator**
- Dashboard → the health card: eight indicators (cushion, debt-to-income, utilization, savings rate…), each in one plain sentence.
- Credit: a simulated score per family member, and how the household's health feeds it.
- "It's built for families, not one person on one screen. Table Mode turns a dinner-table conversation into goal cards, each checked against the real balances."

**NVIDIA: Nemotron beyond a chatbot**
- Agent Trail: "Most runs start without a chat message: a bank sync, the end of a Table Mode session, a family vote."
- "Ultra plans and calls 26 tools. Lightning does the fast steps, and runs Brian on our own L40S in NVFP4. Every trace row names the model and provider."
- "A grounding check rejects any dollar figure that isn't in the tool results, so it can't invent numbers."

**SpacetimeDB**
- "The whole backend is one TypeScript module: tables, reducers as the API, the agent job queue, presence, and the health and forecast math as scheduled reducers. No other database, no REST API for data."
- "The worker is just another client: it claims a job row atomically and writes every step back as a row, which is why the Agent Trail streams live."
- Show it: Caller adds a chore or casts a vote on the phone, and the judge's phone updates.

## Likely questions, short answers

- **Is it always listening?** No. Table Mode is opt-in per session, with named consent and a recording indicator, and the transcript is deleted after the goals are pulled out.
- **Real data?** No. Synthetic families plus Plaid Sandbox. No real customer data anywhere.
- **Hallucinations?** Every dollar figure in an answer is checked in code against the tool results; unbacked figures get rewritten. The trace shows "N of N figures match".
- **Can Brian move money?** No. He can only change things inside the app (chores, goals, what-ifs), and only after a spoken yes, enforced in code. He never asks for codes, PINs or money.
- **Why call back?** Because the people who most need a heads-up often never open an app. It's only for critical alerts, at most once per call.
- **Cost?** One t3.medium (about $1.15 a day) plus the Brev GPU (about $2.20 an hour). Every merge auto-deploys in a minute.
- **What's next?** Row-level security per family, real bank connections after a security review, and handoff from Brian to a human advisor.

## If something breaks

- **An agent is slow:** say "this runs live on Nemotron" and keep talking. Questions we rehearsed replay instantly from cache.
- **No callback within 30 s:** "our phone provider throttled us this morning", then show the dashboard alert, or the callback scene in the video.
- **Brian doesn't answer:** use the **Talk** button in the app (same Brian, in the browser).
- **Wi-Fi drops:** laptop and phone on a phone hotspot.

## Timeline

- **11:30** Code freeze. Nothing merges to main after this.
- **12:15** Reset (Ben + Claude): pause auto-deploy, reset the Rivera room, run the health check, pre-run the demo questions so they replay instantly.
- **12:30** Full run-through once at the table, with a real call and callback.
- **12:50** Reset the Rivera room again (clears the rehearsal chore), then hands off.
