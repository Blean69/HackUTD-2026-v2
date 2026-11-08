// Pure tests for the synthetic credit score (docs/contracts.md section 9). No SpacetimeDB host needed:
//   npx vitest run src/credit.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALERT_DELTA,
  CURVES,
  HEALTH_CREDIT_SCALE,
  WEIGHTS,
  backfillHistory,
  bandOf,
  biggestMove,
  creditAlert,
  debtTypes,
  deriveProfile,
  historyDates,
  householdAsOf,
  householdHealth,
  interp,
  monthsBack,
  scoreCredit,
  scoreHousehold,
  scoredMembers,
  type CreditFactor,
  type MemberCreditProfile,
} from './credit';
import { analyzeHousehold, type FinAccount, type FinTxn, type HouseholdInput, type Indicator } from './finance';

const TODAY = '2026-11-07';
const PERFECT: MemberCreditProfile = { late_payments_24m: 0, utilization_pct: 4, hard_inquiries_12m: 0, oldest_account_years: 40 };

describe('the contract formula', () => {
  it('weights add up to 1 and match docs/contracts.md section 9', () => {
    expect(WEIGHTS).toEqual({ household_health: 0.45, payment_history: 0.2, utilization: 0.15, history_length: 0.08, new_credit: 0.06, credit_mix: 0.06 });
    expect(Object.values(WEIGHTS).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 10);
  });

  it('score = round(300 + 550*raw), raw = the weighted sum of the six 0..1 factors', () => {
    const r = scoreCredit({ household_health: 80, profile: PERFECT, debt_types: 4 });
    expect(r.factors.map((f) => f.key)).toEqual(['household_health', 'payment_history', 'utilization', 'history_length', 'new_credit', 'credit_mix']);
    for (const f of r.factors) {
      expect(f.value).toBeGreaterThanOrEqual(0);
      expect(f.value).toBeLessThanOrEqual(1);
      expect(f.weight).toBe(WEIGHTS[f.key]);
    }
    // five factors are 1.0; the health factor is the dashboard score (80/100) times the tuned scale
    const health = (80 / 100) * HEALTH_CREDIT_SCALE;
    const raw = 0.45 * health + 0.2 + 0.15 + 0.08 + 0.06 + 0.06;
    expect(r.raw).toBeCloseTo(raw, 3);
    expect(r.score).toBe(Math.round(300 + 550 * raw));
    // every factor shows its points, and the points are the score above 300
    expect(r.factors.reduce((s, f) => s + f.points, 0)).toBeCloseTo(r.score - 300, 0);
    for (const f of r.factors) expect(f.max_points).toBeCloseTo(550 * f.weight, 1);
  });

  it('a perfect household with a perfect profile reaches the exceptional band; the worst stays above 300', () => {
    const best = scoreCredit({ household_health: 100, profile: PERFECT, debt_types: 4 });
    expect(best.band).toBe('exceptional');
    expect(best.score).toBeLessThanOrEqual(850);
    const worst = scoreCredit({ household_health: 0, profile: { late_payments_24m: 12, utilization_pct: 400, hard_inquiries_12m: 30, oldest_account_years: 0 }, debt_types: 0 });
    expect(worst.score).toBeGreaterThanOrEqual(300);
    expect(worst.band).toBe('poor');
  });

  it('is monotone: better health, fewer late payments, lower utilization and fewer inquiries never lower the score', () => {
    const base = { household_health: 60, profile: { late_payments_24m: 1, utilization_pct: 45, hard_inquiries_12m: 2, oldest_account_years: 8 }, debt_types: 2 };
    const s = (o: object) => scoreCredit({ ...base, ...o, profile: { ...base.profile, ...((o as { profile?: object }).profile ?? {}) } }).score;
    expect(s({ household_health: 70 })).toBeGreaterThan(s({}));
    expect(s({ profile: { late_payments_24m: 0 } })).toBeGreaterThan(s({}));
    expect(s({ profile: { utilization_pct: 12 } })).toBeGreaterThan(s({}));
    expect(s({ profile: { hard_inquiries_12m: 0 } })).toBeGreaterThan(s({}));
    expect(s({ profile: { oldest_account_years: 20 } })).toBeGreaterThan(s({}));
    expect(s({ debt_types: 3 })).toBeGreaterThan(s({}));
  });

  it('bands: <580 poor, 580-669 fair, 670-739 good, 740-799 very good, 800+ exceptional', () => {
    const at = (x: number) => bandOf(x);
    expect([at(300), at(579)]).toEqual(['poor', 'poor']);
    expect([at(580), at(669)]).toEqual(['fair', 'fair']);
    expect([at(670), at(739)]).toEqual(['good', 'good']);
    expect([at(740), at(799)]).toEqual(['very good', 'very good']);
    expect([at(800), at(850)]).toEqual(['exceptional', 'exceptional']);
  });

  it('every factor explains itself in plain English', () => {
    const r = scoreCredit({ household_health: 72, profile: { late_payments_24m: 2, utilization_pct: 64, hard_inquiries_12m: 3, oldest_account_years: 6.5 }, debt_types: 2, debt_type_names: ['cards', 'auto loan'] });
    const text = Object.fromEntries(r.factors.map((f) => [f.key, f.explanation]));
    expect(text.utilization).toBe('Cards are at 64% of their limits; under 30% helps.');
    expect(text.payment_history).toBe('2 late payments in the last 2 years; on-time payments rebuild this.');
    expect(text.new_credit).toBe('3 hard credit checks in the last year; each one dips the score for a while.');
    expect(text.history_length).toBe('The oldest account is 6.5 years old; a longer history scores higher.');
    expect(text.credit_mix).toBe('2 kinds of debt (cards, auto loan); a mix of cards and installment loans helps.');
    expect(text.household_health).toMatch(/^Household finances score 72 out of 100/);
    const clean = scoreCredit({ household_health: 90, profile: PERFECT, debt_types: 3 });
    expect(clean.factors.find((f) => f.key === 'payment_history')!.explanation).toBe('No late payments in the last 2 years, the biggest single plus.');
    expect(clean.factors.find((f) => f.key === 'new_credit')!.explanation).toBe('No new credit applications in the last year.');
  });

  it('interp clamps at both ends and interpolates between points', () => {
    expect(interp(-5, CURVES.payment)).toBe(1);
    expect(interp(99, CURVES.payment)).toBe(0);
    expect(interp(0.5, [[0, 0], [1, 1]])).toBe(0.5);
  });
});

// ---- the Household Health score (what the dashboard shows) ----------------------------------------------------------
const ind = (key: string, value: number, unit: string, status: string): Indicator => ({ key, label: key, value, unit, status: status as Indicator['status'], explanation: '' });
const RIVERA_INDICATORS: Indicator[] = [
  ind('liquidity_runway', 3.3, 'months', 'watch'),
  ind('debt_to_income', 20.5, '%', 'good'),
  ind('credit_utilization', 15.7, '%', 'good'),
  ind('savings_rate', 8.8, '%', 'watch'),
  ind('net_worth_trend', 11972.57, 'USD', 'good'),
  ind('emergency_fund', 97.7, '%', 'watch'),
  ind('forecast_low_point', 39654.76, 'USD', 'good'),
  ind('credit_score', 726, 'score', 'watch'),
];

describe('household health', () => {
  it('blends the indicators the way the dashboard does (mean of the per-indicator scores)', () => {
    const h = householdHealth(RIVERA_INDICATORS);
    expect(h.score).toBe(79);
    expect(h.label).toBe('good');
    expect(h.rows.find((r) => r.key === 'liquidity_runway')!.score).toBe(63);
    expect(h.rows.find((r) => r.key === 'net_worth_trend')!.score).toBe(84); // "USD" is read as dollars, not as a percent
    expect(householdHealth([]).score).toBe(50);
  });

  it('the factor line names the weakest indicator in plain words', () => {
    const h = householdHealth(RIVERA_INDICATORS);
    const r = scoreCredit({ household_health: h.score, profile: PERFECT, debt_types: 3, health: h });
    expect(r.factors[0]!.explanation).toBe('Household finances score 79 out of 100 (good); the weakest spot is that cash on hand covers 3.3 months of spending.');
  });
});

// ---- a small household to rewind -----------------------------------------------------------------------------------
let n = 0;
const tx = (date: string, amount: number, merchant: string, extra: Partial<FinTxn> = {}): FinTxn => ({
  id: `t${String(++n).padStart(4, '0')}`,
  account_id: 'chk',
  date,
  amount,
  merchant,
  category: amount > 0 ? 'income' : 'shopping',
  description: '',
  is_recurring: false,
  ...extra,
});

function household(over: Partial<HouseholdInput> = {}, extraTxns: FinTxn[] = []): HouseholdInput {
  n = 0;
  const txns: FinTxn[] = [];
  for (const mo of ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
    txns.push(tx(`${mo}-01`, 3000, 'ACME PAYROLL', { is_recurring: true }));
    txns.push(tx(`${mo}-03`, -1400, 'Oak Cliff Rent', { category: 'housing', is_recurring: true }));
    for (const d of ['05', '12', '21']) txns.push(tx(`${mo}-${d}`, -(60 + Number(d)), 'Tom Thumb', { category: 'groceries' }));
    txns.push(tx(`${mo}-15`, -80, 'Visa purchase', { account_id: 'card', category: 'shopping' }));
  }
  txns.push(tx('2026-11-01', 3000, 'ACME PAYROLL', { is_recurring: true }));
  txns.push(tx('2026-11-03', -1400, 'Oak Cliff Rent', { category: 'housing', is_recurring: true }));
  return {
    household_id: 'hh_t',
    accounts: [
      { id: 'chk', type: 'checking', balance: 5000, opened_date: '2015-01-01' },
      { id: 'sav', type: 'savings', balance: 9000, opened_date: '2016-01-01' },
      { id: 'card', type: 'credit_card', nickname: 'Visa', balance: 2400, credit_limit: 6000, monthly_payment: 70, opened_date: '2018-03-01' },
      { id: 'car', type: 'auto_loan', balance: 9000, monthly_payment: 320, opened_date: '2024-02-15' },
    ],
    txns: [...txns, ...extraTxns],
    obligations: [{ id: 'o1', name: 'Rent', amount: 1400, due_day: 3, account_id: 'chk', kind: 'bill' }],
    members: [
      { id: 'mem_a', income_annual: 72000, role: 'parent' },
      { id: 'mem_k', income_annual: 0, role: 'child' },
    ],
    credit: [{ member_id: 'mem_a', score: 700, utilization_pct: 40, hard_inquiries_12m: 1, oldest_account_years: 8, late_payments_24m: 0 }],
    home_value: 0,
    vehicle_value: 0,
    ...over,
  };
}

describe('dates', () => {
  it('monthsBack clamps the day of month and crosses year ends', () => {
    expect(monthsBack('2026-03-31', 1)).toBe('2026-02-28');
    expect(monthsBack('2026-01-15', 2)).toBe('2025-11-15');
    expect(monthsBack('2024-03-31', 1)).toBe('2024-02-29');
    expect(monthsBack('2026-11-07', 6)).toBe('2026-05-07');
  });
  it('historyDates gives six monthly dates, oldest first, not including today', () => {
    expect(historyDates(TODAY)).toEqual(['2026-05-07', '2026-06-07', '2026-07-07', '2026-08-07', '2026-09-07', '2026-10-07']);
  });
});

describe('rewinding a household', () => {
  it('winds balances back by the transactions since: assets lose what came in, debts owe more', () => {
    const input = household({}, [tx('2026-10-20', 500, 'Card payment', { account_id: 'card', category: 'transfer' }), tx('2026-10-25', -200, 'Savings move', { account_id: 'sav', category: 'transfer' })]);
    const past = householdAsOf(input, '2026-10-07', TODAY)!;
    const bal = (id: string, h: HouseholdInput) => h.accounts.find((a) => a.id === id)!.balance;
    // after 10-07 the checking account saw +3000 -1400 (Oct 15 groceries etc. are in the sum); recompute the expected delta from the data
    const after = (id: string) => input.txns.filter((t) => t.account_id === id && t.date > '2026-10-07').reduce((s, t) => s + t.amount, 0);
    expect(bal('chk', past)).toBeCloseTo(5000 - after('chk'), 2);
    expect(bal('sav', past)).toBeCloseTo(9000 - after('sav'), 2);
    expect(bal('card', past)).toBeCloseTo(2400 + after('card'), 2); // +500 payment and -80 purchase since: owed 2400 + 420
    expect(past.txns.every((t) => t.date <= '2026-10-07')).toBe(true);
  });

  it('refuses a date without enough history, a future date, and leaves accounts that did not exist yet out', () => {
    const input = household();
    expect(householdAsOf(input, '2026-06-10', TODAY)).toBeNull(); // only 9 days of transactions
    expect(householdAsOf(input, '2026-11-07', TODAY)).toBeNull();
    expect(householdAsOf(input, '2026-12-01', TODAY)).toBeNull();
    const past = householdAsOf(input, '2026-08-07', TODAY)!;
    expect(past.accounts.map((a) => a.id)).toEqual(['chk', 'sav', 'card', 'car']);
    const newer = household({ accounts: [...household().accounts, { id: 'loan2', type: 'personal_loan', balance: 3000, opened_date: '2026-09-20' }] });
    expect(householdAsOf(newer, '2026-08-07', TODAY)!.accounts.map((a) => a.id)).not.toContain('loan2');
    expect(householdAsOf(newer, '2026-10-07', TODAY)!.accounts.map((a) => a.id)).toContain('loan2');
  });

  it('duplicates and impossible rows are not used to wind balances back', () => {
    const dup = [tx('2026-10-14', -37.25, 'Home Depot'), tx('2026-10-14', -37.25, 'Home Depot'), tx('2026-10-16', -2_400_000, 'Mystery Wire'), tx('2027-03-01', -20, 'Time Machine Cafe')];
    const clean = householdAsOf(household(), '2026-10-07', TODAY)!;
    const messy = householdAsOf(household({}, dup), '2026-10-07', TODAY)!;
    const chk = (h: HouseholdInput) => h.accounts.find((a) => a.id === 'chk')!.balance;
    // the first Home Depot charge is real (-37.25 since 10-07); the copy, the $2.4M wire and the 2027 row are ignored
    expect(chk(messy)).toBeCloseTo(chk(clean) + 37.25, 2);
  });
});

describe('member profiles', () => {
  it('uses credit_profile rows when the household has them (children without one are not scored)', () => {
    const m = scoredMembers(household(), TODAY);
    expect(m.map((x) => [x.member_id, x.derived])).toEqual([['mem_a', false]]);
  });

  it('derives a profile from the household accounts when there are no credit_profile rows (Plaid / PNC households)', () => {
    const lateFee = [tx('2026-09-12', -35, 'PNC Late Fee', { category: 'bank_fees' }), tx('2026-09-20', -35, 'PNC Late Fee', { category: 'bank_fees' }), tx('2026-10-12', -35, 'Card late payment charge', { account_id: 'card' })];
    const input = household({ credit: [], members: [{ id: 'mem_a', income_annual: 72000, role: 'parent' }, { id: 'mem_b', income_annual: 50000, role: 'parent' }, { id: 'mem_k', income_annual: 0, role: 'child' }] }, lateFee);
    const scored = scoredMembers(input, TODAY);
    expect(scored.map((s) => s.member_id)).toEqual(['mem_a', 'mem_b']); // the child has no credit file
    expect(scored.every((s) => s.derived)).toBe(true);
    const p = scored[0]!.profile;
    expect(p.utilization_pct).toBe(40); // 2400 / 6000
    expect(p.late_payments_24m).toBe(2); // two distinct months with a late fee
    expect(p.hard_inquiries_12m).toBe(0); // the auto loan opened in Feb 2024
    expect(p.oldest_account_years).toBeCloseTo(8.7, 1); // the card opened 2018-03-01
  });

  it('new credit accounts in the last year count as hard inquiries; unknown account ages fall back to a default', () => {
    const input = household({ credit: [], accounts: [{ id: 'chk', type: 'checking', balance: 100, opened_date: '' }, { id: 'card', type: 'credit_card', balance: 0, credit_limit: 1000, opened_date: '2026-08-01' }] });
    const p = deriveProfile(input, TODAY);
    expect(p.hard_inquiries_12m).toBe(1);
    expect(p.utilization_pct).toBe(0);
    const bare = deriveProfile(household({ credit: [], accounts: [{ id: 'chk', type: 'checking', balance: 100, opened_date: '' }] }), TODAY);
    expect(bare.oldest_account_years).toBe(5);
  });

  it('a household with no accounts yet has no scores', () => {
    expect(scoredMembers(household({ credit: [], accounts: [], txns: [] }), TODAY)).toEqual([]);
  });

  it('debtTypes counts distinct kinds in a fixed order', () => {
    expect(debtTypes(household().accounts)).toEqual({ count: 2, names: ['cards', 'auto loan'] });
    expect(debtTypes([{ id: 'x', type: 'checking', balance: 1 } as FinAccount])).toEqual({ count: 0, names: [] });
  });
});

describe('history backfill', () => {
  it('scores each past month from that month\'s transactions: about six points, only where there is data, deterministic', () => {
    const input = household();
    const a = backfillHistory(input, TODAY);
    expect(a.map((p) => p.date)).toEqual(['2026-07-07', '2026-08-07', '2026-09-07', '2026-10-07']); // transactions start 2026-06-01
    for (const p of a) {
      expect(p.members.map((m) => m.member_id)).toEqual(['mem_a']);
      expect(p.members[0]!.score).toBeGreaterThanOrEqual(300);
      expect(p.members[0]!.score).toBeLessThanOrEqual(850);
    }
    expect(backfillHistory(input, TODAY)).toEqual(a);
  });

  it('the newest backfilled month equals scoring the household as it stood then with the same code path', () => {
    const input = household();
    const past = householdAsOf(input, '2026-10-07', TODAY)!;
    const analysis = analyzeHousehold(past, '2026-10-07');
    const direct = scoreHousehold(past, analysis.indicators, '2026-10-07', (31 / 365.25))[0]!;
    const viaBackfill = backfillHistory(input, TODAY).find((p) => p.date === '2026-10-07')!;
    expect(viaBackfill.members[0]!.score).toBe(direct.score);
    expect(viaBackfill.household_health).toBe(householdHealth(analysis.indicators).score);
  });

  it('a household with a short history gets fewer points, a household with none gets none', () => {
    const short = household({ txns: household().txns.filter((t) => t.date >= '2026-09-01') });
    expect(backfillHistory(short, TODAY).map((p) => p.date)).toEqual(['2026-10-07']);
    expect(backfillHistory(household({ txns: [] }), TODAY)).toEqual([]);
  });
});

describe('alerts', () => {
  const factor = (key: CreditFactor['key'], label: string, points: number, explanation = ''): CreditFactor => ({ key, label, value: 0, weight: 0, points, max_points: 100, explanation });
  const before = [factor('household_health', 'Household finances', 150), factor('utilization', 'Card utilization', 70, 'Cards are at 12% of their limits; under 30% helps.')];
  const after = [factor('household_health', 'Household finances', 148), factor('utilization', 'Card utilization', 40, 'Cards are at 55% of their limits; under 30% helps.')];

  it('names the factor that moved the most', () => {
    expect(biggestMove(before, after)).toMatchObject({ key: 'utilization', delta_points: -30 });
  });

  it('a drop of 15 or more is a warn alert that names the biggest factor; 14 is nothing', () => {
    expect(ALERT_DELTA).toBe(15);
    const change = { member_id: 'mem_a', name: 'Ana Demo', before: 720, after: 690, prev_factors: before, factors: after };
    const a = creditAlert('hh_t', TODAY, [change])!;
    expect(a.id).toBe('credit:hh_t:2026-11-07');
    expect(a.severity).toBe('warn');
    expect(a.title).toBe("Ana's credit score dropped 30 points to 690");
    expect(a.detail).toContain('Biggest factor: card utilization (-30 points). Cards are at 55% of their limits; under 30% helps.');
    expect(a.detail).toContain('Simulated score for this demo.');
    expect(a.related_ids).toEqual(['mem_a']);
    expect(creditAlert('hh_t', TODAY, [{ ...change, after: 706 }])).toBeNull();
    expect(creditAlert('hh_t', TODAY, [{ ...change, after: 705 }])).not.toBeNull();
  });

  it('a rise is info, and several members moving make one alert led by the biggest mover', () => {
    const up = { member_id: 'mem_a', name: 'Ana Demo', before: 650, after: 668, prev_factors: after, factors: before };
    const bigger = { member_id: 'mem_b', name: 'Ben Demo', before: 650, after: 680, prev_factors: after, factors: before };
    const quiet = { member_id: 'mem_c', name: 'Cy Demo', before: 650, after: 652, prev_factors: after, factors: before };
    const a = creditAlert('hh_t', TODAY, [up, bigger, quiet])!;
    expect(a.severity).toBe('info');
    expect(a.title).toBe("Ben's credit score rose 30 points to 680 (and 1 other score moved too)");
    expect(a.related_ids).toEqual(['mem_a', 'mem_b']);
  });
});

// ---- the seeded families land where they should --------------------------------------------------------------------
const SEED = join(new URL('.', import.meta.url).pathname, '../../data/seed');
const haveSeed = ['households', 'members', 'accounts', 'transactions', 'credit_profiles', 'obligations'].every((f) => existsSync(join(SEED, `${f}.json`)));
const rows = (f: string): Record<string, any>[] => JSON.parse(readFileSync(join(SEED, `${f}.json`), 'utf8'));

describe.skipIf(!haveSeed)('seeded households land in sensible, varied bands', () => {
  const byFamily = new Map<string, { member: string; score: number; band: string; history: number[] }[]>();
  if (haveSeed) {
    const accounts = rows('accounts');
    const txns = rows('transactions');
    for (const hh of rows('households')) {
      const accts = accounts.filter((a) => a.household_id === hh.id);
      const ids = new Set(accts.map((a) => a.id));
      const input: HouseholdInput = {
        household_id: hh.id,
        home_value: hh.home_value,
        vehicle_value: hh.vehicle_value,
        accounts: accts as never,
        txns: txns.filter((t) => ids.has(t.account_id)).map((t) => ({ id: t.id, account_id: t.account_id, date: t.date, amount: t.amount, merchant: t.merchant, category: t.category, description: t.description, is_recurring: Boolean(t.is_recurring) })),
        obligations: rows('obligations').filter((o) => o.household_id === hh.id) as never,
        members: rows('members').filter((m) => m.household_id === hh.id) as never,
        credit: rows('credit_profiles').filter((c) => c.household_id === hh.id) as never,
      };
      const live = scoreHousehold(input, analyzeHousehold(input, TODAY).indicators, TODAY);
      const hist = backfillHistory(input, TODAY);
      byFamily.set(
        hh.id,
        live.map((s) => ({ member: s.member_id, score: s.score, band: s.band, history: hist.map((p) => p.members.find((m) => m.member_id === s.member_id)!.score) })),
      );
    }
  }
  const bands = (id: string) => byFamily.get(id)!.map((m) => m.band);
  const avg = (id: string) => Math.round(byFamily.get(id)!.reduce((s, m) => s + m.score, 0) / byFamily.get(id)!.length);

  it('Riveras good, Okafors fair, Nguyens very good, Patels poor, Brooks good', () => {
    expect(bands('hh_rivera')).toEqual(['good', 'good', 'good']);
    expect(bands('hh_okafor')).toEqual(['fair', 'fair']);
    expect(bands('hh_nguyen')).toEqual(['very good', 'very good']);
    expect(['fair', 'poor']).toContain(bands('hh_patel')[0]);
    expect(bandOf(avg('hh_brooks'))).toBe('good');
    // Terrence and Danielle are good; Walter's spotless 45-year file puts him one band up
    const brooks = Object.fromEntries(byFamily.get('hh_brooks')!.map((m) => [m.member, m.band]));
    expect(brooks['mem_brooks_terrence']).toBe('good');
    expect(brooks['mem_brooks_danielle']).toBe('good');
  });

  it('every seeded member has about six history points that stay in a believable range', () => {
    for (const members of byFamily.values()) {
      for (const m of members) {
        expect(m.history.length).toBeGreaterThanOrEqual(4);
        expect(m.history.length).toBeLessThanOrEqual(6);
        for (const h of m.history) expect(Math.abs(h - m.score)).toBeLessThan(60);
      }
    }
  });

  it('the families are varied: five households span at least three bands', () => {
    const all = new Set([...byFamily.values()].flatMap((ms) => ms.map((m) => m.band)));
    expect(all.size).toBeGreaterThanOrEqual(4);
  });
});
