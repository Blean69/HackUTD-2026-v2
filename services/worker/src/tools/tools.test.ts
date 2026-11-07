import { describe, expect, it } from 'vitest';
import { acct, smallHousehold, txn } from '../testing/fixtures.js';
import { fitJson } from '../util.js';
import { detectAnomalies } from './anomalies.js';
import { FixedExternalApis } from './external.js';
import { goalFeasibility } from './feasibility.js';
import { cashFlow, liquidBalance } from './finance.js';
import { buildRegistry } from './index.js';
import { detectScamSignals } from './scam.js';
import { simulate } from './simulate.js';

const ctx = (data = smallHousehold()) => ({ data, external: new FixedExternalApis() });

describe('cash flow', () => {
  it('measures monthly income and spending on liquid accounts, ignoring transfers', () => {
    const f = cashFlow(smallHousehold());
    expect(f.monthly_in).toBeGreaterThan(4500);
    expect(f.monthly_in).toBeLessThan(6200);
    expect(f.monthly_net).toBeGreaterThan(0);
    expect(f.top_outflow_categories[0]?.category).toBe('rent');
    expect(liquidBalance(smallHousehold())).toBe(30000);
  });
});

describe('simulate_scenario', () => {
  const data = smallHousehold();
  it('financed purchase: down payment up front, monthly payment, interest', () => {
    const r = simulate({ kind: 'purchase', amount: 32000, down_payment: 3200, apr_pct: 6.5, term_months: 60, months: 24 }, data);
    expect(r.effect.upfront_cash).toBe(-3200);
    expect(r.effect.monthly_payment).toBeCloseTo(563.5, 0);
    expect(r.effect.total_interest).toBeGreaterThan(4000);
    expect(r.months).toBe(24);
    expect(r.series).toHaveLength(25);
    expect(r.ending.scenario).toBeLessThan(r.ending.baseline);
  });
  it('clamps the horizon to 12-24 months', () => {
    expect(simulate({ kind: 'purchase', amount: 100, months: 3 }, data).months).toBe(12);
    expect(simulate({ kind: 'purchase', amount: 100, months: 60 }, data).months).toBe(24);
  });
  it('cash purchase bigger than savings is a shortfall', () => {
    const r = simulate({ kind: 'purchase', amount: 45000, financed: false }, data);
    expect(r.verdict).toBe('shortfall');
    expect(r.lowest.balance).toBeLessThan(0);
  });
  it('income drop lasts only for duration_months', () => {
    const r = simulate({ kind: 'income_change', income_change_pct: -50, duration_months: 3, months: 12 }, data);
    expect(r.effect.monthly_change).toBe(0); // recovered by month 12
    expect(r.ending.difference).toBeLessThan(0);
  });
  it('payoff removes the monthly payment and saves interest', () => {
    const r = simulate({ kind: 'payoff', account_hint: 'auto_loan' }, data);
    expect(r.effect.upfront_cash).toBe(-12000);
    expect(r.effect.interest_saved).toBeGreaterThan(300);
    expect(r.series[12]!.scenario - r.series[12]!.baseline).toBeCloseTo(-12000 + 12 * 450, 0);
  });
  it('rate change adds interest on variable-rate debt', () => {
    const r = simulate({ kind: 'rate_change', rate_delta_pct: 2 }, data);
    expect(r.effect.monthly_change).toBeLessThan(0);
    expect(r.effect.total_interest).toBeGreaterThan(0);
  });
});

describe('goal_feasibility', () => {
  const data = smallHousehold();
  it('on_track when savings already cover it', () => {
    expect(goalFeasibility({ target_amount: 8000, target_date: '2027-11-07' }, data).feasibility).toBe('on_track');
  });
  it('stretch vs off_track depends on the share of the required monthly amount', () => {
    const base = { target_amount: 50000, target_date: '2027-11-07', current_saved: 10000 };
    const need = goalFeasibility({ ...base, monthly_contribution: 0 }, data).required_monthly;
    expect(goalFeasibility({ ...base, monthly_contribution: need * 0.7 }, data).feasibility).toBe('stretch');
    expect(goalFeasibility({ ...base, monthly_contribution: need * 0.2 }, data).feasibility).toBe('off_track');
    expect(goalFeasibility({ ...base, monthly_contribution: need * 1.1 }, data).feasibility).toBe('on_track');
  });
  it('reports numbers, not just a label', () => {
    const r = goalFeasibility({ target_amount: 250000, target_date: '2027-09-30' }, data);
    expect(r.months_left).toBeGreaterThan(10);
    expect(r.required_monthly).toBeGreaterThan(r.available_monthly);
    expect(r.explanation).toMatch(/\$/);
  });
});

describe('detect_transaction_anomalies', () => {
  it('finds duplicates, garbled merchants, impossible values, card testing, scam payments and outliers', () => {
    const base = smallHousehold();
    const extra = [
      txn({ id: 'dup1', date: '2026-10-20', amount: -24.05, merchant: 'Chipotle', category: 'dining' }),
      txn({ id: 'dup2', date: '2026-10-20', amount: -24.05, merchant: 'Chipotle', category: 'dining' }),
      txn({ id: 'garb', date: '2026-10-21', amount: -12, merchant: 'Ra$sing Ca@†\'s' }),
      txn({ id: 'imp', date: '2026-10-22', amount: -10_000_000, merchant: 'Starbucks', category: 'dining' }),
      ...Array.from({ length: 6 }, (_v, i) => txn({ id: `ct${i}`, date: '2026-10-23', amount: -0.5 - i * 0.1, merchant: 'TMRW PAY 7731' })),
      txn({ id: 'gift', date: '2026-10-24', amount: -500, merchant: 'Target', category: 'gift_cards', description: 'GIFT CARD PURCHASE' }),
      txn({ id: 'big', date: '2026-10-25', amount: -1900, merchant: 'Kroger', category: 'groceries' }),
    ];
    const r = detectAnomalies({ ...base, txns: [...base.txns, ...extra] });
    const rule = (id: string) => r.findings.find((f) => f.txn_id === id)?.rule;
    expect(rule('dup2')).toBe('duplicate');
    expect(rule('garb')).toBe('garbled');
    expect(rule('imp')).toBe('impossible_value');
    expect(rule('ct3')).toBe('card_testing');
    expect(rule('gift')).toBe('scam_payment');
    expect(rule('big')).toBe('outlier');
    expect(r.findings[0]!.severity).toBe('critical');
  });
  it('never touches ground truth: transactions have no anomaly field and output cannot depend on one', () => {
    const t = txn({ id: 'x', date: '2026-10-01', amount: -5 }) as unknown as Record<string, unknown>;
    expect('anomaly' in t || 'anomaly_truth' in t).toBe(false);
    const a = detectAnomalies(smallHousehold());
    const b = detectAnomalies({ ...smallHousehold(), txns: smallHousehold().txns.map((x) => ({ ...x, anomaly: 'scam_payment' }) as typeof x) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('a clean ledger has no findings', () => {
    expect(detectAnomalies(smallHousehold()).findings).toHaveLength(0);
  });
});

describe('detect_scam_signals', () => {
  const data = smallHousehold({
    txns: [
      ...smallHousehold().txns,
      ...[1, 2, 3, 4].map((i) => txn({ id: `gc${i}`, date: `2026-10-2${i}`, amount: -500, merchant: ['Target', 'Walmart', 'CVS', 'Kroger'][i - 1]!, category: 'gift_cards', description: 'APPLE GIFT CARD' })),
    ],
  });
  it('flags a grandchild-in-jail call and links the gift-card purchases', () => {
    const r = detectScamSignals(
      { lines: [{ speaker: 'Linh', text: 'A man called saying our grandson was in jail and needed bail money right now. He said do not tell his parents. We had to buy gift cards and read him the numbers.' }] },
      data,
    );
    expect(r.risk).toBe('high');
    expect(r.signal_types).toEqual(expect.arrayContaining(['gift_cards', 'bail_or_jail', 'family_in_trouble', 'secrecy', 'urgency']));
    expect(r.linked_transactions).toHaveLength(4);
    expect(r.linked_total).toBe(2000);
    expect(r.signals[0]?.speaker).toBe('Linh');
  });
  it('an ordinary budgeting chat is not a scam', () => {
    const r = detectScamSignals({ text: 'We want to save for college and look at the mortgage rate next spring.' }, smallHousehold());
    expect(r.risk).toBe('none');
  });
});

describe('registry', () => {
  const reg = buildRegistry();
  it('exposes every required tool with a JSON schema', () => {
    for (const n of ['get_accounts', 'get_transactions', 'get_obligations', 'get_credit_profiles', 'get_health_indicators', 'get_forecast', 'simulate_scenario', 'goal_feasibility', 'detect_transaction_anomalies', 'detect_scam_signals', 'fred_series', 'college_scorecard']) {
      expect(reg.has(n)).toBe(true);
    }
    const spec = reg.specs(['simulate_scenario'])[0]!;
    expect(spec.parameters).toMatchObject({ type: 'object' });
    expect(JSON.stringify(spec.parameters)).not.toContain('$schema');
  });
  it('validates arguments and returns errors instead of throwing', async () => {
    const bad = await reg.execute('goal_feasibility', { target_amount: 'lots' }, ctx());
    expect(bad.ok).toBe(false);
    const unknown = await reg.execute('nope', {}, ctx());
    expect(unknown.ok).toBe(false);
  });
  it('get_transactions filters and groups, leaving transfers out of spending groups', async () => {
    const grouped = await reg.execute('get_transactions', { group_by: 'category', direction: 'out' }, ctx());
    expect(grouped.ok && JSON.stringify(grouped.result)).not.toContain('"transfer"');
    const rows = await reg.execute('get_transactions', { category: 'groceries', limit: 3 }, ctx());
    expect(rows.ok && (rows.result as { transactions: unknown[] }).transactions).toHaveLength(3);
  });
  it('get_accounts totals; get_forecast summarizes the 90 days', async () => {
    const a = await reg.execute('get_accounts', {}, ctx());
    expect(a.ok && (a.result as { totals: { liquid_cash: number } }).totals.liquid_cash).toBe(30000);
    const f = await reg.execute('get_forecast', {}, ctx());
    expect(f.ok && (f.result as { available: boolean }).available).toBe(true);
  });
  it('tool results stay small', async () => {
    const r = await reg.execute('get_transactions', { limit: 40 }, ctx());
    expect(fitJson(r.ok ? r.result : {}, 3800).length).toBeLessThanOrEqual(3800);
  });
});

describe('fitJson', () => {
  it('shrinks big payloads to valid JSON under the limit', () => {
    const big = { rows: Array.from({ length: 400 }, (_v, i) => ({ i, text: 'x'.repeat(200) })) };
    const s = fitJson(big, 3800);
    expect(s.length).toBeLessThanOrEqual(3800);
    expect(() => JSON.parse(s)).not.toThrow();
  });
});

describe('unused import guard', () => {
  it('acct helper builds accounts', () => {
    expect(acct({ id: 'a', type: 'checking' }).household_id).toBe('hh_test');
  });
});
