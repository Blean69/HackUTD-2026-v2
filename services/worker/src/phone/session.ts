// PhoneService: the live-call sessions behind the /phone/* routes. One call = one traced agent_run (workflow "phone"):
//   enqueue (worker-only reducer) -> claim -> start_run -> run_started / plan / briefing tool calls
//   -> per turn: "Heard" / "Said" messages and the tools the voice model calls (tool_call + tool_result)
//   -> final -> finish_run.
// The job queue never sees these jobs (no WorkflowDef is registered for "phone"), so a call does not take one of its slots.
import { RunContext } from '../agent/run.js';
import type { WorkerSink } from '../agent/sink.js';
import type { LLMLike } from '../llm/client.js';
import type { ProviderId } from '../config.js';
import type { ExternalApis } from '../tools/external.js';
import type { ToolContext, ToolRegistry } from '../tools/registry.js';
import type { HouseholdData } from '../types.js';
import { median, truncate } from '../util.js';
import type { PhoneCodeSource } from './access.js';
import { buildBrief, familyLabel } from './brief.js';
import type { PhoneConfig } from './config.js';
import { PinChecker, type PinResult } from './identity.js';
import { isPhoneTool, PHONE_TOOLS, voiceView } from './voice_view.js';

export class PhoneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail = '',
  ) {
    super(detail || code);
  }
}

export interface PhoneDeps {
  sink: WorkerSink;
  registry: ToolRegistry;
  external: ExternalApis;
  llm: LLMLike & { primary(role?: 'agent' | 'fast'): { provider: string; model: string } };
  loadData(householdId: string): Promise<HouseholdData>;
  /** Queue a job and return its id (the real one calls the agent_enqueue_job reducer and looks the row up in the client cache). */
  enqueueJob(workflow: string, householdId: string, subjectId: string, input: Record<string, unknown>): Promise<bigint>;
  cfg: PhoneConfig;
  /** Household codes set in the app (salted hashes from SpacetimeDB), checked before the env PINs. Optional: without it only PHONE_PINS work. */
  codes?: PhoneCodeSource;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface StartRequest {
  call_id: string;
  household_id: string;
  member_id?: string;
  first_name?: string;
  display_name?: string;
  transport?: string;
  caller?: string;
  llm?: { provider?: string; model?: string };
}

export interface StartResponse {
  run_id: string;
  household_id: string;
  household_name: string;
  family: string;
  first_name: string;
  brief: string[];
  as_of: string;
  resumed?: boolean;
}

export interface TraceItem {
  kind: 'heard' | 'said' | 'note' | 'error';
  text?: string;
  title?: string;
  data?: Record<string, unknown>;
  model?: string;
  provider?: string;
  /** heard: ASR final latency. said: LLM time to first token. */
  asr_ms?: number;
  llm_ms?: number;
  tts_ms?: number;
  v2v_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  interrupted?: boolean;
  tts_voice?: string;
  tts_model?: string;
  tts_provider?: string;
}

interface Session {
  runId: string;
  callId: string;
  householdId: string;
  memberId: string;
  firstName: string;
  family: string;
  transport: string;
  caller: string;
  run: RunContext;
  toolContext: ToolContext;
  startedAt: number;
  lastSeen: number;
  turns: number;
  events: number;
  toolCalls: number;
  toolErrors: number;
  tools: Record<string, number>;
  v2v: number[];
  asr: number[];
  llm: number[];
  tts: number[];
  response: StartResponse;
  ending?: Promise<EndResponse>;
}

export interface EndResponse {
  ok: true;
  run_id: string;
  reason: string;
  turns: number;
  tool_calls: number;
  p50_ms: number | null;
  p95_ms: number | null;
  duration_s: number;
  already?: boolean;
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const rand = (): string => Math.random().toString(36).slice(2, 6);
const clean = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ms = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : 0);

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export class PhoneService {
  private byRun = new Map<string, Session>();
  private byCall = new Map<string, string>();
  private reaper?: NodeJS.Timeout;
  readonly pins: PinChecker;
  private now: () => number;
  private log: (msg: string) => void;

  constructor(private d: PhoneDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((m) => console.log(m));
    this.pins = new PinChecker(d.cfg.pins, d.cfg.pinTries, this.now, undefined, d.codes);
  }

  get activeCalls(): number {
    return this.byRun.size;
  }

  // ---- identify ------------------------------------------------------------------------------------------------------
  async identify(req: { call_id: string; caller_hash?: string; pin: string }): Promise<Record<string, unknown>> {
    if (!SAFE_ID.test(req.call_id ?? '')) throw new PhoneError(400, 'bad_call_id');
    await this.d.codes?.ready?.(); // the household codes load once at startup; after that they stay live
    const r: PinResult = this.pins.check(req.call_id, clean(req.caller_hash, 80), String(req.pin ?? ''));
    // Only the outcome is logged: never the digits, the caller's number or hash, or which household.
    this.log(`[phone] identify call=${req.call_id}: ${r.ok ? `ok (${r.source === 'code' ? 'household code' : 'env PIN'})` : r.locked ? 'wrong, locked' : `wrong, ${r.triesLeft} ${r.triesLeft === 1 ? 'try' : 'tries'} left`}`);
    if (!r.ok) return { ok: false, tries_left: r.triesLeft, locked: r.locked };
    let householdName = '';
    let firstName = '';
    try {
      const data = await this.d.loadData(r.entry.householdId);
      householdName = data.household.name;
      if (r.entry.memberId) firstName = data.members.find((m) => m.id === r.entry.memberId)?.name.split(' ')[0] ?? '';
    } catch {
      return { ok: false, tries_left: 0, locked: false, error: 'household_unavailable' };
    }
    return { ok: true, household_id: r.entry.householdId, member_id: r.entry.memberId, first_name: firstName, household_name: householdName, family: familyLabel(householdName) };
  }

  // ---- start ---------------------------------------------------------------------------------------------------------
  async start(req: StartRequest): Promise<StartResponse> {
    const callId = req.call_id ?? '';
    if (!SAFE_ID.test(callId)) throw new PhoneError(400, 'bad_call_id', 'call_id must be 1-120 chars of [A-Za-z0-9_.:-]');
    const householdId = clean(req.household_id, 80);
    if (!householdId) throw new PhoneError(400, 'household_id_required');

    const existing = this.byCall.get(callId);
    if (existing) {
      const s = this.byRun.get(existing);
      if (s) return { ...s.response, resumed: true };
    }
    if (this.byRun.size >= this.d.cfg.maxSessions) throw new PhoneError(429, 'too_many_calls', `at most ${this.d.cfg.maxSessions} live calls at once`);

    let data: HouseholdData;
    try {
      data = await this.d.loadData(householdId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new PhoneError(/unknown household/i.test(msg) ? 404 : 502, /unknown household/i.test(msg) ? 'unknown_household' : 'load_failed', msg);
    }

    const transport = clean(req.transport, 24) || 'webrtc';
    const caller = clean(req.caller, 16) || 'new';
    const memberId = clean(req.member_id, 80);
    const firstName = clean(req.first_name, 40) || clean(req.display_name, 40).split(' ')[0] || '';
    const family = familyLabel(data.household.name);

    const jobId = await this.d.enqueueJob('phone', householdId, callId, { transport, caller, ...(memberId ? { member_id: memberId } : {}) });
    await this.d.sink.claimJob(jobId);
    const runId = `run_${jobId}_${rand()}`;
    await this.d.sink.startRun(runId, jobId);

    const primary = {
      provider: clean(req.llm?.provider, 24) || this.d.llm.primary('fast').provider,
      model: clean(req.llm?.model, 80) || this.d.llm.primary('fast').model,
    };
    const toolContext: ToolContext = { data, external: this.d.external };
    const run = new RunContext(
      { runId, workflow: 'phone', householdId, subjectId: callId },
      { sink: this.d.sink, llm: this.d.llm, registry: this.d.registry, toolContext, primary: primary as { provider: string; model: string } },
    );

    run.emit('voice_agent', 'run_started', `Voice call connected (${family})`, { call_id: callId, transport, caller, member: firstName || undefined, disclosure_spoken: true, household_id: householdId });
    const steps = ['Read the health indicators (get_health_indicators)', 'Read the 90-day forecast (get_forecast)', 'Read the monthly obligations (get_obligations)', 'Brief the voice model, then answer questions by voice with the same tools'];
    run.emit('voice_agent', 'plan', 'Briefing before the first question', { steps });

    const outs = {
      health: await run.tool('voice_agent', 'get_health_indicators', {}),
      forecast: await run.tool('voice_agent', 'get_forecast', {}),
      obligations: await run.tool('voice_agent', 'get_obligations', {}),
    };
    const brief = buildBrief(data, {
      health: outs.health.ok ? outs.health.result : undefined,
      forecast: outs.forecast.ok ? outs.forecast.result : undefined,
      obligations: outs.obligations.ok ? outs.obligations.result : undefined,
    });

    const response: StartResponse = { run_id: runId, household_id: householdId, household_name: data.household.name, family, first_name: firstName, brief, as_of: data.asOf };
    const now = this.now();
    const session: Session = {
      runId, callId, householdId, memberId, firstName, family, transport, caller, run, toolContext,
      startedAt: now, lastSeen: now, turns: 0, events: 0, toolCalls: 0, toolErrors: 0, tools: {},
      v2v: [], asr: [], llm: [], tts: [], response,
    };
    this.byRun.set(runId, session);
    this.byCall.set(callId, runId);
    this.log(`[phone] call ${callId} started: run ${runId} (${family}, ${transport}); ${this.byRun.size} live`);
    return response;
  }

  // ---- tools ---------------------------------------------------------------------------------------------------------
  tools(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    const specs = this.d.registry.specs([...PHONE_TOOLS]);
    // keep the declared order, and drop the knobs a 3B-active model does not need to see
    return PHONE_TOOLS.map((n) => specs.find((s) => s.name === n)).filter((s): s is NonNullable<typeof s> => Boolean(s)).map((s) => ({ name: s.name, description: s.description, parameters: slimParameters(s.name, s.parameters) }));
  }

  private session(runId: string): Session {
    const s = this.byRun.get(runId ?? '');
    if (!s) throw new PhoneError(404, 'unknown_run', 'no live call with that run_id (ended, reaped, or never started)');
    s.lastSeen = this.now();
    return s;
  }

  async tool(req: { run_id: string; name: string; args?: unknown }): Promise<Record<string, unknown>> {
    const s = this.session(req.run_id);
    if (!isPhoneTool(req.name)) throw new PhoneError(400, 'tool_not_allowed', `"${req.name}" is not a phone tool`);
    if (JSON.stringify(req.args ?? {}).length > 4096) throw new PhoneError(413, 'args_too_large');
    try {
      s.toolContext.data = await this.d.loadData(s.householdId); // the household's live cache, so a long call sees fresh numbers
    } catch {
      /* keep the data the call started with */
    }
    const out = await s.run.tool('voice_agent', req.name, req.args ?? {});
    s.toolCalls++;
    s.tools[req.name] = (s.tools[req.name] ?? 0) + 1;
    if (!out.ok) {
      s.toolErrors++;
      return { ok: false, error: out.error, ms: out.durationMs };
    }
    const view = voiceView(req.name, out.result);
    const result = view && typeof view === 'object' && !Array.isArray(view) ? { ...(view as object), reply_hint: REPLY_HINT } : view;
    return { ok: true, result, summary: out.summary, ms: out.durationMs };
  }

  // ---- trace ---------------------------------------------------------------------------------------------------------
  trace(req: { run_id: string; events: TraceItem[] }): { ok: true; accepted: number; dropped: number } {
    const s = this.session(req.run_id);
    const items = Array.isArray(req.events) ? req.events.slice(0, 50) : [];
    let accepted = 0;
    for (const e of items) {
      if (s.events >= this.d.cfg.maxEventsPerRun) break;
      if (this.record(s, e)) {
        s.events++;
        accepted++;
      }
    }
    return { ok: true, accepted, dropped: items.length - accepted };
  }

  private record(s: Session, e: TraceItem): boolean {
    const run = s.run;
    const provider = (clean(e.provider, 24) || 'nvidia') as ProviderId;
    switch (e?.kind) {
      case 'heard': {
        const text = clean(e.text, 400);
        if (!text) return false;
        s.turns++;
        if (ms(e.asr_ms)) s.asr.push(ms(e.asr_ms));
        run.emit('voice_agent', 'message', `Heard: “${truncate(text, 160)}”`, { text, asr_final_ms: ms(e.asr_ms), asr: 'nemotron-asr-streaming', turn: s.turns }, { model: clean(e.model, 80) || 'nemotron-asr-streaming', provider, latencyMs: ms(e.asr_ms) });
        return true;
      }
      case 'said': {
        const text = clean(e.text, 800);
        if (!text) return false;
        const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
        if (ms(e.v2v_ms)) s.v2v.push(ms(e.v2v_ms));
        if (ms(e.asr_ms)) s.asr.push(ms(e.asr_ms)); // the speech-to-text final that started this answer
        if (ms(e.llm_ms)) s.llm.push(ms(e.llm_ms));
        if (ms(e.tts_ms)) s.tts.push(ms(e.tts_ms));
        const model = clean(e.model, 80) || s.run.last.model;
        if (ms(e.tokens_in) || ms(e.tokens_out) || ms(e.llm_ms)) {
          run.noteLlm({ content: '', toolCalls: [], provider, model, latencyMs: ms(e.llm_ms), tokensIn: ms(e.tokens_in), tokensOut: ms(e.tokens_out) });
        }
        run.emit(
          'voice_agent',
          'message',
          `Said: “${truncate(first, 160)}”${e.interrupted ? ' (caller interrupted)' : ''}`,
          { text, asr_final_ms: ms(e.asr_ms), llm_first_token_ms: ms(e.llm_ms), tts_first_audio_ms: ms(e.tts_ms), voice_to_voice_ms: ms(e.v2v_ms), tts: { model: clean(e.tts_model, 80) || 'magpie-tts-multilingual', provider: clean(e.tts_provider, 40) || 'magpie', voice: clean(e.tts_voice, 80) }, interrupted: Boolean(e.interrupted), turn: s.turns },
          { model, provider, latencyMs: ms(e.llm_ms), tokensIn: ms(e.tokens_in), tokensOut: ms(e.tokens_out) },
        );
        return true;
      }
      case 'note': {
        const title = clean(e.title ?? e.text, 200);
        if (!title) return false;
        run.emit('voice_agent', 'message', title, e.data && typeof e.data === 'object' ? e.data : {}, { provider });
        return true;
      }
      case 'error': {
        const title = clean(e.title ?? e.text, 200);
        if (!title) return false;
        run.emit('voice_agent', 'error', title, e.data && typeof e.data === 'object' ? e.data : {}, { provider });
        return true;
      }
      default:
        return false;
    }
  }

  // ---- end -----------------------------------------------------------------------------------------------------------
  async end(req: { run_id: string; reason?: string; stats?: Record<string, unknown> }): Promise<EndResponse> {
    const s = this.byRun.get(req.run_id ?? '');
    if (!s) {
      // idempotent: a second end (hang-up + disconnect handlers both firing) is not an error
      return { ok: true, run_id: req.run_id ?? '', reason: 'already_ended', turns: 0, tool_calls: 0, p50_ms: null, p95_ms: null, duration_s: 0, already: true };
    }
    s.ending ??= this.finish(s, clean(req.reason, 80) || 'hangup', req.stats);
    return s.ending;
  }

  private async finish(s: Session, reason: string, stats?: Record<string, unknown>): Promise<EndResponse> {
    const p50 = percentile(s.v2v, 50);
    const p95 = percentile(s.v2v, 95);
    const durationS = Math.round((this.now() - s.startedAt) / 1000);
    const failed = /^error|abandon/i.test(reason);
    const summary = {
      turns: s.turns,
      tool_calls: s.toolCalls,
      tool_errors: s.toolErrors,
      tools: s.tools,
      duration_s: durationS,
      reason,
      transport: s.transport,
      caller: s.caller,
      voice_to_voice_ms: { p50, p95, samples: s.v2v.length },
      asr_final_ms_median: s.asr.length ? Math.round(median(s.asr)) : null,
      llm_first_token_ms_median: s.llm.length ? Math.round(median(s.llm)) : null,
      tts_first_audio_ms_median: s.tts.length ? Math.round(median(s.tts)) : null,
      ...(stats && typeof stats === 'object' ? { client_stats: stats } : {}),
    };
    const title = failed
      ? `Call ended without a clean hang-up (${reason})`
      : `Call ended: ${s.turns} turn${s.turns === 1 ? '' : 's'}, ${s.toolCalls} tool call${s.toolCalls === 1 ? '' : 's'}${p50 !== null ? `, median ${p50} ms voice-to-voice` : ''}`;
    if (failed) s.run.emit('voice_agent', 'error', title, summary);
    else s.run.emit('voice_agent', 'final', title, summary);
    this.byRun.delete(s.runId);
    this.byCall.delete(s.callId);
    try {
      const errs = await s.run.drain();
      await this.d.sink.finishRun(s.runId, failed ? 'error' : 'done', s.run.providersJson(), JSON.stringify({ ...summary, effects: [], ...(errs.length ? { sink_errors: errs.slice(0, 5) } : {}) }));
    } catch (e) {
      this.log(`[phone] finish_run failed for ${s.runId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.log(`[phone] call ${s.callId} ended (${reason}): run ${s.runId}, ${s.turns} turns, ${s.toolCalls} tool calls; ${this.byRun.size} live`);
    return { ok: true, run_id: s.runId, reason, turns: s.turns, tool_calls: s.toolCalls, p50_ms: p50, p95_ms: p95, duration_s: durationS };
  }

  // ---- reaper --------------------------------------------------------------------------------------------------------
  /** Finish runs with no traffic for idleReapMs (or past maxCallMs) as error "abandoned". Returns the run ids it ended. */
  async reap(): Promise<string[]> {
    const t = this.now();
    const stale = [...this.byRun.values()].filter((s) => t - s.lastSeen > this.d.cfg.idleReapMs || t - s.startedAt > this.d.cfg.maxCallMs);
    await Promise.all(stale.map((s) => this.end({ run_id: s.runId, reason: t - s.startedAt > this.d.cfg.maxCallMs ? 'error: exceeded the maximum call length' : 'error: abandoned' })));
    return stale.map((s) => s.runId);
  }

  startReaper(everyMs = 30_000): void {
    this.stopReaper();
    this.reaper = setInterval(() => void this.reap().catch(() => undefined), everyMs);
    this.reaper.unref();
  }
  stopReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
  }
}

/**
 * A small voice model does better with fewer knobs: the read-only lookups take no arguments (an optional filter such as
 * get_obligations.kind made Lightning query every kind in turn), and the rest keep only what a person says out loud.
 */
const KEEP: Record<string, string[]> = {
  get_health_indicators: [],
  get_forecast: [],
  get_obligations: [],
  get_accounts: [],
  simulate_scenario: ['kind', 'label', 'amount', 'down_payment', 'financed', 'apr_pct', 'term_months', 'income_change_pct', 'income_change_monthly', 'duration_months', 'account_hint', 'months'],
  goal_feasibility: ['title', 'target_amount', 'target_date', 'monthly_contribution'],
  detect_scam_signals: ['text'],
};
function slimParameters(name: string, parameters: Record<string, unknown>): Record<string, unknown> {
  const keep = KEEP[name];
  if (!keep) return parameters;
  const props = (parameters.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(parameters.required) ? (parameters.required as string[]).filter((r) => keep.includes(r)) : [];
  return { ...parameters, properties: Object.fromEntries(Object.entries(props).filter(([k]) => keep.includes(k))), required };
}

/** Appended to every tool result the voice model sees: the most recent instruction is the one a small model obeys. */
export const REPLY_HINT = 'Answer in two short sentences, under 30 words: the headline plus one number or next step. Do not list items. Do not call another tool unless a number is missing.';

