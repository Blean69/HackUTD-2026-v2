# Scope, timeline, owners

## Clock (CST)
| When | Milestone |
|---|---|
| Sat 3:30 PM | Module published locally, bindings generated, seed loaded, web reads real tables |
| Sat 5:00 PM | Huddle → worker → goals loop works end-to-end on one laptop (local provider OK) |
| **Sat 8:00 PM** | **First live deploy: DB on Maincloud, web + worker on AWS, HTTPS, QR.** Redeploy often after this |
| **Sat 11:00 PM** | **Initial Devpost deadline**: title, tagline, track selections, repo link |
| Sat 11 PM – Sun 6 AM | P1 features; sleep in shifts (never leave the deploy without an owner) |
| Sun 6 – 10 AM | Feature freeze at 8. Demo hardening, cache warm-up, backup video, **make the repo public** |
| **Sun 12:00 PM** | **Final Devpost deadline** |
| Sun 1 – 4 PM | Judging |

## P0: must exist to demo (by 8 PM)
- Landing, display name, join the shared Rivera room or create a private sandbox; presence chips
- Room: accounts by type, ≥4 health indicators and the forecast (computed by reducers), alerts
- Huddle: start → live shared transcript (browser speech, sample, or typed) → end → huddle workflow → goal cards on every phone
- Worker: claims jobs, runs Nemotron (NVIDIA API) with ≥3 tools, emits trace events; keyless `local` fallback
- `/agents` live wall with model/provider badges
- Deployed behind HTTPS with a QR code

## P1: makes it win (overnight)
- What-if simulator + coach with visible tool calls
- Scam Shield (Nguyen story) + transaction anomaly classifier (data_quality workflow on sandbox creation)
- NVIDIA ASR via `POST /asr` (browser speech stays the fallback)
- Self-hosted Nemotron on tenvor.io as live failover with a visible badge switch
- External tools: FRED rates, College Scorecard
- `/advisor` console with live advisor notes
- `cache_first` replay mode, then pre-warm
- Row-level security so a sandbox is visible only to the people in it

## P2: only if ahead
- TTS read-back of the plan (NVIDIA Magpie)
- Goal progress that updates as new transactions stream in (a scheduled reducer simulates paydays)
- ScrabbleBot side quest (10:45 PM)

## Owners (fill in names)
| Lane | Owns | Track |
|---|---|---|
| A | Room UI, Huddle UX, voice, what-if, coach UI | PNC |
| B | SpacetimeDB module, reducers, multiplayer, advisor console, Maincloud deploy | Spacetime |
| C | Agent worker, Nemotron providers, tenvor failover, `/agents`, AWS deploy | NVIDIA |
| D | Data, anomaly + scam detectors, Devpost writeup, pitch, backup video | all |

## Explicitly out of scope
Real bank connections, real auth beyond SpacetimeDB identities, real PII, always-on listening, native apps, commercial lending (Goldman track dropped).
