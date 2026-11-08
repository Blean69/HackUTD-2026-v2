// Regression tests for the judge-style review of the live site (bug ids D-03 .. D-23, P-05 .. P-19). Local provider, no keys,
// no database: the Rivera seed household plus the recompute's cash_flow row as the dashboard shows it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunHistory } from '../agent/cache.js';
import { RunContext } from '../agent/run.js';
import { runJob, type RunnerDeps } from '../agent/runner.js';
import { MemorySink } from '../agent/sink.js';
import { loadConfig } from '../config.js';
import { buildLLMClient } from '../llm/client.js';
import { composeCoachAnswer } from '../llm/local.js';
import { debtScopeHint, parseScenarioPrompt, spendingCutMonthly, statedMonthOffset } from '../llm/rules.js';
import { acct, seedAvailable, seedHousehold, smallHousehold } from '../testing/fixtures.js';
import { alignCreditIndicator } from '../tools/credit.js';
import { FixedExternalApis } from '../tools/external.js';
import { goalFeasibility, monthlyCapacity } from '../tools/feasibility.js';
import { cashFlow } from '../tools/finance.js';
import { buildRegistry, parseToolArgs } from '../tools/index.js';
import { detectScamSignals } from '../tools/scam.js';
import { simulate } from '../tools/simulate.js';
import type { HouseholdData, ProposalItem } from '../types.js';
import { adviceFacts } from './advice_guard.js';
import { plainChat } from './coach.js';
import { unmatchedNote } from './grounding.js';
import { debtForGoal, monthlyPlan } from './huddle.js';
import type { JobInfo } from './types.js';
import { refineScenario } from './what_if.js';
import { z } from 'zod';

const SEED = join(new URL('.', import.meta.url).pathname, '../../../../data/seed');
const noHistory: RunHistory = { findCompletedRun: async () => null, traceEvents: async () => [] };
const RIVERA_FLOW = { as_of: '2026-11-07', window_days: 90, income_monthly: 13363, expense_monthly: 12186, net_monthly: 1177, savings_rate: 8.8, categories: [{ category: 'groceries', total: 4500 }, { category: 'dining', total: 1200 }] };

/** Rivera as the worker loads it in production: seed rows + the dashboard's cash_flow row + the open family vote with its details. */
function rivera(over: Partial<HouseholdData> = {}): HouseholdData {
  const props = (JSON.parse(readFileSync(join(SEED, 'proposals.json'), 'utf8')) as { id: string; household_id: string; title: string; amount: number; details: Record<string, unknown>; created_by_name: string; status: string }[])
    .filter((p) => p.household_id === 'hh_rivera')
    .map((p): ProposalItem => ({ id: p.id, title: p.title, amount: p.amount, status: p.status, verdict: '', closes_at: '', created_by_name: p.created_by_name, created_at: '', details: p.details }));
  return { ...seedHousehold('hh_rivera'), cash_flow: RIVERA_FLOW, proposals: props, ...over };
}

function deps(data: HouseholdData, lines: { speaker: string; text: string }[] = []): { d: RunnerDeps; sink: MemorySink } {
  const sink = new MemorySink();
  return { sink, d: { sink, llm: buildLLMClient(loadConfig({})), registry: buildRegistry(), external: new FixedExternalApis(), loadData: async () => data, env: { transcript: async () => lines }, history: noHistory, demoMode: 'live', primary: { provider: 'local', model: 'keystone-rules-v1' } } };
}
const whatIfJob = (prompt: string, hh = 'hh_rivera'): JobInfo => ({ id: 1n, workflow: 'what_if', householdId: hh, subjectId: 'scn_1', input: { scenario_id: 'scn_1', prompt } });
async function whatIf(prompt: string, data = rivera()) {
  const { d, sink } = deps(data);
  const out = await runJob(whatIfJob(prompt, data.household.id), d);
  const result = JSON.parse(String(sink.of('updateScenario').at(-1)![2]));
  return { out, sink, result };
}
const metric = (r: { metrics: { label: string; before?: number; after: number }[] }, label: string) => r.metrics.find((m) => m.label === label);

describe.skipIf(!seedAvailable())('D-03 what-if verdicts (Rivera)', () => {
  it('a loan-financed second location spends the loan on the project and matches the family vote: same payment, Risky', async () => {
    const { result } = await whatIf('Open a second bakery location with a $250,000 loan');
    expect(result.scenario).toMatchObject({ kind: 'new_loan', amount: 250000, apr_pct: 10.75, term_months: 120, proceeds_to_cash: false });
    expect(result.verdict).toBe('risky');
    const pay = metric(result, 'New monthly payment')!.after;
    expect(pay).toBeCloseTo(3408.4, 0);
    // proceeds in, price out: nothing lands in cash, so month 0 equals today's cash
    expect(result.series[0].scenario).toBeCloseTo(40109.07, 1);
    expect(result.assumptions.join(' ')).toMatch(/family vote/);

    // the vote on the same decision runs the same simulation: same payment, same verdict
    const p = rivera().proposals![0]!;
    const { d, sink } = deps(rivera());
    await runJob({ id: 2n, workflow: 'what_if', householdId: 'hh_rivera', subjectId: p.id, input: { proposal_id: p.id, title: p.title, amount: p.amount, details: p.details, created_by: 'Marisol' } }, d);
    const [, verdict, json] = sink.of('updateProposal')[0] as string[];
    const analysis = JSON.parse(json!);
    expect(verdict).toBe('risky');
    expect(metric(analysis, 'New monthly payment')!.after).toBe(pay);
    // P-13: a 120-month loan with a permanent shortfall keeps falling; no arbitrary "month 24 low"
    expect(analysis.headline).toMatch(/run out around .* and keep falling by about \$2,231 a month/);
    expect(analysis.metrics.map((m: { label: string }) => m.label)).not.toContain('Lowest cash balance');
    // D-23: the household's cash flow is never called the bakery's income
    expect(analysis.summary).toMatch(/your household's monthly cash flow of \$1,177/);
  });

  it('the chip without an amount ("Open a second bakery location") takes the vote\'s amount and terms', async () => {
    const { result } = await whatIf('Open a second bakery location');
    expect(result.scenario).toMatchObject({ kind: 'new_loan', amount: 250000, apr_pct: 10.75, term_months: 120 });
    expect(result.verdict).toBe('risky');
  });

  it('a financed purchase: the loan pays the rest of the price, only the down payment leaves cash, plus the payment', () => {
    const r = simulate({ kind: 'purchase', amount: 30000, financed: true, down_payment: 3000, apr_pct: 6, term_months: 60, months: 12 }, rivera());
    expect(r.effect.upfront_cash).toBe(-3000);
    expect(r.series[0]!.scenario).toBeCloseTo(40109.07 - 3000, 1);
    expect(r.series[1]!.scenario - r.series[1]!.baseline).toBeCloseTo(-3000 - r.effect.monthly_payment!, 1);
    // a bare new_loan no longer lands its proceeds in cash
    const loan = simulate({ kind: 'new_loan', amount: 50000 }, rivera());
    expect(loan.effect.upfront_cash).toBe(0);
    expect(loan.effect.monthly_payment).toBeCloseTo(1013.82, 1); // the shared defaults: 8% over 60 months
  });

  it('"Pay off all debt ($271,000)" sums every debt and is Risky with $40,109 of cash', async () => {
    const { result } = await whatIf('Pay off all debt ($271,000)');
    expect(result.scenario).toMatchObject({ kind: 'payoff', account_hint: 'all' });
    expect(result.verdict).toBe('risky');
    expect(result.headline).toMatch(/needs \$270,709 now but checking and savings would hold about \$40,109, so you would be \$230,600 short right away/);
    expect(metric(result, 'Months of spending covered at the low point (cash runs out)')!.after).toBe(0);
  });

  it('"pay off all of our loans and the credit card this month" covers all four debts, not just the card', () => {
    expect(debtScopeHint('pay off all of our loans and the credit card this month')).toBe('all');
    const { scn } = refineScenario('pay off all of our loans and the credit card this month', { kind: 'payoff', account_hint: 'credit_card', amount: 1558.81 }, rivera());
    expect(scn).toMatchObject({ kind: 'payoff', account_hint: 'all' });
    expect(scn.amount).toBeUndefined();
    const r = simulate(scn, rivera());
    expect(r.effect.upfront_cash).toBeCloseTo(-270708.8, 1);
    expect(r.assumptions.join(' ')).toMatch(/Pay off 4 debts in full now/);
    expect(r.verdict).toBe('shortfall');
    expect(debtScopeHint('pay off all our credit cards')).toBe('all cards');
    expect(simulate({ kind: 'payoff', account_hint: 'all cards' }, rivera()).effect.upfront_cash).toBeCloseTo(-(1558.81 + 2049.99), 1);
  });

  it('"gamble all of our cash" is not advised, with the reason, never "Works comfortably"', async () => {
    const { result } = await whatIf('gamble all of our cash');
    expect(result.verdict).toBe('risky');
    expect(result.advice).toBe('not_advised');
    expect(result.summary).toMatch(/not advised\. Gambling is not a plan/);
    expect(result.suggestion).not.toMatch(/bet|gamble/i);
  });

  it('a question the parser cannot map to a change asks to rephrase instead of saying "fine"', async () => {
    const { result } = await whatIf('What about the thing we talked about?');
    expect(result.verdict).toBe('unclear');
    expect(result.summary).toMatch(/could not tell what change/);
    expect(result.metrics).toEqual([]);
    expect(result.series).toEqual([]);
  });

  it('"Buy a $30,000 car with cash in January" happens in January, not today', async () => {
    expect(statedMonthOffset('Buy a $30,000 car with cash in January', '2026-11-08')).toBe(2);
    expect(statedMonthOffset('Pay off the Visa by March', '2026-11-08')).toBeNull(); // a deadline, not a start
    const { result } = await whatIf('Buy a $30,000 car with cash in January');
    expect(result.scenario).toMatchObject({ kind: 'purchase', amount: 30000, start_month: 2 });
    expect(result.scenario.financed).toBeFalsy();
    expect(result.series[1].scenario).toBe(result.series[1].baseline); // nothing spent before January
    expect(result.series[2].scenario - result.series[2].baseline).toBeCloseTo(-30000, 0);
    expect(result.assumptions.join(' ')).toMatch(/in January 2027/);
  });

  it('months covered is never negative', () => {
    const r = simulate({ kind: 'purchase', amount: 90000, financed: false }, rivera());
    expect(r.months_of_spending_covered_at_low).toBe(0);
    expect(r.runs_out).toMatchObject({ month: 0 });
  });

  it('P-05: "Cancel cable and gym to save $150 a month" is a $150 spending cut that improves cash flow', async () => {
    expect(spendingCutMonthly('Cancel cable and gym to save $150 a month')).toBe(-150);
    expect(spendingCutMonthly('What if our income drops $500 a month?')).toBeNull();
    expect(spendingCutMonthly('Save $500 a month for college')).toBeNull();
    expect(parseScenarioPrompt('Cancel cable and gym to save $150 a month')).toMatchObject({ kind: 'spending_change', spending_change_monthly: -150 });
    // even when the model reads it as lost income
    const { scn } = refineScenario('Cancel cable and gym to save $150 a month', { kind: 'income_change', income_change_monthly: -150 }, rivera());
    expect(scn).toMatchObject({ kind: 'spending_change', spending_change_monthly: -150 });
    const { result } = await whatIf('Cancel cable and gym to save $150 a month');
    const flow = metric(result, 'Monthly cash flow')!;
    expect(flow.before).toBe(1177);
    expect(flow.after).toBe(1327);
    expect(result.assumptions.join(' ')).toMatch(/spending drops by \$150/);
  });
});

describe.skipIf(!seedAvailable())('D-04 one monthly surplus everywhere (the dashboard\'s cash_flow row)', () => {
  it('Rivera: what-if, vote, goal feasibility, coach facts and Table Mode all say +$1,177 a month', () => {
    const data = rivera();
    expect(cashFlow(data)).toMatchObject({ monthly_in: 13363, monthly_out: 12186, monthly_net: 1177, origin: 'cash_flow' });
    expect(simulate({ kind: 'purchase', amount: 100 }, data).baseline.monthly_net).toBe(1177);
    expect(monthlyCapacity(data)).toMatchObject({ surplus: 1177, net: 1177 });
    expect(goalFeasibility({ target_amount: 50000, target_date: '2028-11-07' }, data).available_monthly).toBe(1177);
    const run = { data } as unknown as RunContext;
    expect(adviceFacts(run)).toMatchObject({ monthly_surplus: 1177, monthly_cash_flow: 1177 });
  });

  it('without the row (tests, an older module) it falls back to the ledger', () => {
    expect(cashFlow(smallHousehold()).origin).toBe('ledger');
    expect(cashFlow(smallHousehold()).monthly_net).toBeGreaterThan(0);
  });

  it('a negative cash flow is never shown as a surplus', () => {
    const data = smallHousehold({ cash_flow: { ...RIVERA_FLOW, net_monthly: -300 } });
    expect(monthlyCapacity(data)).toMatchObject({ surplus: 0, net: -300 });
  });

  it('a goal checked against what is left after earlier goals says so, never "the surplus"', () => {
    const r = goalFeasibility({ target_amount: 10000, target_date: '2027-11-07', current_saved: 0, monthly_contribution: 400 }, rivera());
    expect(r.explanation).toMatch(/\$400\/mo is available for it/);
    expect(goalFeasibility({ target_amount: 10000, target_date: '2027-11-07', current_saved: 0 }, rivera()).explanation).toMatch(/the monthly surplus is \$1,177\/mo/);
  });
});

describe('D-05 credit scores are the simulated ones (the Credit page)', () => {
  const scores = [
    { member_id: 'mem_rivera_marisol', score: 692, band: 'good', factors: [] },
    { member_id: 'mem_rivera_daniel', score: 697, band: 'good', factors: [] },
    { member_id: 'mem_rivera_elena', score: 735, band: 'good', factors: [] },
  ];
  const rawIndicator = { key: 'credit_score', label: 'Credit score', value: 726, unit: 'score', status: 'watch', explanation: 'Average score 726 across 3 credit files; 0 late payments in 24 months, 3 hard inquiries in 12.' };

  it.skipIf(!seedAvailable())('get_credit_profiles and get_health_indicators never return the raw bureau score', async () => {
    const data = rivera({ credit_scores: scores, health: [rawIndicator] });
    const reg = buildRegistry();
    const ctx = { data, external: new FixedExternalApis() };
    const prof = await reg.execute('get_credit_profiles', {}, ctx);
    const text = JSON.stringify(prof.ok && prof.result);
    expect(text).not.toMatch(/741|"score"/);
    expect(prof.ok && prof.summary).toBe('Simulated scores: Marisol 692, Daniel 697, Elena 735');
    expect((prof.ok && (prof.result as { profiles: { profile_factors?: { hard_inquiries_last_12_months: number } }[] }).profiles[0]!.profile_factors)).toHaveProperty('hard_inquiries_last_12_months');
    const health = await reg.execute('get_health_indicators', {}, ctx);
    if (!health.ok) throw new Error(health.error);
    const ind = (health.result as { indicators: { key: string; value: number; explanation: string }[] }).indicators.find((i) => i.key === 'credit_score')!;
    expect(ind.value).toBe(708);
    expect(ind.explanation).toMatch(/^Simulated scores on the Credit page: Daniel 697 \(good\), Elena 735 \(good\), Marisol 692 \(good\); average 708/);
    expect(ind.explanation).not.toMatch(/726|inquir/);
    // the offline coach answer speaks the same scores
    expect(composeCoachAnswer('credit?', [{ name: 'get_credit_profiles', result: prof.ok ? prof.result : {} }])).toMatch(/Marisol Rivera 692/);
  });

  it('without simulated scores the indicator is left as it is (and aligning twice changes nothing)', () => {
    expect(alignCreditIndicator([rawIndicator], [], [])).toEqual([rawIndicator]);
    const once = alignCreditIndicator([rawIndicator], scores, [{ id: 'mem_rivera_marisol', name: 'Marisol Rivera' }]);
    expect(alignCreditIndicator(once, scores, [])).toEqual(once);
  });
});

describe('D-07 out-of-range tool arguments are clamped, not rejected', () => {
  const reg = buildRegistry();
  const ctx = { data: smallHousehold(), external: new FixedExternalApis() };
  it('get_transactions with limit 100 runs with the maximum (40) and says it was adjusted', async () => {
    const r = await reg.execute('get_transactions', { limit: 100 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.result as { transactions: unknown[] }).transactions.length).toBeLessThanOrEqual(40);
      expect(r.adjusted).toEqual(['limit: 100 -> 40']);
    }
    expect((await reg.execute('get_transactions', { limit: 0 }, ctx)).ok).toBe(true);
    expect((await reg.execute('detect_transaction_anomalies', { limit: 500 }, ctx)).ok).toBe(true);
  });
  it('fixes numbers sent as strings, floats where an integer is needed, too-long labels; still rejects real garbage', () => {
    const s = z.object({ n: z.number().int().max(10), label: z.string().max(5).optional(), flag: z.boolean().optional() });
    expect(parseToolArgs(s, { n: '12.6', label: 'abcdefgh', flag: 'true' })).toMatchObject({ success: true, data: { n: 10, label: 'abcde', flag: true } });
    expect(parseToolArgs(s, { n: 'lots' }).success).toBe(false);
    expect(parseToolArgs(z.object({ x: z.number().lt(10) }), { x: 20 })).toMatchObject({ success: true, data: { x: 9 } });
  });
  it('the offline coach uses the anomaly findings it got', () => {
    const answer = composeCoachAnswer('Is anything suspicious on our accounts?', [
      { name: 'get_transactions', result: { error: 'invalid arguments' } },
      { name: 'detect_transaction_anomalies', result: { counts: { outlier: 2 }, findings: [{ merchant: 'Best Buy', amount: -1900, date: '2026-10-25' }, { merchant: 'Costco', amount: -900, date: '2026-10-20' }] } },
    ]);
    expect(answer).toMatch(/2 transactions worth a look, for example Best Buy/);
    expect(answer).not.toMatch(/get_transactions|invalid arguments/);
  });
});

describe('D-10 debt goals find their balance by nickname or by type', () => {
  const visa = acct({ id: 'v', type: 'credit_card', nickname: 'Rewards Visa', balance: 1558.81 });
  const mc = acct({ id: 'm', type: 'credit_card', nickname: 'Gas Rewards Mastercard', balance: 2049.99 });
  const truck = acct({ id: 't', type: 'auto_loan', nickname: "Daniel's F-150 Loan", balance: 19800 });
  const home = acct({ id: 'h', type: 'mortgage', nickname: 'Trinity Federal', balance: 247300 });
  const student = acct({ id: 's', type: 'personal_loan', nickname: 'Student loan (Nelnet)', balance: 8200 });
  it('matches the nickname, then the type; several cards = the largest, and the note says which', () => {
    expect(debtForGoal('Pay off the Visa by March', [visa, mc, truck])?.account.id).toBe('v');
    expect(debtForGoal('pay off the credit card', [acct({ id: 'c', type: 'credit_card', nickname: 'Platinum', balance: 1755 })])).toMatchObject({ account: { id: 'c' }, note: 'Platinum balance today: $1,755' });
    expect(debtForGoal('Pay off the credit card', [visa, mc])).toMatchObject({ account: { id: 'm' }, note: 'Gas Rewards Mastercard is the largest of your 2 cards: balance today $2,050' });
    expect(debtForGoal('Pay off the truck early', [visa, truck])?.account.id).toBe('t');
    expect(debtForGoal('Get the car loan paid off', [visa, truck])?.account.id).toBe('t');
    expect(debtForGoal('Pay off the house', [visa, home])?.account.id).toBe('h');
    expect(debtForGoal('Pay off my student loan', [visa, student])?.account.id).toBe('s');
    expect(debtForGoal('Save for a trip', [visa])).toBeNull();
  });
  it('a Table Mode "pay off the credit card" goal gets the card balance instead of "Needs an amount"', async () => {
    const data = smallHousehold({ accounts: [...smallHousehold().accounts.filter((a) => a.type !== 'credit_card'), acct({ id: 'card', type: 'credit_card', nickname: 'Platinum', balance: 1755 })] });
    const { d, sink } = deps(data, [{ speaker: 'Marcus', text: 'We need to pay off the credit card before the holidays.' }]);
    await runJob({ id: 1n, workflow: 'huddle', householdId: 'hh_test', subjectId: 'hud_1', input: {} }, d);
    const goals = sink.of('upsertGoal').map((g) => g[0] as { title: string; target_amount: number; feasibility: string });
    expect(goals.find((g) => /debt|card/i.test(g.title))).toMatchObject({ target_amount: 1755 });
    expect(goals.every((g) => g.feasibility !== 'needs_details')).toBe(true);
    expect(sink.traces.some((t) => /Check: 0 of 0/.test(t.title))).toBe(false);
  });
});

describe('D-11 a stated monthly plan is kept', () => {
  it('"start a college fund for the kids, $200 a month" keeps its name, gets no tuition target and is checked as $200 a month', async () => {
    expect(monthlyPlan('start a college fund for the kids, $200 a month')).toBe(200);
    expect(monthlyPlan('the bakery brings in $13,000 a month')).toBeNull();
    const { d, sink } = deps(smallHousehold(), [{ speaker: 'Ana', text: "Let's start a college fund for the kids, $200 a month." }]);
    await runJob({ id: 1n, workflow: 'huddle', householdId: 'hh_test', subjectId: 'hud_2', input: {} }, d);
    const goal = sink.of('upsertGoal').map((g) => g[0] as { title: string; target_amount: number; feasibility: string }).find((g) => /college/i.test(g.title))!;
    expect(goal.title).not.toMatch(/4 years|University/);
    expect(goal.target_amount).toBe(2400); // their plan for the first year, not 4 years of tuition
    expect(goal.feasibility).toBe('on_track');
    const posted = sink.traces.find((t) => /Posted goal card/.test(t.title) && /college/i.test(t.title))!;
    expect(posted.dataJson).toMatch(/Your plan: \$200 a month/);
    expect(posted.dataJson).toMatch(/For reference, The University of Texas at Dallas costs about/);
  });
});

describe('D-17 / D-18 / D-06 words people read', () => {
  it('scam, anomaly, bills, kids and account summaries are plain English with real plurals', async () => {
    const data = smallHousehold();
    const s = detectScamSignals({ text: 'Wire the money right now, today only.' }, data);
    expect(s.summary).toBe('2 scam warning signs: a request for a wire, cash app or crypto payment and pressure to act right now.');
    const reg = buildRegistry();
    const ctx = { data, external: new FixedExternalApis() };
    const acc = await reg.execute('get_accounts', { type: 'all' }, ctx);
    expect(acc.ok && (acc.result as { count: number }).count).toBe(4); // P-09: "all" is no filter
    expect(reg.describeCall('get_accounts', { type: 'all' })).toBe('Reading all accounts');
    expect(reg.describeCall('get_accounts', { type: 'credit_card' })).toBe('Reading credit card accounts');
    const one = await reg.execute('get_accounts', { type: 'savings' }, ctx);
    expect(one.ok && one.summary).toMatch(/^1 account,/);
    const obl = await reg.execute('get_obligations', { kind: 'all' }, ctx);
    expect(obl.ok && (obl.result as { count: number }).count).toBe(1);
    expect(obl.ok && obl.summary).toBe('1 bill or payment totalling $1,500 a month');
    const bills = await reg.execute('find_savings', {}, ctx);
    expect(bills.ok && bills.summary).toMatch(/^No bills to cut/);
    const fred = reg.describeCall('fred_series', { series_id: 'TERMCBCCALLNS' });
    expect(fred).toBe("Looking up today's credit card interest rates (Federal Reserve data)");
    for (const t of [s.summary, acc.ok && acc.summary, obl.ok && obl.summary, bills.ok && bills.summary, fred]) expect(String(t)).not.toMatch(/\(s\)|_/);
  });
  it('the Ask answer is plain chat: no tables, headings, rules, backticks or tool names', () => {
    const md = '## Your bills\n\n| Bill | Amount |\n|---|---|\n| Netflix | $15.49 |\n| Spotify | $16.99 |\n\n---\nI checked `get_obligations` (get_obligations) and the find_savings tool.\n* one more';
    const out = plainChat(md);
    expect(out).toBe('**Your bills**\n\n- Netflix: $15.49\n- Spotify: $16.99\n\nI checked your bills and the review of your bills.\n- one more');
  });
  it('the grounding footnote reads plainly', () => {
    expect(unmatchedNote(['$70'])).toBe("I couldn't match $70 to your data, so treat it as an estimate.");
    expect(unmatchedNote(['$70', '5%'])).toBe("I couldn't match $70 and 5% to your data, so treat them as estimates.");
  });
});
