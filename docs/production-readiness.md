# Production readiness roadmap

Today Keystone/Brianotron is a strong demo on synthetic data. This is what has to change before real families and real bank
data. Each item is a checkbox; the evidence behind most of them is in `docs/stress-test-2026-11-08.md`. Hard rules in
`AGENTS.md` still apply (Spacetime is the only state, Nemotron is primary, every agent step is traced, no secrets in git).

Suggested order: **1 and 2 first, then the CI gates in 5**, because those stop regressions while the rest is built.

## 1. Identity and authorization

- [ ] Real sign-in (OIDC with passkeys). A membership table maps `caller -> household -> role`; every reducer checks it.
- [ ] Roles: parents approve chores and see everything, teens see their own data, guests are read-only.
- [ ] SpacetimeDB views so a client only subscribes to its own household's rows (today every table is public, including
      transcripts, chat and phone codes).
- [ ] Remove the public dev worker secret fallback; give the worker a service identity; secrets in a manager, not env files.
- [ ] Phone PINs (**after the hackathon**: the demo does not depend on them being strong): no "code already taken" oracle,
      per-identity and global failed-attempt budgets, empty caller id treated as one bucket.
- [ ] Authenticate the browser voice call (short-lived signed token, per-IP cap, pre-PIN deadline, CORS limited to our origin).

## 2. Safety of the money-adjacent AI

- [ ] Make the guards measurable: run the red-team pack (`services/voice/evals/run_redteam.py --runs 3`) against the real Nemotron
      model on every prompt change and track a pass rate over time. Run the advice-guard rule tests in CI.
- [ ] Add the missing safety nets: a crisis reply (988 plus a debt-counseling pointer) in the coach and the voice prompt; scam
      detection that catches the textbook story (wire, secrecy, urgency, Zelle/Venmo, Spanish and Vietnamese) and stops crying
      wolf on ordinary talk; a "not advice" disclaimer wherever advice appears.
- [ ] Keep a human path: a "talk to an advisor" handoff, and a log of what Brian said, for audit.

## 3. Data and compliance

Today everything is synthetic. Before real accounts:

- [ ] Bank-grade handling (GLBA and CCPA basics): encryption at rest for tokens, least-privilege access, a documented retention policy.
- [ ] Delete call transcripts and traces on a schedule, not just Table Mode transcripts.
- [ ] Explicit, recorded consent for voice (rule 6 already supports this), and say plainly what is stored.
- [ ] Real bank connections through Plaid production, with token rotation and a revocation flow.

## 4. Reliability

- [ ] Every job gets a deadline, retries with backoff and a dead-letter state, so a crashed worker cannot strand work
      (phone runs stuck as `running` are a live example).
- [ ] Only trip a provider's cooldown on network or server errors, never on one bad request.
- [ ] Graceful degradation with honest messages ("the AI is busy"), not developer text.
- [ ] Run two worker replicas. Back up the SpacetimeDB volume off the box.

## 5. Operations

- [ ] Separate staging from production, with CI gates (typecheck, lint, all test suites, the red-team) before deploy. Today every
      push to `main` ships to prod within a minute.
- [ ] Build images in CI, not on the live 4 GiB box.
- [ ] Metrics, alerts and an SLO: voice latency, job queue age, error rate, LLM cost per household.
- [ ] Per-user and per-IP rate limits, and spend caps on the NVIDIA key.

## 6. Product trust

- [ ] Money math in one shared library, so web, module and worker cannot disagree.
- [ ] Handle missing data explicitly ("not enough data") instead of showing "good".
- [ ] Accessibility and mobile polish as a release gate.
