// Plain `node --test` tests for the pure modules (no SpacetimeDB host needed):
//   npm run test:pure     (= node --test src/finance.test.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  analyzeHousehold,
  detectDataQuality,
  isGarbledMerchant,
  type FinTxn,
  type HouseholdInput,
} from './finance.ts';
import { sha256Hex } from './sha256.ts';

const TODAY = '2026-11-07';

let n = 0;
const txn = (o: Partial<FinTxn> & { date: string; amount: number; merchant: string }): FinTxn => ({
  id: `txn_${String(++n).padStart(5, '0')}`,
  account_id: 'acct_chk',
  category: 'shopping',
  description: '',
  is_recurring: false,
  ...o,
});

function baseHousehold(extraTxns: FinTxn[] = []): HouseholdInput {
  const txns: FinTxn[] = [];
  // Paychecks on the 1st and 15th for ~4 months, rent on the 3rd, a few groceries.
  for (const m of ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11']) {
    for (const d of ['01', '15']) {
      if (`${m}-${d}` > TODAY) continue;
      txns.push(txn({ date: `${m}-${d}`, amount: 2500, merchant: 'ACME PAYROLL', category: 'income', is_recurring: true }));
    }
    if (`${m}-03` <= TODAY) txns.push(txn({ date: `${m}-03`, amount: -1500, merchant: 'Oak Cliff Rent', category: 'housing', is_recurring: true }));
    for (const d of ['06', '12', '20', '27']) {
      if (`${m}-${d}` <= TODAY) txns.push(txn({ date: `${m}-${d}`, amount: -(80 + Number(d)), merchant: 'Tom Thumb', category: 'groceries' }));
    }
  }
  return {
    household_id: 'hh_test',
    accounts: [
      { id: 'acct_chk', type: 'checking', balance: 4000 },
      { id: 'acct_sav', type: 'savings', balance: 6000 },
      { id: 'acct_cc', type: 'credit_card', balance: 1500, credit_limit: 10000, monthly_payment: 45 },
      { id: 'acct_car', type: 'auto_loan', balance: 12000, monthly_payment: 400 },
    ],
    txns: [...txns, ...extraTxns],
    obligations: [
      { id: 'obl_rent', name: 'Rent', amount: 1500, due_day: 3, account_id: 'acct_chk', kind: 'bill' },
      { id: 'obl_car', name: 'Auto loan', amount: 400, due_day: 20, account_id: 'acct_chk', kind: 'loan' },
    ],
    members: [{ id: 'mem_a', income_annual: 60000, role: 'parent' }],
    credit: [{ member_id: 'mem_a', score: 745, utilization_pct: 15, hard_inquiries_12m: 1, oldest_account_years: 9, late_payments_24m: 0 }],
    home_value: 0,
    vehicle_value: 0,
  };
}

test('sha256 matches node:crypto', () => {
  for (const s of ['', 'abc', 'keystone-dev-secret', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'héllo wörld ✓ 😀', 'a'.repeat(1000)]) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 20)));
  }
  assert.equal(
    sha256Hex('keystone-dev-secret'),
    '42c50c717ac955d1a374d919e57aa767830e7a175f16f609657ea8fce2a422eb',
  );
});

test('analysis is deterministic and idempotent', () => {
  const input = baseHousehold();
  const a = analyzeHousehold(input, TODAY);
  const b = analyzeHousehold(structuredClone(input), TODAY);
  assert.deepEqual(a, b);
  // Row order must not matter either.
  const shuffled = { ...input, txns: [...input.txns].reverse(), accounts: [...input.accounts].reverse() };
  assert.deepEqual(analyzeHousehold(shuffled, TODAY), a);
});

test('indicators: sane values, keys and statuses', () => {
  const a = analyzeHousehold(baseHousehold(), TODAY);
  const by = Object.fromEntries(a.indicators.map((i) => [i.key, i]));
  for (const k of ['liquidity_runway', 'debt_to_income', 'credit_utilization', 'savings_rate', 'net_worth_trend', 'emergency_fund', 'forecast_low_point', 'credit_score']) {
    assert.ok(by[k], `missing indicator ${k}`);
    assert.ok(['good', 'watch', 'risk'].includes(by[k].status));
    assert.ok(by[k].explanation.length > 10 && !by[k].explanation.includes('\n'));
    assert.ok(Number.isFinite(by[k].value));
  }
  assert.equal(by.credit_utilization.value, 15); // 1500 / 10000
  assert.equal(by.credit_utilization.status, 'good');
  // debt service = 45 + 400 = 445 on 5000/mo gross => 8.9%
  assert.equal(by.debt_to_income.value, 8.9);
  assert.equal(by.debt_to_income.status, 'good');
  // $10,000 liquid; spending is ~rent + groceries (~1.9k/mo) => runway well over 3 months
  assert.ok(by.liquidity_runway.value > 3 && by.liquidity_runway.value < 8, String(by.liquidity_runway.value));
  assert.equal(by.credit_score.status, 'good');
});

test('forecast: 90 consecutive days, rent and paychecks projected', () => {
  const a = analyzeHousehold(baseHousehold(), TODAY);
  assert.equal(a.forecast.length, 90);
  // as_of is the newest trustworthy transaction (Nov 6 groceries), not the wall clock.
  assert.equal(a.as_of, '2026-11-06');
  assert.equal(a.forecast[0]!.date, '2026-11-07');
  assert.equal(a.forecast[89]!.date, '2027-02-04');
  const dec3 = a.forecast.find((p) => p.date === '2026-12-03')!;
  // Rent is both an obligation and a recurring charge: counted once.
  assert.equal(dec3.obligations_due, 1500);
  const dec1 = a.forecast.find((p) => p.date === '2026-12-01')!;
  const nov30 = a.forecast.find((p) => p.date === '2026-11-30')!;
  assert.ok(dec1.balance - nov30.balance > 2000, 'paycheck lands Dec 1');
  const jan20 = a.forecast.find((p) => p.date === '2027-01-20')!;
  assert.equal(jan20.obligations_due, 400); // auto loan obligation
});

test('forecast: a household that runs out of money gets an overdraft alert and a risk status', () => {
  const input = baseHousehold();
  input.accounts[0]!.balance = 200;
  input.accounts[1]!.balance = 100;
  input.txns = input.txns.filter((t) => t.category !== 'income'); // no paychecks
  const a = analyzeHousehold(input, TODAY);
  const low = a.indicators.find((i) => i.key === 'forecast_low_point')!;
  assert.equal(low.status, 'risk');
  const od = a.alerts.find((x) => x.id === 'rule:hh_test:overdraft');
  assert.ok(od, 'overdraft alert');
  assert.equal(od.kind, 'obligation');
});

test('rule: exact duplicates (same day, amount, merchant)', () => {
  const dupA = txn({ date: '2026-10-10', amount: -42.5, merchant: 'Home Depot' });
  const dupB = txn({ date: '2026-10-10', amount: -42.5, merchant: 'Home Depot' });
  const near = txn({ date: '2026-10-10', amount: -42.51, merchant: 'Home Depot' });
  const q = detectDataQuality('hh_test', [dupA, dupB, near], TODAY);
  const d = q.alerts.filter((a) => a.id.includes(':duplicate:'));
  assert.equal(d.length, 1);
  assert.deepEqual(d[0]!.related_ids.sort(), [dupA.id, dupB.id].sort());
  assert.ok(q.excludeIds.has(dupB.id) && !q.excludeIds.has(dupA.id) && !q.excludeIds.has(near.id));
});

test('rule: garbled merchant strings', () => {
  assert.ok(isGarbledMerchant('CafÃ© Rosa').garbled);
  assert.ok(isGarbledMerchant('Donâ€™s Diner').garbled);
  assert.ok(isGarbledMerchant('STAR\u0000BUCKS').garbled);
  assert.ok(isGarbledMerchant('SQ *�� COFFEE').garbled);
  assert.ok(isGarbledMerchant('@#$%^&').garbled || isGarbledMerchant('ST@RBUCK$ #1~~').garbled);
  assert.ok(!isGarbledMerchant('AMZN Mktp US*2K4HX0Y').garbled);
  assert.ok(!isGarbledMerchant("McDonald's #1234").garbled);
  assert.ok(!isGarbledMerchant('Café Rosa').garbled); // real accent, not mojibake
  const t = txn({ date: '2026-10-11', amount: -9, merchant: 'CafÃ© Rosa' });
  const q = detectDataQuality('hh_test', [t], TODAY);
  assert.equal(q.alerts.filter((a) => a.id.includes(':garbled:')).length, 1);
});

test('rule: impossible values (amount > $1M, future date)', () => {
  const big = txn({ date: '2026-10-11', amount: -2_500_000, merchant: 'Mystery Wire' });
  const fut = txn({ date: '2027-03-01', amount: -20, merchant: 'Time Machine Cafe' });
  const ok = txn({ date: '2026-10-11', amount: -1_000_000, merchant: 'Exactly One Million' });
  const q = detectDataQuality('hh_test', [big, fut, ok], TODAY);
  const imp = q.alerts.filter((a) => a.id.includes(':impossible:'));
  assert.deepEqual(imp.map((a) => a.related_ids[0]).sort(), [big.id, fut.id].sort());
  assert.ok(q.excludeIds.has(big.id) && q.excludeIds.has(fut.id) && !q.excludeIds.has(ok.id));
  // Excluded rows must not distort the math.
  const clean = analyzeHousehold(baseHousehold(), TODAY);
  const dirty = analyzeHousehold(baseHousehold([big, fut]), TODAY);
  assert.deepEqual(dirty.indicators, clean.indicators);
});

test('rule: card-testing burst (>= 5 charges under $2 at one merchant within an hour)', () => {
  const mk = (min: number, amt = -1.0) => txn({ date: `2026-10-20T14:${String(min).padStart(2, '0')}:00Z`, amount: amt, merchant: 'PAYSAFE*TEST' });
  const burst = [mk(0), mk(5, -1.01), mk(9, -0.99), mk(14, -1.02), mk(21, -1.03), mk(40, -1.04)];
  const q = detectDataQuality('hh_test', burst, TODAY);
  const b = q.alerts.filter((a) => a.kind === 'fraud');
  assert.equal(b.length, 1);
  assert.equal(b[0]!.related_ids.length, 6);
  // Same count spread over several hours is not a burst.
  const slow = [0, 1, 2, 3, 4, 5].map((h) => txn({ date: `2026-10-20T${String(8 + h * 2).padStart(2, '0')}:00:00Z`, amount: -1, merchant: 'SLOW*COFFEE' }));
  assert.equal(detectDataQuality('hh_test', slow, TODAY).alerts.filter((a) => a.kind === 'fraud').length, 0);
  // Four is not enough; charges of $2 or more do not count.
  assert.equal(detectDataQuality('hh_test', burst.slice(0, 4), TODAY).alerts.filter((a) => a.kind === 'fraud').length, 0);
  const big = [0, 1, 2, 3, 4].map((m) => txn({ date: `2026-10-20T14:0${m}:00Z`, amount: -2.5, merchant: 'COFFEE' }));
  assert.equal(detectDataQuality('hh_test', big, TODAY).alerts.filter((a) => a.kind === 'fraud').length, 0);
  // A same-day cluster in date-only data counts (no clock time to refine it).
  const dateOnly = [0, 1, 2, 3, 4].map((i) => txn({ date: '2026-10-21', amount: -(0.5 + i / 10), merchant: 'NIGHT*MARKET' }));
  assert.equal(detectDataQuality('hh_test', dateOnly, TODAY).alerts.filter((a) => a.kind === 'fraud').length, 1);
});

test('anomaly_truth is not part of the input type (rules cannot read ground truth)', () => {
  const t = txn({ date: '2026-10-10', amount: -5, merchant: 'X' }) as unknown as Record<string, unknown>;
  assert.ok(!('anomaly_truth' in t) && !('anomaly' in t));
});

test('income described as a transfer (owner draw) is income; own-account transfers and card payments are not spending', () => {
  const input = baseHousehold();
  input.txns = [
    // 3 months of owner draws booked as "ONLINE TRANSFER FROM <LLC>" with category income
    ...['2026-09-01', '2026-10-01', '2026-11-01'].map((date) =>
      txn({ date, amount: 5000, merchant: 'Bakery LLC', category: 'income', description: 'ONLINE TRANSFER FROM BAKERY LLC OWNER DRAW' }),
    ),
    // savings transfer: both legs, must not count as spending or income
    ...['2026-09-05', '2026-10-05'].flatMap((date) => [
      txn({ date, amount: -400, merchant: 'Transfer', category: 'savings', description: 'ONLINE TRANSFER TO COLLEGE FUND' }),
      txn({ date, amount: 400, merchant: 'Transfer', category: 'savings', account_id: 'acct_sav', description: 'TRANSFER FROM CHECKING' }),
    ]),
    // card purchase + the card payment from checking (two legs): spending counted once, at purchase
    txn({ date: '2026-10-10', amount: -300, merchant: 'Shell', category: 'fuel', account_id: 'acct_cc' }),
    txn({ date: '2026-10-20', amount: -300, merchant: 'Card Services', category: 'credit_card_payment', description: 'ONLINE PAYMENT TO CARD SERVICES' }),
    txn({ date: '2026-10-20', amount: 300, merchant: 'Card Services', category: 'credit_card_payment', account_id: 'acct_cc', description: 'PAYMENT THANK YOU' }),
  ];
  const a = analyzeHousehold(input, TODAY);
  const sr = a.indicators.find((i) => i.key === 'savings_rate')!;
  // income 15000 over ~2.3 months of data, expenses only the $300 fuel purchase
  assert.ok(sr.value > 90, `savings rate ${sr.value}`);
  assert.match(sr.explanation, /deposits/);
});

test('rule: consecutive-day re-post is informational and spares fees and recurring charges', () => {
  const a = txn({ date: '2026-10-10', amount: -31.5, merchant: 'RaceTrac', category: 'fuel' });
  const b = txn({ date: '2026-10-11', amount: -31.5, merchant: 'RaceTrac', category: 'fuel' });
  const f1 = txn({ date: '2026-10-12', amount: -35, merchant: 'Overdraft Fee', category: 'fees' });
  const f2 = txn({ date: '2026-10-13', amount: -35, merchant: 'Overdraft Fee', category: 'fees' });
  const q = detectDataQuality('hh_test', [a, b, f1, f2], TODAY);
  const r = q.alerts.filter((x) => x.id.includes(':repost:'));
  assert.equal(r.length, 1);
  assert.equal(r[0]!.severity, 'info');
  assert.deepEqual(r[0]!.related_ids, [a.id, b.id]);
  assert.ok(!q.excludeIds.has(b.id), 're-posts are reported but not removed from the math');
});

test('garbled: symbol substitution inside words is caught, ordinary punctuation is not', () => {
  for (const bad of ["McDo&a¿d's", 'Fi$st¤ Mart', '**di', '*ld$']) assert.ok(isGarbledMerchant(bad).garbled, bad);
  for (const ok of ['AT&T', 'H&M', "Trader Joe's #123", 'SQ *COFFEE HOUSE', 'TST* Rosa Cafe', 'Chick-fil-A', 'CVS/pharmacy #4410', 'T.J. Maxx', 'Zelle - T Bryant (new payee)', '7-ELEVEN #31022', 'AMZN Mktp US*2K4HX0Y']) {
    assert.ok(!isGarbledMerchant(ok).garbled, ok);
  }
});

test('forecast follows the contract: recurring inflows + obligations - discretionary; recurring outflow txns are not subtracted again', () => {
  const input = baseHousehold([
    // a recurring outflow with NO matching obligation: must not appear in the projection (obligations are complete)
    ...['2026-08', '2026-09', '2026-10', '2026-11'].map((m) => txn({ date: `${m}-10`, amount: -77, merchant: 'Gym Club', category: 'subscriptions', is_recurring: true })),
  ]);
  const a = analyzeHousehold(input, TODAY);
  assert.ok(a.forecast.every((p) => p.obligations_due === 0 || [1500, 400].includes(p.obligations_due)), 'only obligations are scheduled outflows');
  assert.ok(!a.forecast.some((p) => p.obligations_due === 77));
  const d = (date: string) => a.forecast.find((p) => p.date === date)!;
  // Dec 3: rent (obligation) due, nothing else scheduled that day.
  assert.equal(d('2026-12-03').obligations_due, 1500);
});

test('net worth counts home and vehicle value and subtracts debts (positive balances owed)', () => {
  const base = analyzeHousehold(baseHousehold(), TODAY);
  const withAssets = analyzeHousehold({ ...baseHousehold(), home_value: 300000, vehicle_value: 20000 }, TODAY);
  const nw = (a: typeof base) => a.indicators.find((i) => i.key === 'net_worth_trend')!;
  // checking 4000 + savings 6000 - card 1500 - auto loan 12000 = -3500
  assert.match(nw(base).explanation, /Net worth is -\$3,500/);
  assert.match(nw(withAssets).explanation, /Net worth is \$316,500/);
  assert.match(nw(withAssets).explanation, /including \$320,000 of home and vehicle value/);
  assert.equal(nw(base).value, nw(withAssets).value); // the 90-day change comes from cash flow, not appraisals
});

test('the shared cash numbers (cash_flow / cash_month) agree with the savings-rate indicator', () => {
  const a = analyzeHousehold(baseHousehold(), TODAY);
  const sr = a.indicators.find((i) => i.key === 'savings_rate')!;
  assert.equal(a.cash.savings_rate, sr.value); // the dashboard ring, Analytics and Brian all read this one number
  assert.ok(Math.abs(a.cash.net_monthly - (a.cash.income_monthly - a.cash.expense_monthly)) < 0.02);
  const spentInWindow = a.cash.categories.reduce((s, c) => s + c.total, 0);
  assert.ok(Math.abs(spentInWindow - (a.cash.expense_monthly * a.cash.window_days) / 30.4375) < 1, 'categories add up to the window spending');
  assert.ok(a.cash.months.length >= 3);
  const last = a.cash.months[a.cash.months.length - 1]!;
  assert.equal(last.month, TODAY.slice(0, 7));
  assert.equal(last.partial, true); // the current month is never shown as a full month
  for (const m of a.cash.months) assert.ok(Math.abs(m.net - (m.income - m.expenses)) < 0.02);
});
