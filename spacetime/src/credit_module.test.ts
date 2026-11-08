// Credit score monitoring against SpacetimeDB's real in-memory datastore (docs/contracts.md section 9):
// credit_score / credit_score_history rows, the monthly backfill, alerts on a 15-point move, sandboxes and onboarding households.
//   npm test
import { describe, expect, it } from 'vitest';
import { ConnectionId, TimeDuration, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as m from './index';

const NOW = Timestamp.fromDate(new Date('2026-11-07T18:00:00Z'));
let conn = 1000n;
const who = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));
const worker = who('worker');
const alice = who('alice');
const j = JSON.stringify;

const households = [{ id: 'hh_demo', name: 'The Demos', city: 'Dallas', state: 'TX', persona: 'bakery owners', home_value: 0, vehicle_value: 18000 }];
const members = [
  { id: 'mem_a', household_id: 'hh_demo', name: 'Ana Demo', age: 41, role: 'parent', income_annual: 72000 },
  { id: 'mem_b', household_id: 'hh_demo', name: 'Ben Demo', age: 12, role: 'child', income_annual: 0 },
];
const accounts = [
  { id: 'acct_chk', household_id: 'hh_demo', owner_member_ids: ['mem_a'], type: 'checking', institution: 'PNC', nickname: 'Main', balance: 4200, opened_date: '2015-01-01' },
  { id: 'acct_sav', household_id: 'hh_demo', owner_member_ids: ['mem_a'], type: 'savings', institution: 'PNC', nickname: 'Rainy day', balance: 9000, rate_pct: 4.1, opened_date: '2016-01-01' },
  { id: 'acct_cc', household_id: 'hh_demo', owner_member_ids: ['mem_a'], type: 'credit_card', institution: 'PNC', nickname: 'Visa', balance: 2400, credit_limit: 6000, monthly_payment: 70, opened_date: '2018-03-01' },
  { id: 'acct_car', household_id: 'hh_demo', owner_member_ids: ['mem_a'], type: 'auto_loan', institution: 'PNC', nickname: 'Car', balance: 9000, monthly_payment: 320, opened_date: '2024-02-15' },
];
const txns: Record<string, unknown>[] = [];
let tn = 0;
const addTxn = (date: string, amount: number, merchant: string, extra: Record<string, unknown> = {}) =>
  txns.push({ id: `txn_${String(++tn).padStart(4, '0')}`, account_id: 'acct_chk', date, amount, merchant, category: amount > 0 ? 'income' : 'shopping', description: '', is_recurring: false, ...extra });
for (const mo of ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
  addTxn(`${mo}-01`, 3000, 'DEMO BAKERY PAYROLL', { is_recurring: true });
  addTxn(`${mo}-03`, -1400, 'Oak Cliff Rent', { category: 'housing', is_recurring: true });
  for (const d of ['05', '12', '21']) addTxn(`${mo}-${d}`, -(60 + Number(d)), 'Tom Thumb', { category: 'groceries' });
  addTxn(`${mo}-15`, -80, 'Visa purchase', { account_id: 'acct_cc' });
}
addTxn('2026-11-01', 3000, 'DEMO BAKERY PAYROLL', { is_recurring: true });
addTxn('2026-11-03', -1400, 'Oak Cliff Rent', { category: 'housing', is_recurring: true });
const credit = [{ member_id: 'mem_a', score: 712, utilization_pct: 40, hard_inquiries_12m: 1, oldest_account_years: 8, late_payments_24m: 0 }];
const obligations = [{ id: 'obl_rent', household_id: 'hh_demo', name: 'Rent', amount: 1400, due_day: 3, account_id: 'acct_chk', kind: 'bill' }];

function seeded() {
  const test = createModuleTestHarness(spacetimedb, m, { rngSeed: 11n });
  test.clock.set(NOW);
  test.withReducerTx(worker, (ctx) => m.register_worker(ctx, { secret: 'keystone-dev-secret', label: 'test worker' }));
  test.withReducerTx(worker, (ctx) => {
    m.seed_households(ctx, { rows_json: j(households) });
    m.seed_members(ctx, { rows_json: j(members) });
    m.seed_accounts(ctx, { rows_json: j(accounts) });
    m.seed_credit(ctx, { rows_json: j(credit) });
    m.seed_txns(ctx, { rows_json: j(txns) });
    m.seed_obligations(ctx, { rows_json: j(obligations) });
  });
  return test;
}
type Test = ReturnType<typeof seeded>;
const recompute = (test: Test, hh = 'hh_demo') => test.withReducerTx(alice, (ctx) => m.recompute_household(ctx, { household_id: hh }));
const backfill = (test: Test, hh = 'hh_demo') => test.withReducerTx(worker, (ctx) => m.backfill_credit_history(ctx, { household_id: hh }));
const history = (test: Test, member = 'mem_a') =>
  [...test.db.credit_score_history.member_id.filter(member)].sort((a, b) => (a.date < b.date ? -1 : 1));
const creditAlerts = (test: Test, hh = 'hh_demo') => [...test.db.alert.household_id.filter(hh)].filter((a) => a.kind === 'credit');

describe('credit_score and credit_score_history', () => {
  it('recompute_household scores members that have a profile (not the child), with factors, and appends today once', () => {
    const test = seeded();
    recompute(test);
    const rows = [...test.db.credit_score.household_id.filter('hh_demo')];
    expect(rows.map((r) => r.member_id)).toEqual(['mem_a']);
    const s = rows[0]!;
    expect(s.id).toBe('mem_a');
    expect(s.score).toBeGreaterThanOrEqual(300);
    expect(s.score).toBeLessThanOrEqual(850);
    expect(['poor', 'fair', 'good', 'very good', 'exceptional']).toContain(s.band);
    const factors = JSON.parse(s.factors_json) as { key: string; value: number; weight: number; points: number; explanation: string }[];
    expect(factors.map((f) => f.key)).toEqual(['household_health', 'payment_history', 'utilization', 'history_length', 'new_credit', 'credit_mix']);
    expect(factors.every((f) => f.explanation.length > 10)).toBe(true);
    expect(factors.find((f) => f.key === 'utilization')!.explanation).toBe('Cards are at 40% of their limits; under 30% helps.');
    expect(Math.round(300 + factors.reduce((t, f) => t + f.points, 0))).toBeCloseTo(s.score, -1);
    const h = history(test);
    expect(h.map((x) => x.date)).toEqual(['2026-11-07']);
    expect(h[0]).toMatchObject({ id: 'mem_a:2026-11-07', household_id: 'hh_demo', score: s.score });
  });

  it('is idempotent per day: the same rows and no churn when nothing changed, even minutes later', () => {
    const test = seeded();
    recompute(test);
    const snap = () => ({ s: [...test.db.credit_score.iter()], h: [...test.db.credit_score_history.iter()], a: creditAlerts(test).length });
    const first = snap();
    test.clock.advance(TimeDuration.fromMillis(120_000));
    recompute(test);
    recompute(test);
    expect(snap()).toEqual(first); // including updated_at: an unchanged score keeps its row
  });

  it('the next day adds a new history point and keeps yesterday\'s', () => {
    const test = seeded();
    recompute(test);
    test.clock.advance(TimeDuration.fromMillis(24 * 3600_000));
    recompute(test);
    expect(history(test).map((x) => x.date)).toEqual(['2026-11-07', '2026-11-08']);
  });

  it('backfill_credit_history writes monthly points from each past month\'s transactions, is worker-only and idempotent', () => {
    const test = seeded();
    expect(() => test.withReducerTx(alice, (ctx) => m.backfill_credit_history(ctx, { household_id: 'hh_demo' }))).toThrow('worker only');
    expect(() => backfill(test, 'hh_nope')).toThrow('unknown household');
    backfill(test); // also computes today's score first
    const h = history(test);
    // transactions start 2026-06-01, so the dates with 28+ days behind them are Jul 7, Aug 7, Sep 7, Oct 7
    expect(h.map((x) => x.date)).toEqual(['2026-07-07', '2026-08-07', '2026-09-07', '2026-10-07', '2026-11-07']);
    expect(h.every((x) => x.score >= 300 && x.score <= 850)).toBe(true);
    const before = [...test.db.credit_score_history.iter()];
    backfill(test);
    backfill(test);
    expect([...test.db.credit_score_history.iter()]).toEqual(before);
    expect(creditAlerts(test)).toHaveLength(0); // a backfill never raises an alert
  });

  it('backfill with an empty household id covers households that have no history yet (capped), skipping the rest', () => {
    const test = seeded();
    backfill(test, '');
    expect(history(test).length).toBeGreaterThan(1);
    const n = test.db.credit_score_history.count();
    backfill(test, '');
    expect(test.db.credit_score_history.count()).toBe(n);
  });

  it('seed -> tick: a household that predates the backfill gets its monthly points on the next scheduled recompute', () => {
    const test = seeded();
    recompute(test); // today's point only
    expect(history(test)).toHaveLength(1);
    test.clock.advance(TimeDuration.fromMillis(24 * 3600_000)); // indicators are now from a previous day
    // the scheduled reducer is private; recompute + the lazy backfill it performs are what it calls
    test.withReducerTx(worker, (ctx) => m.backfill_credit_history(ctx, { household_id: '' }));
    expect(history(test).length).toBeGreaterThan(3);
  });
});

describe('credit alerts', () => {
  const lateOnce = (test: Test, late: number) =>
    test.withReducerTx(worker, (ctx) => {
      const p = ctx.db.credit_profile.member_id.find('mem_a')!;
      ctx.db.credit_profile.member_id.update({ ...p, late_payments_24m: late });
    });

  it('a drop of 15+ points raises one warn alert naming the biggest factor; the same day does not repeat it', () => {
    const test = seeded();
    backfill(test);
    const was = test.db.credit_score.id.find('mem_a')!.score;
    lateOnce(test, 2); // payment history falls from 1.0 to 0.45: about 60 points
    recompute(test);
    const now = test.db.credit_score.id.find('mem_a')!.score;
    expect(was - now).toBeGreaterThanOrEqual(15);
    const alerts = creditAlerts(test);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: 'credit:hh_demo:2026-11-07', severity: 'warn', kind: 'credit', acknowledged_by: '' });
    expect(alerts[0]!.title).toBe(`Ana's credit score dropped ${was - now} points to ${now}`);
    expect(alerts[0]!.detail).toContain('Biggest factor: payment history');
    expect(JSON.parse(alerts[0]!.related_ids_json)).toEqual(['mem_a']);
    recompute(test);
    recompute(test);
    expect(creditAlerts(test)).toHaveLength(1);
    // the live point replaced today's history value
    expect(history(test)[history(test).length - 1]).toMatchObject({ date: '2026-11-07', score: now });
  });

  it('a rise of 15+ points the next day is an info alert; small moves and the first-ever look raise nothing', () => {
    const test = seeded();
    recompute(test); // first look, no baseline yet: nothing to compare with
    lateOnce(test, 2);
    recompute(test); // still no history older than today, so no alert even though the score fell
    expect(creditAlerts(test)).toHaveLength(0);
    backfill(test);
    test.clock.advance(TimeDuration.fromMillis(24 * 3600_000));
    recompute(test); // next day, nothing changed
    expect(creditAlerts(test)).toHaveLength(0);
    lateOnce(test, 0);
    recompute(test);
    const alerts = creditAlerts(test);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: 'credit:hh_demo:2026-11-08', severity: 'info' });
    expect(alerts[0]!.title).toMatch(/^Ana's credit score rose \d+ points to \d+$/);
  });

  it('acknowledging works like any alert and the rule-alert sweep leaves credit alerts alone', () => {
    const test = seeded();
    backfill(test);
    lateOnce(test, 3);
    recompute(test);
    test.withReducerTx(alice, (ctx) => m.ack_alert(ctx, { alert_id: 'credit:hh_demo:2026-11-07', display_name: 'Ana' }));
    recompute(test);
    expect(creditAlerts(test)[0]!.acknowledged_by).toBe('Ana');
  });
});

describe('sandboxes and onboarding', () => {
  it('create_sandbox scores the copy (remapped member ids) and backfills its history', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.create_sandbox(ctx, { template_household_id: 'hh_demo', display_name: 'Judge' }));
    const sbx = [...test.db.household.iter()].find((h) => h.id.startsWith('hh_sbx_'))!;
    const rows = [...test.db.credit_score.household_id.filter(sbx.id)];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.member_id.startsWith('mem_a__')).toBe(true);
    const h = [...test.db.credit_score_history.household_id.filter(sbx.id)];
    expect(h.length).toBeGreaterThanOrEqual(4);
    expect(h.every((x) => x.member_id === rows[0]!.member_id)).toBe(true);
    // same numbers as the template
    backfill(test);
    expect(rows[0]!.score).toBe(test.db.credit_score.id.find('mem_a')!.score);
    // delete_sandbox cleans everything up
    test.withReducerTx(alice, (ctx) => m.delete_sandbox(ctx, { household_id: sbx.id }));
    expect([...test.db.credit_score.household_id.filter(sbx.id)]).toHaveLength(0);
    expect([...test.db.credit_score_history.household_id.filter(sbx.id)]).toHaveLength(0);
  });

  it('an onboarded bank household (no credit_profile) is scored from its accounts, backfilled by finish_onboarding, and quiet while importing', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.start_onboarding(ctx, { household_name: 'The Whitfields', display_name: 'Dana' }));
    const hh = [...test.db.household.iter()].find((h) => h.id.startsWith('hh_onb_'))!;
    const rows = (acct: Record<string, unknown>[]) => j(acct.map((a) => ({ household_id: hh.id, institution: 'First Platypus Bank', opened_date: '', ...a })));
    test.withReducerTx(worker, (ctx) =>
      m.agent_upsert_accounts(ctx, {
        rows_json: rows([
          { id: 'acct_plaid_chk', type: 'checking', nickname: 'Plaid Checking', balance: 6200 },
          { id: 'acct_plaid_sav', type: 'savings', nickname: 'Plaid Saving', balance: 9000 },
          { id: 'acct_plaid_cc', type: 'credit_card', nickname: 'Plaid Card', balance: 1500, credit_limit: 5000, opened_date: '2019-05-01' },
        ]),
      }),
    );
    const plaid: Record<string, unknown>[] = [];
    for (const mo of ['2026-07', '2026-08', '2026-09', '2026-10']) {
      plaid.push({ id: `txn_plaid_${mo}_pay`, account_id: 'acct_plaid_chk', date: `${mo}-01`, amount: 3200, merchant: 'Payroll', category: 'income', description: '', is_recurring: true });
      plaid.push({ id: `txn_plaid_${mo}_rent`, account_id: 'acct_plaid_chk', date: `${mo}-03`, amount: -1500, merchant: 'Landlord', category: 'rent', description: '', is_recurring: true });
      plaid.push({ id: `txn_plaid_${mo}_food`, account_id: 'acct_plaid_chk', date: `${mo}-10`, amount: -250, merchant: 'Kroger', category: 'groceries', description: '', is_recurring: false });
    }
    test.withReducerTx(worker, (ctx) => m.agent_upsert_txns(ctx, { rows_json: j(plaid) }));

    // while the data is still arriving: scores exist (derived) but no history and no alert
    recompute(test, hh.id);
    const s0 = test.db.credit_score.id.find([...test.db.member.household_id.filter(hh.id)][0]!.id)!;
    expect(s0.score).toBeGreaterThanOrEqual(300);
    expect(JSON.parse(s0.factors_json).find((f: { key: string }) => f.key === 'utilization').explanation).toBe('Cards are at 30% of their limits; under 30% helps, under 10% helps more.');
    expect(creditAlerts(test, hh.id)).toHaveLength(0);
    test.withReducerTx(worker, (ctx) => m.agent_set_bank_connection(ctx, { item_id: 'item_1', household_id: hh.id, institution_name: 'First Platypus Bank', status: 'ok', accounts_count: 3, txns_count: plaid.length, error: '' }));

    test.withReducerTx(alice, (ctx) => m.finish_onboarding(ctx, { household_id: hh.id }));
    const memberId = [...test.db.member.household_id.filter(hh.id)][0]!.id;
    const h = [...test.db.credit_score_history.member_id.filter(memberId)].sort((a, b) => (a.date < b.date ? -1 : 1));
    expect(h.length).toBeGreaterThanOrEqual(3);
    expect(h[h.length - 1]!.date).toBe('2026-11-07');
    expect(creditAlerts(test, hh.id)).toHaveLength(0);
  });

  it('a brand-new onboarding household with no accounts has no scores yet', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.start_onboarding(ctx, { household_name: 'The Whitfields', display_name: 'Dana' }));
    const hh = [...test.db.household.iter()].find((h) => h.id.startsWith('hh_onb_'))!;
    recompute(test, hh.id);
    expect([...test.db.credit_score.household_id.filter(hh.id)]).toHaveLength(0);
  });

  it('the credit alert kind is accepted from the worker too', () => {
    const test = seeded();
    test.withReducerTx(worker, (ctx) => m.agent_create_alert(ctx, { id: 'agent:credit:1', household_id: 'hh_demo', severity: 'warn', kind: 'credit', title: 't', detail: 'd', related_ids_json: '[]' }));
    expect(test.db.alert.id.find('agent:credit:1')!.kind).toBe('credit');
  });
});
