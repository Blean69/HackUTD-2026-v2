import { describe, expect, it } from 'vitest';
import { buildLLMClient, LLMClient } from '../llm/client.js';
import { loadConfig } from '../config.js';
import { LocalProvider } from '../llm/local.js';
import { LLMError } from '../llm/types.js';
import type { ChatRequest, ChatResult, LLMProvider } from '../llm/types.js';
import { seedAvailable, seedConversations, seedHousehold, smallHousehold, txn } from '../testing/fixtures.js';
import { FixedExternalApis } from '../tools/external.js';
import { buildRegistry } from '../tools/index.js';
import type { HouseholdData } from '../types.js';
import { workflowNames } from '../workflows/index.js';
import type { JobInfo } from '../workflows/types.js';
import { compressDelays, makeCacheKey, MAX_REPLAY_MS, normalizeText, replayRun, type CachedTraceEvent, type RunHistory } from './cache.js';
import { runAgentLoop } from './loop.js';
import { RunContext } from './run.js';
import { runJob, type RunnerDeps } from './runner.js';
import { MemorySink } from './sink.js';

const localLLM = () => buildLLMClient(loadConfig({}));
const noHistory: RunHistory = { findCompletedRun: async () => null, traceEvents: async () => [] };

function deps(data: HouseholdData, over: Partial<RunnerDeps> = {}, lines: { speaker: string; text: string }[] = []): { d: RunnerDeps; sink: MemorySink } {
  const sink = new MemorySink();
  return {
    sink,
    d: {
      sink,
      llm: localLLM(),
      registry: buildRegistry(),
      external: new FixedExternalApis(),
      loadData: async () => data,
      env: { transcript: async () => lines },
      history: noHistory,
      demoMode: 'live',
      primary: { provider: 'local', model: 'keystone-rules-v1' },
      ...over,
    },
  };
}
const job = (workflow: string, over: Partial<JobInfo> = {}): JobInfo => ({ id: 1n, workflow, householdId: 'hh_test', subjectId: 'subj', input: {}, ...over });

describe('agent loop', () => {
  it('plans first, then tool_call/tool_result per step, then final; records provider and model on every event', async () => {
    const sink = new MemorySink();
    let step = 0;
    const scripted: LLMProvider = {
      id: 'nvidia',
      modelFor: () => 'nvidia/nemotron-3-super-120b-a12b',
      async call(req: ChatRequest): Promise<ChatResult> {
        const base = { provider: 'nvidia' as const, model: 'nvidia/nemotron-3-super-120b-a12b', latencyMs: 120, tokensIn: 50, tokensOut: 20 };
        if (req.task === 'test.plan') return { ...base, content: '1. Look at the balances (get_accounts)\n2. Answer', toolCalls: [] };
        step++;
        if (step === 1) return { ...base, content: '', reasoning: 'I need the balances first. Then answer.', toolCalls: [{ id: 'c1', name: 'get_accounts', arguments: '{"type":"savings"}' }] };
        return { ...base, content: 'You have $10,000 in savings.', toolCalls: [] };
      },
    };
    const run = new RunContext({ runId: 'r1', workflow: 'coach', householdId: 'hh_test', subjectId: 's' }, { sink, llm: new LLMClient([scripted]), registry: buildRegistry(), toolContext: { data: smallHousehold(), external: new FixedExternalApis() }, primary: { provider: 'nvidia', model: 'm' } });
    const res = await runAgentLoop(run, { agent: 'coach', task: 'test', system: 'sys', user: 'How much do we have saved?', tools: ['get_accounts'] });
    await run.drain();
    expect(res.answer).toBe('You have $10,000 in savings.');
    expect(sink.traces.map((t) => t.type)).toEqual(['plan', 'thought', 'tool_call', 'tool_result', 'final']);
    expect(sink.traces.every((t) => t.provider === 'nvidia' && t.model.includes('nemotron'))).toBe(true);
    expect(sink.traces[0]).toMatchObject({ latencyMs: 120, tokensIn: 50, tokensOut: 20 });
    expect(sink.traces.map((t) => t.seq)).toEqual([0, 1, 2, 3, 4]);
    for (const t of sink.traces) expect(t.dataJson.length).toBeLessThanOrEqual(4096);
    expect(sink.traces[2]!.title).toMatch(/savings/);
  });
});

describe('cache_first replay', () => {
  it('normalizes input and builds stable keys (sandbox maps back to the template)', () => {
    expect(normalizeText('  Can we AFFORD a $32,000 car?? ')).toBe(normalizeText('can we afford a $32,000 car'));
    expect(makeCacheKey('what_if', 'hh_rivera', 'x')).toBe(makeCacheKey('what_if', 'hh_rivera', 'x'));
    expect(makeCacheKey('what_if', 'hh_rivera', 'x')).not.toBe(makeCacheKey('what_if', 'hh_okafor', 'x'));
  });
  it('compresses original timing to at most 8 seconds', () => {
    const ts = [0, 10_000, 70_000, 130_000];
    const d = compressDelays(ts);
    expect(d.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(MAX_REPLAY_MS);
    expect(d[0]).toBe(0);
    expect(compressDelays([0, 100, 250]).reduce((s, x) => s + x, 0)).toBe(250); // short runs keep their real timing
  });
  it('a second identical what_if is replayed from the first run, with provider cache and the result re-applied', async () => {
    const data = smallHousehold({ household: { ...smallHousehold().household, id: 'hh_sbx_1', template_id: 'hh_test' } });
    const first = deps(data);
    const input = { prompt: 'Can we afford a $32,000 car with 10% down at 6.5% APR over 5 years?' };
    const a = await runJob(job('what_if', { householdId: 'hh_sbx_1', input }), first.d);
    expect(a).toMatchObject({ status: 'done', replayed: false });
    const finish = first.sink.of('finishRun')[0]!;
    const result = JSON.parse(String(finish[3]));
    expect(result.cache_key).toMatch(/^what_if@e[0-9]+:hh_test:/);
    expect(result.effects.some((e: { kind: string }) => e.kind === 'scenario')).toBe(true);

    // pretend those events were stored in SpacetimeDB with real-time gaps of 3 s
    const stored: CachedTraceEvent[] = first.sink.traces.map((t, i) => ({ seq: t.seq, tsMs: i * 3000, agent: t.agent, type: t.type, title: t.title, dataJson: t.dataJson, model: t.model, provider: t.provider, latencyMs: t.latencyMs }));
    const history: RunHistory = { findCompletedRun: async (_w, key) => (key === result.cache_key ? { runId: 'run_old', effects: result.effects, result } : null), traceEvents: async () => stored };
    const slept: number[] = [];
    const second = deps(data, { demoMode: 'cache_first', history, sleep: async (ms) => void slept.push(ms) });
    const b = await runJob(job('what_if', { id: 2n, householdId: 'hh_sbx_1', subjectId: 'scn_new', input: { prompt: 'can we afford a $32,000 car with 10% down at 6.5% APR over 5 years' } }), second.d);
    expect(b).toMatchObject({ status: 'done', replayed: true });
    expect(second.sink.traces.filter((t) => t.type !== 'run_started').every((t) => t.provider === 'cache')).toBe(true);
    expect(slept.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(MAX_REPLAY_MS);
    const upd = second.sink.of('updateScenario');
    expect(upd.at(-1)![0]).toBe('scn_new'); // result re-applied to the NEW scenario row
    expect(upd.at(-1)![1]).toBe('done');
    expect(second.sink.traces.some((t) => /Cache hit/.test(t.title))).toBe(true);
  });
  it('new input never replays: it runs live', async () => {
    const data = smallHousehold();
    const history: RunHistory = { findCompletedRun: async () => null, traceEvents: async () => [] };
    const { d, sink } = deps(data, { demoMode: 'cache_first', history });
    const out = await runJob(job('what_if', { input: { prompt: 'What if we lose a paycheck for 2 months?' } }), d);
    expect(out.replayed).toBe(false);
    expect(sink.traces.some((t) => t.type === 'tool_call')).toBe(true);
  });
  it('passes the local-cache policy to the history lookup', async () => {
    const seen: boolean[] = [];
    const history: RunHistory = { findCompletedRun: async (_w, _k, _r, allowLocalOnly) => (seen.push(allowLocalOnly), null), traceEvents: async () => [] };
    const input = { prompt: 'What if we lose a paycheck for 2 months?' };
    await runJob(job('what_if', { input }), deps(smallHousehold(), { demoMode: 'cache_first', history, allowLocalCache: false }).d);
    await runJob(job('what_if', { input }), deps(smallHousehold(), { demoMode: 'cache_first', history }).d);
    expect(seen).toEqual([false, true]);
  });
  it('replayRun emits every stored step under the new run', async () => {
    const { d, sink } = deps(smallHousehold());
    const run = new RunContext({ runId: 'rNew', workflow: 'coach', householdId: 'hh_test', subjectId: 's' }, { sink, llm: d.llm, registry: d.registry, toolContext: { data: smallHousehold(), external: d.external }, primary: { provider: 'local', model: 'keystone-rules-v1' } });
    const events: CachedTraceEvent[] = [
      { seq: 0, tsMs: 0, agent: 'planner', type: 'run_started', title: 'x', dataJson: '{}', model: 'm', provider: 'nvidia', latencyMs: 0 },
      { seq: 1, tsMs: 1000, agent: 'coach', type: 'plan', title: 'p', dataJson: '{"steps":["a"]}', model: 'nvidia/nemotron', provider: 'nvidia', latencyMs: 900 },
      { seq: 2, tsMs: 2000, agent: 'coach', type: 'final', title: 'f', dataJson: '{"answer":"ok"}', model: 'nvidia/nemotron', provider: 'nvidia', latencyMs: 400 },
    ];
    await replayRun(run, { runId: 'old', effects: [{ kind: 'coach_reply', text: 'ok' }], result: {} }, events, { sleep: async () => undefined });
    await run.drain();
    expect(sink.traces.map((t) => t.type)).toEqual(['message', 'plan', 'final']);
    expect(sink.traces.every((t) => t.provider === 'cache')).toBe(true);
    expect(JSON.parse(sink.traces[1]!.dataJson)).toMatchObject({ cached: true, replayed_from: 'old', original_provider: 'nvidia' });
    expect(sink.of('coachReply')[0]).toEqual(['hh_test', 'ok', 'rNew']);
  });
});

describe('workflows on the local provider (no keys, no database)', () => {
  const types = (sink: MemorySink) => sink.traces.map((t) => t.type);

  it('registers every workflow by name, including the hook for plaid_sync', () => {
    expect(workflowNames()).toEqual(expect.arrayContaining(['huddle', 'what_if', 'coach', 'data_quality', 'scam_check']));
  });

  it('what_if: plan, parse, simulate, narrate, write a web-shaped result', async () => {
    const { d, sink } = deps(smallHousehold());
    const out = await runJob(job('what_if', { subjectId: 'scn_1', input: { prompt: 'Can we afford a $32,000 car with 10% down at 6.5% APR over 5 years?' } }), d);
    expect(out.status).toBe('done');
    expect(types(sink)).toEqual(expect.arrayContaining(['run_started', 'plan', 'tool_call', 'tool_result', 'final']));
    expect(sink.traces[1]!.type).toBe('plan');
    const updates = sink.of('updateScenario');
    expect(updates[0]![1]).toBe('running');
    const final = updates.at(-1)!;
    expect(final[0]).toBe('scn_1');
    expect(final[1]).toBe('done');
    const r = JSON.parse(String(final[2]));
    expect(['fine', 'tight', 'risky']).toContain(r.verdict);
    expect(r.metrics.length).toBeGreaterThan(2);
    expect(r.series.length).toBeGreaterThan(12);
    expect(r.series[0]).toHaveProperty('baseline');
    expect(r.low_point).toHaveProperty('balance');
    expect(typeof r.suggestion).toBe('string');
    expect(sink.of('finishRun')[0]![1]).toBe('done');
  });

  it('coach: multi-step tool use, then a reply carrying the run id', async () => {
    const { d, sink } = deps(smallHousehold());
    const out = await runJob(job('coach', { subjectId: '7', input: { text: 'Can we afford a $20,000 kitchen remodel?' } }), d);
    expect(out.status).toBe('done');
    expect(types(sink).filter((t) => t === 'tool_call').length).toBeGreaterThanOrEqual(2);
    const reply = sink.of('coachReply')[0]!;
    expect(reply[0]).toBe('hh_test');
    expect(String(reply[1]).length).toBeGreaterThan(40);
    expect(reply[2]).toBe(out.runId);
  });

  it('data_quality: explains findings with one summary alert instead of duplicating per-transaction rule alerts', async () => {
    const base = smallHousehold();
    const data = { ...base, txns: [...base.txns, txn({ id: 'd1', date: '2026-10-20', amount: -24.05, merchant: 'Chipotle', category: 'dining' }), txn({ id: 'd2', date: '2026-10-20', amount: -24.05, merchant: 'Chipotle', category: 'dining' }), txn({ id: 'g1', date: '2026-10-24', amount: -500, merchant: 'Target', category: 'gift_cards' })] };
    const { d, sink } = deps(data);
    const out = await runJob(job('data_quality', { subjectId: 'hh_test' }), d);
    expect(out.status).toBe('done');
    const alerts = sink.of('createAlert').map((a) => a[0] as { id: string; kind: string; title: string });
    expect(alerts.every((a) => a.id.startsWith('agent:') && !a.id.startsWith('rule:'))).toBe(true);
    expect(alerts.some((a) => a.kind === 'data_quality')).toBe(true);
    expect(alerts.some((a) => a.kind === 'scam')).toBe(true);
  });

  it('scam_check on a pasted message raises a scam alert', async () => {
    const { d, sink } = deps(smallHousehold());
    const out = await runJob(job('scam_check', { input: { text: 'IRS agent here. Pay the back taxes today with gift cards or a warrant will be issued. Do not tell anyone.' } }), d);
    expect(out.status).toBe('done');
    expect(sink.of('createAlert').some((a) => (a[0] as { kind: string }).kind === 'scam')).toBe(true);
  });

  it('huddle: extract, scam guard, reconcile, goal cards, set done, purge', async () => {
    const lines = [
      { speaker: 'Marisol', text: 'The contractor said about two hundred fifty thousand for the build-out of the second location. We want to open by the end of September next year.' },
      { speaker: 'Daniel', text: 'I am worried we are too tight. Our emergency fund has fourteen thousand and we should keep it.' },
      { speaker: 'Marisol', text: 'We should set aside nine thousand for Abuela\'s medical costs by next June.' },
    ];
    const { d, sink } = deps(smallHousehold(), {}, lines);
    const out = await runJob(job('huddle', { subjectId: 'hud_1', input: { huddle_id: 'hud_1' } }), d);
    expect(out.status).toBe('done');
    const goals = sink.of('upsertGoal').map((g) => g[0] as { id: string; household_id: string; title: string; feasibility: string; evidence_quote: string; source: string; target_amount: number });
    expect(goals.length).toBeGreaterThanOrEqual(2);
    for (const g of goals) {
      expect(g.household_id).toBe('hh_test');
      expect(g.id).toMatch(/^goal_test_/);
      expect(g.source).toBe('huddle');
      expect(g.evidence_quote.length).toBeGreaterThan(5);
    }
    expect(goals.find((g) => g.target_amount === 250000)?.feasibility).toBe('off_track');
    expect(sink.of('setHuddleStatus')[0]).toEqual(['hud_1', 'done']);
    expect(sink.of('purgeTranscript')[0]).toEqual(['hud_1']);
    const order = sink.calls.map((c) => c.fn);
    expect(order.indexOf('upsertGoal')).toBeLessThan(order.indexOf('purgeTranscript')); // purge only after analysis
    expect(types(sink)).toEqual(expect.arrayContaining(['plan', 'handoff', 'tool_call', 'tool_result', 'message', 'final']));
    expect(sink.traces.some((t) => t.title.includes('Deleted the raw transcript'))).toBe(true);
  });

  it('Table Mode: what people read never says "Huddle" (workflow id, table and reducer names stay internal)', async () => {
    const say = (text: string) => [{ speaker: 'Marisol', text }];
    // a normal run, a run with a scam, an empty run (nothing to analyze) and a failing run
    const runs: { name: string; titles: string[] }[] = [];
    const collect = async (name: string, hd: ReturnType<typeof deps>, j: JobInfo) => {
      await runJob(j, hd.d);
      const alerts = hd.sink.of('createAlert').flatMap((a) => [(a[0] as { title: string }).title, (a[0] as { detail: string }).detail]);
      runs.push({ name, titles: [...hd.sink.traces.map((t) => t.title), ...alerts] });
    };
    await collect('normal', deps(smallHousehold(), {}, say('We want to save nine thousand for Abuela\'s medical costs by next June.')), job('huddle', { subjectId: 'hud_1' }));
    await collect('scam', deps(smallHousehold(), {}, [{ speaker: 'Tom', text: 'A man said he was our grandson in jail and told us to buy gift cards and keep it secret from his parents, right now.' }]), job('huddle', { subjectId: 'hud_2' }));
    await collect('empty', deps(smallHousehold(), {}, []), job('huddle', { subjectId: 'hud_3' }));
    const failing = deps(smallHousehold(), { loadData: async () => smallHousehold() }, say('x'));
    failing.d.env = { transcript: async () => { throw new Error('transcript store offline'); } };
    await collect('failing', failing, job('huddle', { subjectId: 'hud_4' }));
    for (const r of runs) for (const t of r.titles) expect(t, `${r.name}: ${t}`).not.toMatch(/huddle/i);
    const start = runs[0]!.titles.find((t) => /^Started /.test(t))!;
    expect(start).toBe('Started Table Mode run for Test Family');
    expect(runs[2]!.titles).toEqual(expect.arrayContaining(['Table Mode had no transcript lines, so there is nothing to analyze.', 'Table Mode closed with no transcript']));
    expect(runs[3]!.titles).toContain('Table Mode analysis did not finish');
  });

  it('a failing workflow ends in an error event, an error run, and cleans up (scenario error / transcript purge)', async () => {
    const { d, sink } = deps(smallHousehold(), { loadData: async () => smallHousehold() });
    const out = await runJob(job('what_if', { input: { prompt: '' } }), d);
    expect(out.status).toBe('error');
    expect(types(sink)).toContain('error');
    expect(sink.of('finishRun')[0]![1]).toBe('error');
    expect(sink.of('updateScenario').at(-1)![1]).toBe('error');
  });

  const seedIt = seedAvailable() ? it : it.skip;
  seedIt('every seed household and sample conversation runs through all workflows on the local provider', async () => {
    for (const id of ['hh_rivera', 'hh_okafor', 'hh_nguyen', 'hh_patel', 'hh_brooks']) {
      const data = seedHousehold(id);
      const convo = seedConversations(id)[0]!;
      const lines = convo.turns;
      const dq = deps(data, {}, lines);
      expect((await runJob(job('data_quality', { householdId: id, subjectId: id }), dq.d)).status, `${id} data_quality`).toBe('done');
      const hd = deps(data, {}, lines);
      expect((await runJob(job('huddle', { householdId: id, subjectId: `hud_${id}` }), hd.d)).status, `${id} huddle`).toBe('done');
      expect(hd.sink.of('purgeTranscript')).toHaveLength(1);
      const co = deps(data, {}, lines);
      expect((await runJob(job('coach', { householdId: id, input: { text: 'How are we doing and what should we watch?' } }), co.d)).status, `${id} coach`).toBe('done');
      const wi = deps(data, {}, lines);
      expect((await runJob(job('what_if', { householdId: id, subjectId: 'scn', input: { prompt: 'What if our income dropped 20% for six months?' } }), wi.d)).status, `${id} what_if`).toBe('done');
    }
  });

  seedIt('the Nguyen huddle links the gift-card scam to the $2,000 of purchases', async () => {
    const data = seedHousehold('hh_nguyen');
    const { d, sink } = deps(data, {}, seedConversations('hh_nguyen')[0]!.turns);
    await runJob(job('huddle', { householdId: 'hh_nguyen', subjectId: 'hud_n' }), d);
    const scam = sink.of('createAlert').map((a) => a[0] as { kind: string; severity: string; title: string; related_ids: string[] }).find((a) => a.kind === 'scam');
    expect(scam).toBeTruthy();
    expect(scam!.severity).toBe('critical');
    expect(scam!.title).toMatch(/\$2,000/);
    expect(scam!.related_ids.length).toBe(4);
  });
});

describe('local provider', () => {
  it('is deterministic', async () => {
    const lp = new LocalProvider();
    const a = await lp.call({ role: 'fast', messages: [], task: 'scenario.parse', local: { prompt: 'pay off the car loan' }, toolChoice: { name: 'x' }, tools: [{ name: 'x', description: '', parameters: {} }] });
    const b = await lp.call({ role: 'fast', messages: [], task: 'scenario.parse', local: { prompt: 'pay off the car loan' }, toolChoice: { name: 'x' }, tools: [{ name: 'x', description: '', parameters: {} }] });
    expect(a.toolCalls).toEqual(b.toolCalls);
    expect(a.provider).toBe('local');
  });
});


describe('provider failover labelling and visible reasoning', () => {
  /** A scripted "model" that answers every workflow step and returns reasoning_content for planning and summaries. */
  function scripted(id: 'nvidia' | 'tenvor_qwen', model: string, fail?: () => Error | null): LLMProvider {
    return {
      id,
      modelFor: () => model,
      async call(req: ChatRequest): Promise<ChatResult> {
        const err = fail?.();
        if (err) throw err;
        const base = { provider: id, model, latencyMs: 80, tokensIn: 40, tokensOut: 15 };
        if (req.task === 'huddle.extract')
          return { ...base, content: '', toolCalls: [{ id: 'c', name: 'record_huddle_findings', arguments: JSON.stringify({ goals: [{ title: 'Open a second bakery', kind: 'business', target_amount: 250000, target_date: '2027-09-30', priority: 1, evidence_quote: 'about two hundred fifty thousand' }], concerns: [{ text: 'January looks tight' }], key_dates: [] }) }] };
        if (req.task === 'huddle.plan') return { ...base, content: '1. Extract goals\n2. Check them against the accounts', reasoning: 'The family spoke about one big goal. I should check it against savings. Then summarize.', toolCalls: [] };
        if (req.task === 'huddle.summary') return { ...base, content: 'One big goal is far off; start with a reserve.', reasoning: 'The gap is huge compared with monthly surplus. A reserve is the realistic first step.', toolCalls: [] };
        return { ...base, content: 'ok', toolCalls: [] };
      },
    };
  }
  const lines = [{ speaker: 'Marisol', text: 'The contractor said about two hundred fifty thousand for the build-out of the second location.' }];

  it('huddle surfaces Nemotron reasoning_content as thought events (plan and summary), each tagged with provider and model', async () => {
    const llm = new LLMClient([scripted('nvidia', 'nvidia/nemotron-3-super-120b-a12b'), new LocalProvider()], { sleep: async () => undefined });
    const { d, sink } = deps(smallHousehold(), { llm, agentThinking: true, primary: () => llm.primary() }, lines);
    const out = await runJob(job('huddle', { subjectId: 'hud_t' }), d);
    expect(out.status).toBe('done');
    const thoughts = sink.traces.filter((t) => t.type === 'thought');
    expect(thoughts.length).toBeGreaterThanOrEqual(2);
    expect(thoughts.every((t) => t.provider === 'nvidia' && t.model === 'nvidia/nemotron-3-super-120b-a12b')).toBe(true);
    expect(thoughts[0]!.title).toMatch(/^Planning: /);
    expect(JSON.parse(thoughts[0]!.dataJson).reasoning).toMatch(/savings/);
    const agentOrder = sink.traces.map((t) => t.type);
    expect(agentOrder.indexOf('thought')).toBeGreaterThan(agentOrder.indexOf('run_started'));
  });

  it('when NVIDIA keeps returning 429, the run is answered by Qwen and every LLM-driven event says tenvor_qwen with the real model id', async () => {
    const sleeps: number[] = [];
    const nv = scripted('nvidia', 'nvidia/nemotron-3-super-120b-a12b', () => new LLMError('HTTP 429: slow down', 429));
    const qw = scripted('tenvor_qwen', 'Qwen/Qwen3-30B-A3B');
    const llm = new LLMClient([nv, qw, new LocalProvider()], { sleep: async (ms) => void sleeps.push(ms), backoffBaseMs: 500 });
    const { d, sink } = deps(smallHousehold(), { llm, agentThinking: true, primary: () => llm.primary() }, lines);
    expect((await runJob(job('huddle', { subjectId: 'hud_q' }), d)).status).toBe('done');
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3000 + 400); // waited ~3 s on Nemotron, then failed over
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    const after = sink.traces.filter((t) => t.type !== 'run_started');
    expect(after.every((t) => t.provider === 'tenvor_qwen' && t.model === 'Qwen/Qwen3-30B-A3B')).toBe(true);
    expect(sink.traces.some((t) => /Switched provider after nvidia/.test(t.title))).toBe(true);
    const providers = JSON.parse(String(sink.of('finishRun')[0]![2])) as { provider: string; model: string }[];
    expect(providers).toEqual([expect.objectContaining({ provider: 'tenvor_qwen', model: 'Qwen/Qwen3-30B-A3B' })]);
  });
});
