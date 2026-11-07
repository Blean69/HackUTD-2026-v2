// onboarding_insights (docs/contracts.md section 7) on the keyless local provider: no network, no database.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runJob, type RunnerDeps } from '../agent/runner.js';
import { MemorySink } from '../agent/sink.js';
import { loadConfig } from '../config.js';
import { LLMClient, buildLLMClient } from '../llm/client.js';
import { LocalProvider } from '../llm/local.js';
import type { ChatRequest, ChatResult, LLMProvider } from '../llm/types.js';
import { loadSandboxUserJson, sandboxUserPath } from '../plaid/custom_user.js';
import { acct, smallHousehold, txn } from '../testing/fixtures.js';
import { FixedExternalApis } from '../tools/external.js';
import { buildRegistry } from '../tools/index.js';
import type { HouseholdData } from '../types.js';
import { workflowNames } from './index.js';
import { candidateInsights, computeFacts, planGoal, proposalIdeas } from './onboarding_insights.js';
import type { JobInfo } from './types.js';

const HH = 'hh_onb_test01';

/** The small household, moved into an onboarding household with a costly card, a CD coming due, subscriptions and the goals the module creates. */
function onboarded(extra: Partial<HouseholdData> = {}): HouseholdData {
  const base = smallHousehold();
  const subs = ['2026-08-12', '2026-09-12', '2026-10-12'].flatMap((d, i) => [
    txn({ id: `n${i}`, date: d, amount: -15.49, merchant: 'Netflix', category: 'entertainment' }),
    txn({ id: `s${i}`, date: d, amount: -10.99, merchant: 'Spotify', category: 'entertainment' }),
    txn({ id: `g${i}`, date: d, amount: -39, merchant: 'Planet Fitness', category: 'health' }),
  ]);
  const goal = (key: string, title: string, priority: number) => ({ id: `goal_${HH}_${key}`, title, target_amount: 0, target_date: '', priority, feasibility: '' });
  return {
    ...base,
    household: { ...base.household, id: HH, name: 'The Whitfields' },
    members: [
      { id: 'm1', household_id: HH, name: 'Dana', age: 39, role: 'parent', income_annual: 82000 },
      { id: 'm2', household_id: HH, name: 'Kit', age: 9, role: 'child', income_annual: 0 },
    ],
    accounts: [...base.accounts, acct({ id: 'cd1', type: 'cd', nickname: 'Plaid CD', balance: 30000, maturity_date: '2026-12-20' })],
    txns: [...base.txns, ...subs],
    goals: [goal('emergency_fund', 'Build an emergency fund', 1), goal('college', 'Save for college', 2), goal('custom', 'Replace the roof for $8,000', 3)],
    ...extra,
  };
}

const noHistory = { findCompletedRun: async () => null, traceEvents: async () => [] };
function deps(data: HouseholdData, llm: LLMClient = buildLLMClient(loadConfig({}))): { d: RunnerDeps; sink: MemorySink } {
  const sink = new MemorySink();
  return { sink, d: { sink, llm, registry: buildRegistry(), external: new FixedExternalApis(), loadData: async () => data, env: { transcript: async () => [] }, history: noHistory, demoMode: 'live', primary: { provider: 'local', model: 'keystone-rules-v1' } } };
}
const job = (input: Record<string, unknown> = {}): JobInfo => ({ id: 5n, workflow: 'onboarding_insights', householdId: HH, subjectId: HH, input: { priorities: ['emergency_fund', 'college', 'travel'], risk_comfort: 3, voting_enabled: true, ...input } });
type AlertArg = { id: string; kind: string; severity: string; title: string; detail: string; household_id: string };

describe('onboarding facts and candidate insights', () => {
  it('finds the cushion, the costly card, the subscriptions and the maturing CD from real rows', () => {
    const f = computeFacts(onboarded());
    expect(f.liquid).toBe(30000);
    expect(f.cushion_months).toBeGreaterThan(5);
    expect(f.cards).toEqual([expect.objectContaining({ balance: 3000, apr: 22, limit: 10000 })]);
    expect(f.card_utilization_pct).toBe(30);
    expect(f.subscriptions.count).toBe(3);
    expect(f.subscriptions.monthly).toBeCloseTo(15.49 + 10.99 + 39, 2);
    expect(f.cds).toEqual([{ name: 'Plaid CD', balance: 30000, matures: '2026-12-20' }]);
    const topics = candidateInsights(f).map((c) => c.topic);
    expect(topics).toEqual(expect.arrayContaining(['card_interest', 'subscriptions', 'cd_maturing', 'cushion', 'top_spending', 'net_worth']));
    const card = candidateInsights(f).find((c) => c.topic === 'card_interest')!;
    expect(card.title).toMatch(/\$660 a year/); // 3000 x 22%
    expect(card.severity).toBe('warn');
    // warnings come first
    const sev = candidateInsights(f).map((c) => c.severity);
    expect(sev.indexOf('info')).toBeGreaterThan(sev.lastIndexOf('warn'));
  });

  it('always has at least 3 notes, even before any bank is linked', () => {
    const empty = onboarded({ accounts: [], txns: [], health: [], forecast: [], members: [] });
    const c = candidateInsights(computeFacts(empty), ['home']);
    expect(c.length).toBeGreaterThanOrEqual(3);
    expect(c.map((x) => x.topic)).toEqual(expect.arrayContaining(['connect_bank', 'first_priority']));
    expect(c.find((x) => x.topic === 'first_priority')!.title).toMatch(/home/);
  });

  it('plans a default amount and date per priority, or nothing when there is nothing to base it on', () => {
    const data = onboarded();
    const f = computeFacts(data);
    expect(planGoal('emergency_fund', '', data, f)).toMatchObject({ target_amount: expect.any(Number), target_date: '2028-05-08' });
    expect(planGoal('emergency_fund', '', data, f)!.target_amount).toBeGreaterThan(f.monthly_out * 5);
    expect(planGoal('college', '', data, f)).toMatchObject({ target_amount: 60000 });
    expect(planGoal('college', '', data, f)!.target_date > '2034-01-01').toBe(true); // the 9 year old turns 18 in ~9 years
    expect(planGoal('home', '', data, f)!.target_amount).toBe(57500); // 3 x 82,000 -> a 250,000 home, 23% (20% down + closing)
    expect(planGoal('retirement', '', data, f)).toMatchObject({ current_saved: 0 });
    expect(planGoal('travel', '', data, f)).toMatchObject({ target_amount: 5000 });
    expect(planGoal('debt_payoff', '', data, f)).toMatchObject({ target_amount: 15000 }); // car 12,000 + card 3,000
    expect(planGoal('debt_payoff', '', { ...data, accounts: data.accounts.filter((a) => a.type === 'checking') }, f)).toBeNull();
    expect(planGoal('custom', 'Replace the roof for $8,000', data, f)).toMatchObject({ target_amount: 8000 });
    expect(planGoal('custom', 'Replace the roof for $8k', data, f)).toMatchObject({ target_amount: 8000 });
    expect(planGoal('custom', 'See the world', data, f)).toBeNull();
    expect(planGoal('nonsense', '', data, f)).toBeNull();
  });

  it('suggests a proposal that follows the family\'s priorities and never spends into the last two months of cushion', () => {
    const f = computeFacts(onboarded());
    expect(proposalIdeas(f, ['debt_payoff', 'travel'])[0]).toMatchObject({ id: 'payoff_card', amount: 3000 });
    expect(proposalIdeas(f, ['travel'])[0]).toMatchObject({ id: 'family_trip' });
    expect(proposalIdeas(f, [])[0]).toMatchObject({ id: 'family_outing' });
    const poor = computeFacts(onboarded({ accounts: [acct({ id: 'chk', type: 'checking', balance: 200 })] }));
    for (const i of proposalIdeas(poor, ['travel', 'retirement'])) expect(i.amount).toBeLessThanOrEqual(100);
  });
});

describe('onboarding_insights workflow (local provider)', () => {
  it('writes 3-5 insight alerts, checks the goals, opens one proposal, and traces every step', async () => {
    const { d, sink } = deps(onboarded());
    const out = await runJob(job(), d);
    expect(out).toMatchObject({ status: 'done', replayed: false });

    const alerts = sink.of('createAlert').map((a) => a[0] as AlertArg);
    expect(alerts.length).toBeGreaterThanOrEqual(3);
    expect(alerts.length).toBeLessThanOrEqual(5);
    for (const a of alerts) {
      expect(a).toMatchObject({ kind: 'insight', household_id: HH });
      expect(['info', 'warn']).toContain(a.severity);
      expect(a.id).toMatch(/^agent:hh-onb-test01:insight-/);
      expect(a.title.length).toBeGreaterThan(5);
    }
    expect(new Set(alerts.map((a) => a.id)).size).toBe(alerts.length);

    // goals: the module's rows are updated in place (same ids), with a verdict and an amount
    const goals = sink.of('upsertGoal').map((a) => a[0] as { id: string; feasibility: string; target_amount: number; target_date: string; source: string; title: string; evidence_quote: string });
    expect(goals.map((g) => g.id).sort()).toEqual([`goal_${HH}_college`, `goal_${HH}_custom`, `goal_${HH}_emergency_fund`]);
    for (const g of goals) {
      expect(['on_track', 'stretch', 'off_track']).toContain(g.feasibility);
      expect(g.target_amount).toBeGreaterThan(0);
      expect(g.source).toBe('onboarding');
    }
    const roof = goals.find((g) => g.id.endsWith('_custom'))!;
    expect(roof).toMatchObject({ target_amount: 8000, title: 'Replace the roof for $8,000', evidence_quote: 'Replace the roof for $8,000' });
    expect(goals.find((g) => g.id.endsWith('_college'))!.evidence_quote).toBe('');

    // the first proposal goes through the voting reducer, authored by Keystone, open for a week
    const props = sink.of('createProposal').map((a) => a[0] as { household_id: string; title: string; amount: number; details: Record<string, unknown>; closes_in_days: number; author_name: string });
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ household_id: HH, author_name: 'Keystone', closes_in_days: 7 });
    expect(props[0]!.amount).toBeGreaterThan(0);
    expect(props[0]!.amount).toBeLessThanOrEqual(30000);
    expect(props[0]!.details).toMatchObject({ kind: 'purchase', suggested_by: 'Keystone onboarding' });

    // trace: plan first, real tool calls, goal checks, a final, provider + model everywhere
    const types = sink.traces.map((t) => t.type);
    expect(types.slice(0, 2)).toEqual(['run_started', 'plan']);
    expect(types.at(-1)).toBe('final');
    expect(types).not.toContain('error');
    const tools = sink.traces.filter((t) => t.type === 'tool_call').map((t) => (JSON.parse(t.dataJson) as { tool: string }).tool);
    expect(tools).toEqual(['get_accounts', 'get_health_indicators', 'get_transactions', 'get_forecast', 'goal_feasibility', 'goal_feasibility', 'goal_feasibility']);
    expect(new Set(sink.traces.map((t) => t.agent))).toEqual(new Set(['planner', 'analyst', 'insight_writer', 'goal_planner', 'proposal_scout']));
    expect(sink.traces.every((t) => t.provider === 'local' && t.model)).toBe(true);
    for (const t of sink.traces) expect(t.dataJson.length).toBeLessThanOrEqual(4096);
    expect(sink.traces.some((t) => /Assuming .* for "Save for college"/.test(t.title))).toBe(true);
    expect(sink.of('finishRun')[0]![1]).toBe('done');
  });

  it('is idempotent: a second run uses the same alert and goal ids', async () => {
    const a = deps(onboarded());
    const b = deps(onboarded());
    await runJob(job(), a.d);
    await runJob(job(), b.d);
    const ids = (s: MemorySink) => s.of('createAlert').map((x) => (x[0] as AlertArg).id).sort();
    expect(ids(a.sink)).toEqual(ids(b.sink));
  });

  it('respects "family voting off": no proposal is opened', async () => {
    const { d, sink } = deps(onboarded());
    await runJob(job({ voting_enabled: false }), d);
    expect(sink.of('createProposal')).toHaveLength(0);
    expect(sink.traces.some((t) => /voting is switched off/.test(t.title))).toBe(true);
    expect(sink.of('createAlert').length).toBeGreaterThanOrEqual(3);
  });

  it('works for a household with no bank: starter notes, no crash, goals without an amount are left alone', async () => {
    const empty = onboarded({ accounts: [], txns: [], health: [], forecast: [], goals: [{ id: `goal_${HH}_custom`, title: 'See the world', target_amount: 0, target_date: '', priority: 1, feasibility: '' }] });
    const { d, sink } = deps(empty);
    const out = await runJob(job({ priorities: [] }), d);
    expect(out.status).toBe('done');
    expect(sink.of('createAlert').length).toBeGreaterThanOrEqual(3);
    expect(sink.of('upsertGoal')).toHaveLength(0);
    expect(sink.traces.some((t) => /no amount to check/.test(t.title))).toBe(true);
    expect(sink.of('createProposal')).toHaveLength(1); // the harmless family outing
  });

  it('a model that invents topics or answers with too few insights cannot leave the family with fewer than 3 real ones', async () => {
    const local = new LocalProvider();
    const scripted: LLMProvider = {
      id: 'nvidia',
      modelFor: () => 'nvidia/nemotron-3-super-120b-a12b',
      async call(req: ChatRequest): Promise<ChatResult> {
        if (req.task === 'onboarding.insights') {
          const args = { insights: [{ topic: 'made_up', title: 'You are rich beyond measure', detail: 'Invented numbers: $9,999,999.' }, { topic: 'cushion', title: 'Cash cushion is strong', detail: 'About five months of spending in cash.' }, { topic: 'cushion', title: 'Duplicate topic', detail: 'Should be ignored entirely.' }] };
          return { content: '', toolCalls: [{ id: 'c1', name: 'write_insights', arguments: JSON.stringify(args) }], provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', latencyMs: 80, tokensIn: 10, tokensOut: 10 };
        }
        return local.call(req);
      },
    };
    const { d, sink } = deps(onboarded(), new LLMClient([scripted]));
    await runJob(job(), d);
    const alerts = sink.of('createAlert').map((a) => a[0] as AlertArg);
    expect(alerts.length).toBeGreaterThanOrEqual(3);
    expect(alerts.some((a) => /made.up|rich beyond/.test(a.id + a.title))).toBe(false);
    expect(alerts.find((a) => a.id.endsWith('insight-cushion'))!.title).toBe('Cash cushion is strong'); // the model's wording of a real topic is kept
    expect(alerts.filter((a) => a.id.endsWith('insight-cushion'))).toHaveLength(1);
    const msg = sink.traces.find((t) => /Nemotron worded/.test(t.title));
    expect(msg).toMatchObject({ provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b' });
  });

  it('is registered as a workflow', () => {
    expect(workflowNames()).toContain('onboarding_insights');
  });
});

describe('custom sandbox user file', () => {
  it('resolves next to the seed dir, honours overrides, and returns compact JSON or null', () => {
    expect(sandboxUserPath({}).replace(/\\/g, '/')).toMatch(/\/data\/plaid\/sandbox_user\.json$/);
    expect(sandboxUserPath({ DATA_DIR: '/data/seed' })).toBe('/data/plaid/sandbox_user.json');
    const dir = mkdtempSync(join(tmpdir(), 'keystone-plaid-'));
    const ok = join(dir, 'u.json');
    writeFileSync(ok, '{\n  "override_accounts": [ {"type": "depository"} ]\n}\n');
    expect(loadSandboxUserJson({ PLAID_SANDBOX_USER_FILE: ok })).toBe('{"override_accounts":[{"type":"depository"}]}');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{nope');
    expect(loadSandboxUserJson({ PLAID_SANDBOX_USER_FILE: bad })).toBeNull();
    expect(loadSandboxUserJson({ PLAID_SANDBOX_USER_FILE: join(dir, 'missing.json') })).toBeNull();
  });
});
