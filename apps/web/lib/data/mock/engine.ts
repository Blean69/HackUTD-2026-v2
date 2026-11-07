/**
 * Mock backend: an in-browser stand-in for the SpacetimeDB module + the Nemotron worker.
 *
 * It implements the same `Backend` interface as the real adapter and writes into the same `store`, so every
 * component works unchanged in both modes. To make multiplayer feel real without a server it also simulates other
 * people (presence, an advisor note) and other judges' agent runs on the /agents wall.
 */
import type { Actions, Backend } from "../backend";
import type { DataStore } from "../store";
import { usd } from "@/lib/format";
import type {
  Alert, Goal, Huddle, Presence, PresenceRole, Proposal, TraceEvent, TranscriptLine, Workflow,
} from "@/lib/types";
import { computeForecast, computeHealth, type MathCtx } from "./math";
import { createLocalProposalActions, seedProposals } from "./proposals";
import { buildSeed, type SeedHousehold } from "./seed";
import { buildTxns } from "./txns";
import type { SimCtx } from "./sim";
import { ambientScript, coachScript, dataQualityScript, huddleScript, plaidSyncScript, whatIfScript, type Effects, type Step } from "./scripts";

const rid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
const iso = () => new Date().toISOString();

const AMBIENT_HOUSEHOLDS = ["hh_okafor", "hh_nguyen", "hh_patel", "hh_brooks"];
const AMBIENT_WORKFLOWS: Workflow[] = ["huddle", "what_if", "coach", "scam_check", "data_quality"];

export function startMockBackend(store: DataStore): Backend {
  const engine = new MockEngine(store);
  engine.start();
  return {
    kind: "mock",
    identity: engine.me,
    actions: engine.actions,
    dispose: () => engine.stop(),
  };
}

class MockEngine {
  readonly me = rid("me");
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private intervals = new Set<ReturnType<typeof setInterval>>();
  private eventId = 0;
  private lineId = 0;
  private msgId = 0;
  private noteId = 0;
  private jobId = 0;
  private varSpend = new Map<string, number>();
  private nwTrend = new Map<string, number>();
  private peersFor = new Set<string>();
  private myHousehold = "";
  private stopped = false;

  constructor(private store: DataStore) {}

  // ------------------------------------------------------------------------------------------ lifecycle

  start(): void {
    const now = new Date();
    const seeds = buildSeed(now);
    for (const s of seeds) this.load(s, now);
    const sp = seedProposals(now, seeds.map((s) => s.household.id));
    this.store.upsertMany("proposal", sp.proposals);
    this.store.upsertMany("vote", sp.votes);
    this.seedHistory(now);
    this.every(17000, () => this.ambientRun());
    this.after(6000, () => this.ambientRun());
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const i of this.intervals) clearInterval(i);
    this.timers.clear();
    this.intervals.clear();
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(t);
  }
  private every(ms: number, fn: () => void): void {
    this.intervals.add(setInterval(() => !this.stopped && fn(), ms));
  }

  private load(s: SeedHousehold, now: Date): void {
    const st = this.store;
    st.upsert("household", s.household);
    st.upsertMany("member", s.members);
    st.upsertMany("account", s.accounts);
    st.upsertMany("obligation", s.obligations);
    st.upsertMany("credit_profile", s.credit);
    st.upsertMany("txn", buildTxns(s, now));
    st.upsertMany("conversation", s.conversations);
    st.upsertMany("alert", s.alerts);
    st.upsertMany("goal", s.goals);
    if (s.banks) st.upsertMany("bank_connection", s.banks);
    this.varSpend.set(s.household.id, s.varSpend);
    this.nwTrend.set(s.household.id, s.nwTrend);
    this.recompute(s.household.id, now);
  }

  /** Stand-in for the `recompute_household` reducer. */
  private recompute(hid: string, now = new Date()): void {
    const st = this.store;
    const m: MathCtx = {
      accounts: st.rows("account").filter((a) => a.household_id === hid),
      members: st.rows("member").filter((x) => x.household_id === hid),
      obligations: st.rows("obligation").filter((o) => o.household_id === hid),
      varSpend: this.varSpend.get(hid) ?? 4000,
      nwTrend: this.nwTrend.get(hid) ?? 0,
    };
    st.upsertMany("health_indicator", computeHealth(hid, m, now.toISOString()));
    st.removeWhere("forecast_point", (p) => p.household_id === hid);
    st.upsertMany("forecast_point", computeForecast(hid, m, now));
  }

  private ctx(hid: string): SimCtx {
    const st = this.store;
    return {
      hid,
      accounts: st.rows("account").filter((a) => a.household_id === hid),
      members: st.rows("member").filter((m) => m.household_id === hid),
      obligations: st.rows("obligation").filter((o) => o.household_id === hid),
      health: st.rows("health_indicator").filter((h) => h.household_id === hid),
      forecast: st.rows("forecast_point").filter((p) => p.household_id === hid).sort((a, b) => a.date.localeCompare(b.date)),
      alerts: st.rows("alert").filter((a) => a.household_id === hid),
      goals: st.rows("goal").filter((g) => g.household_id === hid),
      varSpend: this.varSpend.get(hid) ?? 4000,
      now: new Date(),
    };
  }

  // ------------------------------------------------------------------------------------------ runs

  /** Plays Steps back as trace_event rows with their `wait` delays. Returns the run id immediately. */
  private playRun(workflow: Workflow, hid: string, steps: Step[], opts: { instantUntil?: number } = {}): string {
    const runId = rid("run");
    const jobId = ++this.jobId;
    const providers = new Set<string>();
    this.store.upsert("agent_run", { run_id: runId, job_id: jobId, workflow, household_id: hid, status: "running", started_at: iso(), providers: [] });
    let t = 0;
    steps.forEach((step, i) => {
      t += i < (opts.instantUntil ?? 0) ? 0 : step.wait;
      this.after(t, () => {
        const ev: TraceEvent = {
          id: ++this.eventId, run_id: runId, household_id: hid, seq: i + 1, ts: iso(), workflow, agent: step.agent, type: step.type,
          title: step.title, data: step.data, model: step.model, provider: step.provider, latency_ms: step.latency_ms, tokens: step.tokens,
        };
        this.store.upsert("trace_event", ev);
        if (step.provider) providers.add(step.provider === "nvidia" ? "nvidia" : step.provider);
        step.effect?.();
        if (i === steps.length - 1) {
          this.store.patch("agent_run", runId, { status: "done", finished_at: iso(), providers: [...providers] });
        } else if (i === 0) {
          this.store.patch("agent_run", runId, { providers: [...providers] });
        }
      });
    });
    return runId;
  }

  private effects(hid: string, hooks: Partial<Effects> = {}): Effects {
    const st = this.store;
    return {
      upsertGoal: (g: Goal) => st.upsert("goal", g),
      addAlert: (a) => {
        const alert: Alert = { id: rid("alert"), household_id: hid, severity: a.severity, kind: a.kind, title: a.title, detail: a.detail, related_ids: [], created_at: iso(), acknowledged_by: "" };
        st.upsert("alert", alert);
      },
      purgeAndFinish: () => {},
      setScenario: () => {},
      coachReply: () => {},
      ...hooks,
    };
  }

  /** A few finished runs so /agents is never empty on first paint. */
  private seedHistory(now: Date): void {
    const plan: [Workflow, string, boolean, number][] = [
      ["huddle", "hh_okafor", true, 14], ["what_if", "hh_brooks", false, 11], ["scam_check", "hh_nguyen", false, 8],
      ["coach", "hh_patel", true, 6], ["data_quality", "hh_patel", false, 4], ["phone", "hh_rivera", false, 3], ["huddle", "hh_brooks", false, 2],
    ];
    for (const [wf, hid, cached, minsAgo] of plan) this.seedRun(wf, hid, cached, minsAgo, now);
    // Each seeded proposal's verdict links to a finished affordability run, like the live module's.
    for (const p of this.store.rows("proposal").filter((x) => x.verdict && !x.run_id)) {
      this.store.patch("proposal", p.id, { run_id: this.seedRun("what_if", p.household_id, false, 20 + (p.id.length % 7), now) });
    }
  }

  /** One finished run, back-dated. Returns its run id. */
  private seedRun(wf: Workflow, hid: string, cached: boolean, minsAgo: number, now: Date): string {
    const steps = ambientScript(wf, cached);
    const runId = rid("run");
    const start = new Date(now.getTime() - minsAgo * 60000);
    let t = start.getTime();
    const providers = new Set<string>();
    steps.forEach((s, i) => {
      t += s.wait * 1.6;
      if (s.provider) providers.add(s.provider);
      this.store.upsert("trace_event", { id: ++this.eventId, run_id: runId, household_id: hid, seq: i + 1, ts: new Date(t).toISOString(), workflow: wf, agent: s.agent, type: s.type, title: s.title, data: s.data, model: s.model, provider: s.provider, latency_ms: s.latency_ms, tokens: s.tokens });
    });
    this.store.upsert("agent_run", { run_id: runId, job_id: ++this.jobId, workflow: wf, household_id: hid, status: "done", started_at: start.toISOString(), finished_at: new Date(t).toISOString(), providers: [...providers] });
    return runId;
  }

  private ambientRun(): void {
    const wf = AMBIENT_WORKFLOWS[Math.floor(Math.random() * AMBIENT_WORKFLOWS.length)];
    const hid = AMBIENT_HOUSEHOLDS[Math.floor(Math.random() * AMBIENT_HOUSEHOLDS.length)];
    this.playRun(wf, hid, ambientScript(wf, Math.random() < 0.2));
  }

  private proposals() {
    return createLocalProposalActions(this.store, () => this.me, (p) => this.runProposalAgent(p));
  }

  /** Stand-in for the worker's affordability check: a scripted what_if run whose result lands on the proposal. */
  private runProposalAgent(p: Proposal): void {
    const d = p.details;
    const terms = [d.down_pct !== undefined ? `${d.down_pct}% down` : "", d.term_months ? `over ${d.term_months} months` : "", d.rate_pct !== undefined ? `at ${d.rate_pct}%` : ""].filter(Boolean).join(" ");
    const prompt = `Buy ${p.title} for ${usd(p.amount)}${terms ? ` ${terms}` : ""}`;
    const fx = this.effects(p.household_id, {
      setScenario: (result) =>
        this.store.patch("proposal", p.id, {
          verdict: result.verdict ?? "fine",
          analysis: { summary: result.summary, suggestion: result.suggestion, metrics: result.metrics, low_point: result.low_point },
        }),
    });
    const runId = this.playRun("what_if", p.household_id, whatIfScript(this.ctx(p.household_id), prompt, p.created_by_name, fx));
    this.store.patch("proposal", p.id, { run_id: runId });
  }

  // ------------------------------------------------------------------------------------------ simulated people

  private seedPeers(hid: string): void {
    if (hid !== "hh_rivera" || this.peersFor.has(hid)) return;
    this.peersFor.add(hid);
    const put = (identity: string, name: string, role: PresenceRole) => {
      const p: Presence = { identity, household_id: hid, display_name: name, role, last_seen: iso() };
      this.store.upsert("presence", p);
    };
    put("peer_marisol", "Marisol", "family");
    this.after(7000, () => put("peer_daniel", "Daniel", "family"));
    this.after(24000, () => put("peer_priya", "Priya (PNC advisor)", "advisor"));
    this.after(41000, () => {
      this.addNote(hid, "Priya (PNC advisor)", "Saw your Visa at 55% utilization. Paying it below 30% could lift your score by about 25 points before you apply for the SBA loan.");
    });
  }

  private addNote(hid: string, author: string, text: string): void {
    const id = ++this.noteId;
    this.store.upsert("advisor_note", { id, household_id: hid, author_name: author, text, created_at: iso() });
    this.store.upsert("alert", { id: rid("alert"), household_id: hid, severity: "info", kind: "advisor", title: `Note from ${author}`, detail: text, related_ids: [], created_at: iso(), acknowledged_by: "" });
  }

  // ------------------------------------------------------------------------------------------ actions

  readonly actions: Actions = {
    joinRoom: async (hid, name, role) => {
      this.myHousehold = hid;
      this.store.upsert("presence", { identity: this.me, household_id: hid, display_name: name, role, last_seen: iso() });
      if (hid) this.seedPeers(hid);
    },

    createSandbox: async (templateId, name) => {
      const st = this.store;
      const tpl = st.get("household", templateId);
      if (!tpl) throw new Error(`Unknown template household ${templateId}`);
      const short = Math.random().toString(36).slice(2, 6);
      const hid = `hh_sbx_${short}`;
      const sfx = `_sbx_${short}`;
      const memberMap = new Map<string, string>();
      const accountMap = new Map<string, string>();
      st.upsert("household", { ...tpl, id: hid, name: `${name}'s private copy of ${tpl.name.replace(/^The /, "the ")}`, template_id: tpl.id, owner: this.me, created_at: iso() });
      for (const m of st.rows("member").filter((x) => x.household_id === tpl.id)) {
        memberMap.set(m.id, m.id + sfx);
        st.upsert("member", { ...m, id: m.id + sfx, household_id: hid });
      }
      for (const a of st.rows("account").filter((x) => x.household_id === tpl.id)) {
        accountMap.set(a.id, a.id + sfx);
        st.upsert("account", { ...a, id: a.id + sfx, household_id: hid, owner_member_ids: a.owner_member_ids.map((i) => memberMap.get(i) ?? i) });
      }
      for (const o of st.rows("obligation").filter((x) => x.household_id === tpl.id)) st.upsert("obligation", { ...o, id: o.id + sfx, household_id: hid, account_id: accountMap.get(o.account_id) ?? o.account_id });
      for (const c of st.rows("credit_profile").filter((x) => x.household_id === tpl.id)) st.upsert("credit_profile", { ...c, member_id: memberMap.get(c.member_id) ?? c.member_id, household_id: hid });
      for (const t of st.rows("txn").filter((x) => x.household_id === tpl.id)) st.upsert("txn", { ...t, id: t.id + sfx, household_id: hid, account_id: accountMap.get(t.account_id) ?? t.account_id });
      for (const p of st.rows("proposal").filter((x) => x.household_id === tpl.id)) {
        st.upsert("proposal", { ...p, id: p.id + sfx, household_id: hid, run_id: "" });
        for (const v of st.rows("vote").filter((x) => x.proposal_id === p.id && memberMap.has(x.voter_key))) {
          const key = memberMap.get(v.voter_key) ?? v.voter_key;
          st.upsert("vote", { ...v, id: `${p.id + sfx}:${key}`, proposal_id: p.id + sfx, household_id: hid, voter_key: key });
        }
      }
      for (const c of st.rows("conversation").filter((x) => x.household_id === tpl.id)) st.upsert("conversation", { ...c, id: c.id + sfx, household_id: hid });
      for (const a of st.rows("alert").filter((x) => x.household_id === tpl.id && x.kind !== "advisor")) st.upsert("alert", { ...a, id: a.id + sfx, household_id: hid, acknowledged_by: "" });
      for (const g of st.rows("goal").filter((x) => x.household_id === tpl.id)) st.upsert("goal", { ...g, id: g.id + sfx, household_id: hid });
      this.varSpend.set(hid, this.varSpend.get(tpl.id) ?? 4000);
      this.nwTrend.set(hid, this.nwTrend.get(tpl.id) ?? 0);
      this.recompute(hid);
      this.playRun("data_quality", hid, dataQualityScript(this.ctx(hid), this.effects(hid), `New sandbox for ${name}`));
      return hid;
    },

    startHuddle: async (hid, consent) => {
      const live = this.store.rows("huddle").find((h) => h.household_id === hid && h.status === "live");
      if (live) return live.id;
      const me = this.store.get("presence", this.me)?.display_name ?? consent[0] ?? "Someone";
      const h: Huddle = { id: rid("hud"), household_id: hid, started_by_name: me, status: "live", started_at: iso(), consent_names: consent };
      this.store.upsert("huddle", h);
      return h.id;
    },

    appendTranscript: async (huddleId, speaker, text) => {
      const h = this.store.get("huddle", huddleId);
      if (!h || h.status !== "live") throw new Error("Table Mode is not live");
      const line: TranscriptLine = { id: ++this.lineId, huddle_id: huddleId, household_id: h.household_id, speaker, text, ts: iso() };
      this.store.upsert("transcript_line", line);
    },

    endHuddle: async (huddleId) => {
      const h = this.store.get("huddle", huddleId);
      if (!h || h.status !== "live") return;
      this.store.patch("huddle", huddleId, { status: "analyzing", ended_at: iso() });
      const lines = this.store.rows("transcript_line").filter((l) => l.huddle_id === huddleId).sort((a, b) => a.id - b.id);
      const fx = this.effects(h.household_id, {
        purgeAndFinish: () => {
          this.store.removeWhere("transcript_line", (l) => l.huddle_id === huddleId);
          this.store.patch("huddle", huddleId, { status: "done" });
        },
      });
      this.playRun("huddle", h.household_id, huddleScript(this.ctx(h.household_id), lines.map((l) => ({ speaker: l.speaker, text: l.text })), fx));
    },

    requestSimulation: async (hid, prompt) => {
      const id = rid("scn");
      const who = this.store.get("presence", this.me)?.display_name ?? "You";
      this.store.upsert("scenario", { id, household_id: hid, prompt, status: "queued", requested_by_name: who, created_at: iso() });
      const fx = this.effects(hid, { setScenario: (result) => this.store.patch("scenario", id, { status: "done", result }) });
      const steps = whatIfScript(this.ctx(hid), prompt, who, fx);
      steps[0].effect = () => this.store.patch("scenario", id, { status: "running" });
      this.playRun("what_if", hid, steps);
      return id;
    },

    askCoach: async (hid, text, author) => {
      this.store.upsert("coach_message", { id: ++this.msgId, household_id: hid, role: "user", author_name: author, text, run_id: "", created_at: iso() });
      let runId = "";
      const fx = this.effects(hid, {
        coachReply: (reply) => this.store.upsert("coach_message", { id: ++this.msgId, household_id: hid, role: "assistant", author_name: "Coach", text: reply, run_id: runId, created_at: iso() }),
      });
      runId = this.playRun("coach", hid, coachScript(this.ctx(hid), text, author, fx));
    },

    ackAlert: async (alertId, name) => {
      this.store.patch("alert", alertId, { acknowledged_by: name });
    },

    postAdvisorNote: async (hid, author, text) => {
      this.addNote(hid, author, text);
    },

    upsertGoal: async (g) => {
      const now = iso();
      const existing = g.id ? this.store.get("goal", g.id) : undefined;
      this.store.upsert("goal", {
        id: g.id ?? rid("goal"), household_id: g.household_id, title: g.title, target_amount: g.target_amount, target_date: g.target_date,
        priority: g.priority ?? "medium", feasibility: g.feasibility ?? "", evidence_quote: g.evidence_quote, source: g.source ?? "manual",
        created_at: existing?.created_at ?? now, updated_at: now,
      });
    },

    deleteGoal: async (id) => {
      this.store.remove("goal", id);
    },

    createProposal: (input) => this.proposals().createProposal(input),
    castVote: (proposalId, choice, voterName) => this.proposals().castVote(proposalId, choice, voterName),
    closeProposal: (proposalId) => this.proposals().closeProposal(proposalId),

    requestBankSync: async (hid) => {
      const conns = this.store.rows("bank_connection").filter((b) => b.household_id === hid);
      for (const b of conns) this.store.patch("bank_connection", b.item_id, { status: "syncing" });
      const name = conns[0]?.institution_name ?? "your bank";
      const steps = plaidSyncScript(this.ctx(hid), name, {
        done: () => {
          for (const b of conns) this.store.patch("bank_connection", b.item_id, { status: "ok", last_synced_at: iso() });
        },
      });
      this.playRun("plaid_sync", hid, steps);
    },
  };
}
