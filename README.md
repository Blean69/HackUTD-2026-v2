# Keystone (codename) · HackUTD 2026

**A family's financial room.** One live, shared space where the whole family and a team of Nemotron agents see the full
financial picture together and plan out loud.

Tracks: **PNC** (360° Financial Health Navigator) · **NVIDIA** (Nemotron beyond a chatbot) · **Spacetime** (main track)

- Family room: accounts, six health indicators, a 90-day forecast, a what-if simulator and a coach, shared live across everyone's phones
- Huddle: the family talks through plans; Nemotron agents turn the conversation into goals and check them against real balances
- Scam Shield + data-quality checks on every household
- Agent glass box: every plan, tool call and model choice, streaming live
- Backend: one SpacetimeDB module. State, job queue, presence and finance math all run inside the database

## Start here
| Doc | What's in it |
|---|---|
| [AGENTS.md](AGENTS.md) | Rules and architecture. Codex and Claude both read this |
| [docs/contracts.md](docs/contracts.md) | Tables, reducers, seed data, trace events (binding) |
| [docs/tracks.md](docs/tracks.md) | What each sponsor asked for and how we answer it |
| [docs/demo-script.md](docs/demo-script.md) | 3-minute demo per judge panel |
| [docs/scope.md](docs/scope.md) | Timeline, P0/P1/P2, owners |
| [docs/nvidia-stack.md](docs/nvidia-stack.md) | Nemotron model ids, ASR, self-hosting on tenvor.io |

Team brainstorm board: *link added after first publish*

## Run it
See [AGENTS.md § Running locally](AGENTS.md#running-locally). Copy `.env.example` to `.env` first.

All data is synthetic. No real customer information is used anywhere.
