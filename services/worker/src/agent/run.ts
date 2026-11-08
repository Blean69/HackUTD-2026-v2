// RunContext: one workflow run. Owns trace sequencing, provider bookkeeping, tool execution with trace events,
// and the list of effects (results written to the DB) so a cached run can be replayed later.
import type { LLMLike } from '../llm/client.js';
import type { ChatRequest, ChatResult } from '../llm/types.js';
import type { ToolContext, ToolOutcome, ToolRegistry } from '../tools/registry.js';
import type { HouseholdData } from '../types.js';
import { fitJson, slug, truncate } from '../util.js';
import type { AlertInput, GoalInput, ProposalInput, TraceType, WorkerSink } from './sink.js';

/** Goals and alerts are identified by a household-independent `key`; the DB id is derived per household when applied. */
export type GoalDraft = Omit<GoalInput, 'household_id' | 'id'> & { key: string; /** Update this existing goal row instead of deriving `goal_<household>_<key>` (onboarding goals are created by the module). */ id?: string };
export type AlertDraft = Omit<AlertInput, 'household_id' | 'id'> & { key: string };

export type Effect =
  | { kind: 'goal'; goal: GoalDraft }
  | { kind: 'alert'; alert: AlertDraft }
  | { kind: 'scenario'; status: 'queued' | 'running' | 'done' | 'error'; result_json: string }
  | { kind: 'coach_reply'; text: string }
  | { kind: 'proposal'; verdict: string; analysis_json: string }
  | { kind: 'huddle_done' };

export interface TraceMeta {
  model?: string;
  provider?: string;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface RunInfo {
  runId: string;
  workflow: string;
  householdId: string;
  subjectId: string;
}

export interface RunDeps {
  sink: WorkerSink;
  llm: LLMLike;
  registry: ToolRegistry;
  toolContext: ToolContext;
  /** Provider/model the run is expected to start on (shown on run_started). */
  primary: { provider: string; model: string };
  /** Enable model reasoning in tool-using loop steps. */
  agentThinking?: boolean;
  maxAgentSteps?: number;
}

export class RunContext {
  seq = 0;
  readonly effects: Effect[] = [];
  readonly providerUse = new Map<string, { provider: string; model: string; calls: number; tokens_in: number; tokens_out: number }>();
  /** Provider/model of the most recent LLM answer; non-LLM steps inherit it so every event names who is driving. */
  last: { provider: string; model: string };
  private pending: Promise<unknown>[] = [];
  private sinkErrors: string[] = [];

  constructor(
    readonly info: RunInfo,
    readonly deps: RunDeps,
  ) {
    this.last = { ...deps.primary };
  }

  get data(): HouseholdData {
    return this.deps.toolContext.data;
  }
  get llm(): LLMLike {
    return this.deps.llm;
  }
  get registry(): ToolRegistry {
    return this.deps.registry;
  }

  /** Emit one trace event. Fire-and-forget (ordered by call order); `drain()` waits for all of them. */
  emit(agent: string, type: TraceType, title: string, data: unknown = {}, meta: TraceMeta = {}): void {
    const ev = {
      runId: this.info.runId,
      seq: this.seq++,
      workflow: this.info.workflow,
      agent,
      type,
      title: truncate(title.replace(/\s+/g, ' ').trim(), 280),
      dataJson: fitJson(data, 3800),
      model: meta.model ?? this.last.model,
      provider: meta.provider ?? this.last.provider,
      latencyMs: Math.max(0, Math.round(meta.latencyMs ?? 0)),
      tokensIn: Math.max(0, Math.round(meta.tokensIn ?? 0)),
      tokensOut: Math.max(0, Math.round(meta.tokensOut ?? 0)),
    };
    this.track(this.deps.sink.emitTrace(ev));
  }

  /** Track a sink promise so failures are logged, never unhandled, and `drain()` can wait for them. */
  track<T>(p: Promise<T>): Promise<T | undefined> {
    const safe = p.catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      this.sinkErrors.push(msg);
      console.warn(`[run ${this.info.runId}] sink call failed: ${msg}`);
      return undefined;
    });
    this.pending.push(safe);
    return safe;
  }

  async drain(): Promise<string[]> {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      await Promise.all(batch);
    }
    return this.sinkErrors;
  }

  noteLlm(res: ChatResult): void {
    this.last = { provider: res.provider, model: res.model };
    const key = `${res.provider}|${res.model}`;
    const u = this.providerUse.get(key) ?? { provider: res.provider, model: res.model, calls: 0, tokens_in: 0, tokens_out: 0 };
    u.calls++;
    u.tokens_in += res.tokensIn;
    u.tokens_out += res.tokensOut;
    this.providerUse.set(key, u);
  }

  /** One LLM call. Records usage and surfaces model reasoning as a short `thought` event. */
  async chat(agent: string, req: ChatRequest, opts: { thoughtTitle?: string } = {}): Promise<ChatResult> {
    const res = await this.deps.llm.chat(req);
    this.noteLlm(res);
    if (res.failovers?.length) {
      this.emit(agent, 'message', `Switched provider after ${res.failovers.map((f) => `${f.provider}: ${truncate(f.error, 80)}`).join('; ')}`, { failovers: res.failovers }, { provider: res.provider, model: res.model });
    }
    if (res.modelSwitch?.length) {
      const m = res.modelSwitch[0]!;
      this.emit(agent, 'message', `Model ${m.from} is not available for this API key (${m.reason}); answered by ${res.model}`, { switched: res.modelSwitch }, { provider: res.provider, model: res.model });
    }
    if (res.reasoning) {
      const first = res.reasoning.split(/(?<=[.!?])\s/)[0] ?? res.reasoning;
      this.emit(agent, 'thought', `${opts.thoughtTitle ?? 'Thinking'}: ${truncate(first, 160)}`, { reasoning: truncate(res.reasoning, 1800) }, meta(res));
    }
    return res;
  }

  /** Run a registered tool, emitting tool_call and tool_result. Never throws; returns the outcome. */
  async tool(agent: string, name: string, args: unknown, via?: ChatResult): Promise<ToolOutcome> {
    const m = via ? meta(via) : {};
    this.emit(agent, 'tool_call', this.registry.describeCall(name, args), { tool: name, args }, m);
    const out = await this.registry.execute(name, args, this.deps.toolContext);
    if (out.ok) this.emit(agent, 'tool_result', out.summary, { tool: name, ok: true, result: out.result, ...(out.adjusted ? { adjusted_args: out.adjusted } : {}) }, { ...m, latencyMs: out.durationMs, tokensIn: 0, tokensOut: 0 });
    else this.emit(agent, 'tool_result', `${name.replace(/_/g, ' ')} did not work: ${truncate(out.error, 160)}`, { tool: name, ok: false, error: out.error }, { ...m, latencyMs: out.durationMs, tokensIn: 0, tokensOut: 0 });
    return out;
  }

  /** Open a proposal for the family to vote on (create_proposal as the worker). Not replayed from the cache. */
  proposeToFamily(p: Omit<ProposalInput, 'household_id'>): void {
    this.track(this.deps.sink.createProposal({ ...p, household_id: this.info.householdId }));
  }

  handoff(from: string, to: string, title: string, data: unknown = {}): void {
    this.emit(from, 'handoff', title, { from, to, ...(data as object) });
  }

  providersJson(): string {
    return JSON.stringify([...this.providerUse.values()]);
  }

  // ---- results (each is recorded as an Effect so a cached run can re-apply it) -------------------------------------
  /** Stable per household + key, so re-running a huddle updates goals instead of duplicating them. */
  goalId(key: string): string {
    return `goal_${slug(this.info.householdId.replace(/^hh_/, ''), 24)}_${slug(key, 40)}`;
  }
  alertId(key: string): string {
    return `agent:${slug(this.info.householdId, 30)}:${slug(key, 50)}`;
  }
  goal(g: GoalDraft): void {
    this.effects.push({ kind: 'goal', goal: g });
    const { key, id, ...rest } = g;
    this.track(this.deps.sink.upsertGoal({ ...rest, id: id ?? this.goalId(key), household_id: this.info.householdId }));
  }
  alert(a: AlertDraft): void {
    this.effects.push({ kind: 'alert', alert: a });
    const { key, ...rest } = a;
    this.track(this.deps.sink.createAlert({ ...rest, id: this.alertId(key), household_id: this.info.householdId }));
  }
  scenario(status: 'queued' | 'running' | 'done' | 'error', resultJson: string): void {
    this.effects.push({ kind: 'scenario', status, result_json: resultJson });
    this.track(this.deps.sink.updateScenario(this.info.subjectId, status, resultJson));
  }
  /** Family voting: write the verdict + analysis onto the proposal this run is about (subjectId), citing this run. */
  proposal(verdict: string, analysisJson: string): void {
    this.effects.push({ kind: 'proposal', verdict, analysis_json: analysisJson });
    this.track(this.deps.sink.updateProposal(this.info.subjectId, verdict, analysisJson, this.info.runId));
  }
  coachReply(text: string): void {
    this.effects.push({ kind: 'coach_reply', text });
    this.track(this.deps.sink.coachReply(this.info.householdId, text, this.info.runId));
  }
  huddleDone(): void {
    this.effects.push({ kind: 'huddle_done' });
    this.track(this.deps.sink.setHuddleStatus(this.info.subjectId, 'done'));
    this.track(this.deps.sink.purgeTranscript(this.info.subjectId));
  }
}

export function meta(res: ChatResult): TraceMeta {
  return { model: res.model, provider: res.provider, latencyMs: res.latencyMs, tokensIn: res.tokensIn, tokensOut: res.tokensOut };
}

/** Re-apply recorded effects for a (replayed) run. Keeps household/subject ids of the NEW run. */
export function applyEffects(run: RunContext, effects: Effect[]): void {
  for (const e of effects) {
    switch (e.kind) {
      case 'goal':
        run.goal(e.goal);
        break;
      case 'alert':
        run.alert(e.alert);
        break;
      case 'scenario':
        run.scenario(e.status, e.result_json);
        break;
      case 'coach_reply':
        run.coachReply(e.text);
        break;
      case 'proposal':
        run.proposal(e.verdict, e.analysis_json);
        break;
      case 'huddle_done':
        run.huddleDone();
        break;
    }
  }
}
