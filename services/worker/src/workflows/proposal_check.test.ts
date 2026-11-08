// Family voting: the what_if workflow's proposal path (docs/contracts.md section 6). Local provider, no keys, no database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CachedTraceEvent, RunHistory } from '../agent/cache.js';
import { RunContext } from '../agent/run.js';
import { runJob, type RunnerDeps } from '../agent/runner.js';
import { MemorySink } from '../agent/sink.js';
import { loadConfig } from '../config.js';
import { buildLLMClient } from '../llm/client.js';
import { seedAvailable, seedHousehold, smallHousehold } from '../testing/fixtures.js';
import { FixedExternalApis } from '../tools/external.js';
import { buildRegistry } from '../tools/index.js';
import type { HouseholdData } from '../types.js';
import type { JobInfo } from './types.js';
import { needsScamCheck, proposalCacheKey, proposalOnError, proposalScenario, readProposal, type ProposalInput } from './proposal_check.js';

const SEED = join(new URL('.', import.meta.url).pathname, '../../../../data/seed');
interface SeedProposal { id: string; household_id: string; title: string; amount: number; details: Record<string, unknown>; created_by_name: string }
const seedProposals = (): SeedProposal[] => JSON.parse(readFileSync(join(SEED, 'proposals.json'), 'utf8'));
const byHousehold = (hh: string): SeedProposal => seedProposals().find((p) => p.household_id === hh)!;

const noHistory: RunHistory = { findCompletedRun: async () => null, traceEvents: async () => [] };
function deps(data: HouseholdData, over: Partial<RunnerDeps> = {}): { d: RunnerDeps; sink: MemorySink } {
  const sink = new MemorySink();
  return {
    sink,
    d: { sink, llm: buildLLMClient(loadConfig({})), registry: buildRegistry(), external: new FixedExternalApis(), loadData: async () => data, env: { transcript: async () => [] }, history: noHistory, demoMode: 'live', primary: { provider: 'local', model: 'keystone-rules-v1' }, ...over },
  };
}
const proposalJob = (p: Pick<SeedProposal, 'id' | 'household_id' | 'title' | 'amount' | 'details'> & { created_by_name?: string }, over: Partial<JobInfo> = {}): JobInfo => ({
  id: 1n,
  workflow: 'what_if',
  householdId: p.household_id,
  subjectId: p.id,
  input: { proposal_id: p.id, title: p.title, amount: p.amount, details: p.details, created_by: p.created_by_name ?? 'Tom' },
  ...over,
});
const input = (title: string, amount: number, details: Record<string, unknown> = {}): ProposalInput => ({ id: 'prop_x', title, amount, details, createdBy: 'Ana' });

describe('proposal -> scenario mapping', () => {
  it('maps the contract example (down_pct / term_months / rate_pct) to a financed purchase', () => {
    const s = proposalScenario(input('Buy a van', 32000, { down_pct: 20, term_months: 60, rate_pct: 6.2 }));
    expect(s).toMatchObject({ kind: 'purchase', financed: true, amount: 32000, down_payment: 6400, apr_pct: 6.2, term_months: 60 });
  });
  it('a plain proposal is a cash purchase; a loan is a new_loan whose proceeds are spent on the project', () => {
    expect(proposalScenario(input('Family trip to Hawaii', 6000))).toMatchObject({ kind: 'purchase', financed: false, amount: 6000 });
    expect(proposalScenario(input('Take the SBA loan', 250000, { kind: 'loan', term_months: 120, rate_pct: 10.75 }))).toMatchObject({ kind: 'new_loan', amount: 250000, apr_pct: 10.75, term_months: 120, proceeds_to_cash: false });
    expect(proposalScenario(input('Take a loan to remodel', 20000))).toMatchObject({ kind: 'new_loan', apr_pct: 8, term_months: 60 });
    expect(proposalScenario(input('A down payment', 38000, { kind: 'down_payment', down_pct: 20 }))).toMatchObject({ kind: 'purchase', financed: false });
  });
  it('clamps absurd inputs instead of failing the run', () => {
    expect(proposalScenario(input('x', 100, { rate_pct: 900, term_months: 9999, down_pct: 500 }))).toMatchObject({ apr_pct: 60, term_months: 480, down_payment: 100 });
  });
  it('reads a proposal job and ignores ordinary scenario jobs', () => {
    expect(readProposal(proposalJob({ id: 'prop_1', household_id: 'h', title: ' T ', amount: 5, details: { a: 1 } }))).toEqual({ id: 'prop_1', title: 'T', amount: 5, details: { a: 1 }, createdBy: 'Tom' });
    expect(readProposal({ id: 1n, workflow: 'what_if', householdId: 'h', subjectId: 'scn_1', input: { scenario_id: 'scn_1', prompt: 'What if?' } })).toBeNull();
  });
});

describe('scam guard trigger', () => {
  it('only proposals that move money to family or use gift cards / wires / crypto', () => {
    expect(needsScamCheck(input('Move $25k from the CD to help our grandson', 25000))).toBe(true);
    expect(needsScamCheck(input('Send $2,000 to my brother', 2000))).toBe(true);
    expect(needsScamCheck(input('Buy $500 in gift cards', 500))).toBe(true);
    expect(needsScamCheck(input('Pay it', 900, { kind: 'transfer' }))).toBe(true);
    for (const t of ['Take the SBA loan for the second bakery location', 'Down payment on a starter home', 'Buy a reliable used car', 'Family trip to Hawaii', 'New roof']) expect(needsScamCheck(input(t, 1000))).toBe(false);
  });
});

describe.skipIf(!seedAvailable())('proposal check on the seeded households (local provider)', () => {
  async function check(hh: string) {
    const p = byHousehold(hh);
    const { d, sink } = deps(seedHousehold(hh));
    const out = await runJob(proposalJob(p), d);
    const upd = sink.of('updateProposal');
    return { p, sink, out, upd, analysis: upd.length ? JSON.parse(String(upd[0]![2])) : null };
  }
  const tools = (sink: MemorySink) => sink.traces.filter((t) => t.type === 'tool_call').map((t) => (JSON.parse(t.dataJson) as { tool: string }).tool);

  it('there is one seeded proposal per household and votes only from its members', () => {
    const props = seedProposals();
    const members = JSON.parse(readFileSync(join(SEED, 'members.json'), 'utf8')) as { id: string; household_id: string }[];
    const votes = JSON.parse(readFileSync(join(SEED, 'votes.json'), 'utf8')) as { proposal_id: string; household_id: string; voter_key: string; choice: string }[];
    expect(props.map((p) => p.household_id).sort()).toEqual(['hh_brooks', 'hh_nguyen', 'hh_okafor', 'hh_patel', 'hh_rivera']);
    expect(votes.length).toBeGreaterThanOrEqual(props.length);
    for (const v of votes) {
      expect(['yes', 'no', 'abstain']).toContain(v.choice);
      expect(members.find((m) => m.id === v.voter_key)?.household_id).toBe(v.household_id);
      expect(props.find((p) => p.id === v.proposal_id)?.household_id).toBe(v.household_id);
    }
  });

  it('writes agent_update_proposal once, to the proposal, citing the run, with a ScenarioResult-style analysis', async () => {
    const { p, sink, out, upd, analysis } = await check('hh_brooks');
    expect(out.status).toBe('done');
    expect(upd).toHaveLength(1);
    expect(upd[0]![0]).toBe(p.id);
    expect(upd[0]![3]).toBe(out.runId);
    expect(sink.of('updateScenario')).toHaveLength(0); // never touches the scenario table
    expect(analysis).toMatchObject({ verdict: upd[0]![1], proposal: { id: p.id, amount: 6000 } });
    expect(typeof analysis.summary).toBe('string');
    expect(typeof analysis.suggestion).toBe('string');
    expect(analysis.metrics.map((m: { label: string }) => m.label)).toEqual(expect.arrayContaining(['Proposed amount', 'Cash needed up front', 'Lowest cash balance']));
    expect(analysis.series.length).toBeGreaterThan(10);
    expect(JSON.stringify(analysis).length).toBeLessThan(8000);
    // fully traced: plan -> tools -> final, provider/model on every event
    expect(sink.traces.map((t) => t.type)).toEqual(expect.arrayContaining(['run_started', 'plan', 'tool_call', 'tool_result', 'final']));
    expect(sink.traces.every((t) => t.provider === 'local' && t.model)).toBe(true);
    expect(tools(sink)).toEqual(['simulate_scenario', 'get_forecast']); // no scam scan for a holiday
  });

  it('verdicts fit each household story', async () => {
    const got: Record<string, string> = {};
    for (const hh of ['hh_rivera', 'hh_okafor', 'hh_nguyen', 'hh_patel', 'hh_brooks']) got[hh] = (await check(hh)).upd[0]![1] as string;
    expect(got).toEqual({ hh_rivera: 'risky', hh_okafor: 'risky', hh_nguyen: 'risky', hh_patel: 'risky', hh_brooks: 'fine' });
  });

  it('Rivera: the SBA payment is compared with today\'s cash flow and the limits are stated', async () => {
    const { analysis } = await check('hh_rivera');
    expect(analysis.scenario).toMatchObject({ kind: 'new_loan', amount: 250000 });
    expect(analysis.metrics.find((m: { label: string }) => m.label === 'New monthly payment').after).toBeGreaterThan(3000);
    expect(analysis.assumptions.join(' ')).toMatch(/income the new project would bring is not/);
    expect(analysis.suggestion).toMatch(/project would earn/);
  });

  it('Okafor: $38k does not fit in $25k of cash, and the check says by how much', async () => {
    const { analysis } = await check('hh_okafor');
    expect(analysis.metrics.find((m: { label: string }) => m.label === 'Share of checking and savings').after).toBeGreaterThan(100);
    expect(analysis.low_point.balance).toBeLessThan(0);
  });

  it('Nguyen: the grandson transfer is flagged by the scam guard, forced to risky, and raised as an alert', async () => {
    const { sink, upd, analysis } = await check('hh_nguyen');
    expect(tools(sink)).toEqual(['simulate_scenario', 'get_forecast', 'detect_scam_signals']);
    expect(upd[0]![1]).toBe('risky');
    expect(analysis.scam.risk).toMatch(/medium|high/);
    expect(analysis.scam.linked_total).toBe(2000); // the four Oct 21 gift-card purchases
    expect(analysis.summary).toMatch(/^Scam warning:/);
    expect(analysis.suggestion).toMatch(/Do not send money/);
    // the money alone would have been fine (they hold far more than $25k): the scam signal is what flips it
    expect(analysis.low_point.balance).toBeGreaterThan(0);
    const alerts = sink.of('createAlert').map((a) => a[0] as { kind: string; severity: string; id: string; household_id: string; title: string });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'scam', household_id: 'hh_nguyen' });
    expect(alerts[0]!.id).toMatch(/^agent:hh-nguyen:proposal-scam-/);
    expect(sink.traces.some((t) => t.agent === 'scam_guard' && t.type === 'tool_call')).toBe(true);
  });

  it('Patel: a $14k car on a 18.5% loan is risky for a household with $377 in the bank', async () => {
    const { analysis } = await check('hh_patel');
    expect(analysis.scenario).toMatchObject({ kind: 'purchase', financed: true, down_payment: 1400, apr_pct: 18.5 });
    expect(analysis.verdict).toBe('risky');
  });
});

describe('proposal check: failures, cache and what_if unaffected', () => {
  it('an unreadable result leaves the proposal unchecked with an explanation instead of a scenario error', () => {
    const sink = new MemorySink();
    const run = new RunContext({ runId: 'r1', workflow: 'what_if', householdId: 'hh_test', subjectId: 'prop_9' }, { sink, llm: buildLLMClient(loadConfig({})), registry: buildRegistry(), toolContext: { data: smallHousehold(), external: new FixedExternalApis() }, primary: { provider: 'local', model: 'm' } });
    proposalOnError(run, new Error('boom'));
    const [id, verdict, json] = sink.of('updateProposal')[0] as string[];
    expect(id).toBe('prop_9');
    expect(verdict).toBe('');
    expect(JSON.parse(json!).summary).toMatch(/could not finish: boom/);
    expect(sink.of('updateScenario')).toHaveLength(0);
  });

  it('a failing simulation ends in an error run and the proposal is left unchecked with an explanation', async () => {
    const p = { id: 'prop_f', household_id: 'hh_test', title: 'Buy a thing', amount: 100, details: {} };
    const { d, sink } = deps(smallHousehold());
    const registry = buildRegistry();
    const execute = registry.execute.bind(registry);
    registry.execute = async (name, args, ctx) => (name === 'simulate_scenario' ? { ok: false, error: 'simulator exploded', summary: '', durationMs: 1 } : execute(name, args, ctx));
    const out = await runJob(proposalJob(p), { ...d, registry });
    expect(out).toMatchObject({ status: 'error', error: 'simulator exploded' });
    const upd = sink.of('updateProposal');
    expect(upd).toHaveLength(1);
    expect(upd[0]!.slice(0, 2)).toEqual(['prop_f', '']);
    expect(JSON.parse(String(upd[0]![2])).summary).toMatch(/could not finish: simulator exploded/);
    expect(sink.of('updateScenario')).toHaveLength(0);
    expect(sink.traces.at(-1)).toMatchObject({ type: 'error' });
  });

  it('cache_first: an identical proposal on a sandbox of the same household is replayed and applied to the NEW proposal', async () => {
    const data = smallHousehold({ household: { ...smallHousehold().household, id: 'hh_sbx_1', template_id: 'hh_test' } });
    const p = { id: 'prop_old', household_id: 'hh_sbx_1', title: 'Family trip to Hawaii', amount: 6000, details: { kind: 'purchase' } };
    const first = deps(data);
    expect(await runJob(proposalJob(p), first.d)).toMatchObject({ status: 'done', replayed: false });
    const result = JSON.parse(String(first.sink.of('finishRun')[0]![3]));
    expect(result.cache_key).toMatch(/^what_if@e[0-9]+:hh_test:/);
    expect(result.effects.some((e: { kind: string }) => e.kind === 'proposal')).toBe(true);
    const stored: CachedTraceEvent[] = first.sink.traces.map((t, i) => ({ seq: t.seq, tsMs: i * 1000, agent: t.agent, type: t.type, title: t.title, dataJson: t.dataJson, model: t.model, provider: t.provider, latencyMs: t.latencyMs }));
    const history: RunHistory = { findCompletedRun: async (_w, key) => (key === result.cache_key ? { runId: 'run_old', effects: result.effects, result } : null), traceEvents: async () => stored };
    const second = deps(data, { demoMode: 'cache_first', history, sleep: async () => undefined });
    const again = await runJob(proposalJob({ ...p, id: 'prop_new' }, { id: 2n }), second.d);
    expect(again).toMatchObject({ status: 'done', replayed: true });
    expect(second.sink.traces.filter((t) => t.type !== 'run_started').every((t) => t.provider === 'cache')).toBe(true);
    const upd = second.sink.of('updateProposal');
    expect(upd.at(-1)![0]).toBe('prop_new');
    expect(upd.at(-1)![3]).toBe(again.runId);
    // a different amount is a different question: it runs live
    const other = deps(data, { demoMode: 'cache_first', history });
    expect((await runJob(proposalJob({ ...p, id: 'prop_3', amount: 7000 }, { id: 3n }), other.d)).replayed).toBe(false);
  });

  it('cache keys ignore detail key order and case in the title', () => {
    const run = { data: smallHousehold() } as unknown as RunContext;
    expect(proposalCacheKey(run, input('Family Trip', 5, { a: 1, b: 2 }))).toBe(proposalCacheKey(run, input('family trip', 5, { b: 2, a: 1 })));
    expect(proposalCacheKey(run, input('Family Trip', 5))).not.toBe(proposalCacheKey(run, input('Family Trip', 6)));
  });

  it('a normal what-if prompt still produces a scenario update, not a proposal update', async () => {
    const { d, sink } = deps(smallHousehold());
    await runJob({ id: 1n, workflow: 'what_if', householdId: 'hh_test', subjectId: 'scn_1', input: { scenario_id: 'scn_1', prompt: 'Can we afford a $32,000 car with 10% down at 6.5% APR over 5 years?' } }, d);
    expect(sink.of('updateScenario').at(-1)![1]).toBe('done');
    expect(sink.of('updateProposal')).toHaveLength(0);
  });
});
