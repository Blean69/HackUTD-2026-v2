// Plain `node --test` tests for the pure modules (no SpacetimeDB host needed):
//   npm run test:pure     (= node --test src/finance.test.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

// ---- bills detected from the transactions (imported households) ---------------------------------------------------

/**
 * A household as it arrives from Plaid: no obligations on file, nothing marked recurring. Payroll twice a month, rent,
 * a TXU electric bill that varies, a card paid in full from checking (by a different amount each month), Netflix on the
 * card, a Spotify plan cancelled in August, a monthly transfer to savings, and everyday spending on both accounts.
 */
function importedHousehold(o: { netflixUntil?: string } = {}): HouseholdInput {
  const txns: FinTxn[] = [];
  const add = (account_id: string, date: string, amount: number, merchant: string, category: string, description = merchant) => {
    if (date <= TODAY) txns.push(txn({ account_id, date, amount, merchant, category, description }));
  };
  const cardPays = [812.4, 905.1, 1010.75, 870.2, 930.6, 1004.3];
  const txu = [118.2, 131.65, 176.4, 182.1, 150.35, 127.9];
  ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].forEach((m, i) => {
    add('acct_p_chk', `${m}-01`, -1650, 'Oak Cliff Lofts', 'rent', 'RENT PAYMENT OAK CLIFF LOFTS');
    add('acct_p_chk', `${m}-02`, 2480, 'ACH CREDIT ACME ROBOTICS PAYROLL', 'income');
    add('acct_p_chk', `${m}-16`, 2480, 'ACH CREDIT ACME ROBOTICS PAYROLL', 'income');
    add('acct_p_chk', `${m}-05`, -400, 'ONLINE TRANSFER TO SAVINGS 0002', 'savings');
    add('acct_p_sav', `${m}-05`, 400, 'ONLINE TRANSFER FROM CHECKING 0001', 'transfer');
    for (const d of ['03', '10', '17', '24']) add('acct_p_chk', `${m}-${d}`, -(95 + i * 3 + Number(d)), 'H-E-B', 'groceries');
    add('acct_p_card', `${m}-12`, -(140 + i * 11), 'Target', 'shopping');
    add('acct_p_card', `${m}-19`, -(48 + i), 'Shell', 'fuel');
    if (!o.netflixUntil || m <= o.netflixUntil) add('acct_p_card', `${m}-06`, -15.49, 'Netflix', 'entertainment');
    if (m <= '2026-08') add('acct_p_card', `${m}-09`, -11.99, 'Spotify', 'entertainment');
    if (i < 6) {
      add('acct_p_chk', `${m}-14`, -txu[i]!, 'TXU Energy', 'utilities', 'TXU ENERGY AUTOPAY');
      add('acct_p_chk', `${m}-22`, -cardPays[i]!, 'CREDIT CARD AUTOPAY PAYMENT XXXX4321', 'credit_card_payment');
      add('acct_p_card', `${m}-22`, cardPays[i]!, 'PAYMENT THANK YOU', 'credit_card_payment');
    }
  });
  return {
    household_id: 'hh_imp',
    accounts: [
      { id: 'acct_p_chk', type: 'checking', nickname: 'Everyday Checking ••0001', balance: 5200 },
      { id: 'acct_p_sav', type: 'savings', nickname: 'Savings ••0002', balance: 9000 },
      { id: 'acct_p_card', type: 'credit_card', nickname: 'Rewards Visa ••4321', balance: 1200, credit_limit: 8000 },
    ],
    txns,
    obligations: [],
    members: [{ id: 'mem_p', income_annual: 0, role: 'parent' }],
    credit: [],
    home_value: 0,
    vehicle_value: 0,
    derive_obligations: true,
  };
}
const bills = (a: { derived_obligations: { id: string; name: string; kind: string; amount: number; due_day: number; account_id: string }[] }) =>
  a.derived_obligations.map(({ id, name, kind, amount, due_day, account_id }) => ({ id, name, kind, amount, due_day, account_id }));

test('imported household: bills are read from its own transactions (names, kinds, amounts, due days, paying account)', () => {
  const a = analyzeHousehold(importedHousehold(), TODAY);
  assert.deepEqual(bills(a), [
    { id: 'auto:hh_imp:credit-card-autopay-payment-xxxx', name: 'Rewards Visa payment', kind: 'loan', amount: 915.11, due_day: 22, account_id: 'acct_p_chk' },
    { id: 'auto:hh_imp:netflix', name: 'Netflix', kind: 'subscription', amount: 15.49, due_day: 6, account_id: 'acct_p_card' },
    { id: 'auto:hh_imp:oak-cliff-lofts', name: 'Rent (Oak Cliff Lofts)', kind: 'bill', amount: 1650, due_day: 1, account_id: 'acct_p_chk' },
    { id: 'auto:hh_imp:txu-energy', name: 'TXU Energy', kind: 'bill', amount: 150.35, due_day: 14, account_id: 'acct_p_chk' },
  ]);
  // The card payment is the median of the last three (870.20, 930.60, 1004.30) less the Netflix charged to that card, so
  // the bill total counts every dollar once. Payroll, the savings transfer, groceries, Target and Shell are not bills, and
  // Spotify (last charged in August) has stopped.
  const total = a.derived_obligations.reduce((s, o) => s + o.amount, 0);
  assert.equal(Math.round(total * 100) / 100, 2730.95);
  const rent = a.derived_obligations.find((o) => o.name.startsWith('Rent'))!;
  assert.equal(rent.txn_ids.length, 7);
  assert.equal(rent.last_date, '2026-11-01');
});

test('imported household: detection is deterministic, order-free and idempotent', () => {
  const input = importedHousehold();
  const a = analyzeHousehold(input, TODAY);
  assert.deepEqual(analyzeHousehold(structuredClone(input), TODAY), a);
  assert.deepEqual(analyzeHousehold({ ...input, txns: [...input.txns].reverse(), accounts: [...input.accounts].reverse() }, TODAY), a);
});

test('imported household: a subscription that stopped drops off, and the card payment is no longer net of it', () => {
  const a = analyzeHousehold(importedHousehold({ netflixUntil: '2026-08' }), TODAY);
  assert.deepEqual(a.derived_obligations.map((o) => o.name).sort(), ['Rent (Oak Cliff Lofts)', 'Rewards Visa payment', 'TXU Energy']);
  assert.equal(a.derived_obligations.find((o) => o.kind === 'loan')!.amount, 930.6);
});

test('imported household: the forecast schedules each detected bill once, exactly as the same bills entered by hand', () => {
  const imported = importedHousehold();
  const auto = analyzeHousehold(imported, TODAY);
  // The seeded convention: the same bills as obligations, and their cash-account charges marked recurring.
  const scheduled = new Set(auto.derived_obligations.flatMap((o) => o.txn_ids));
  const byHand: HouseholdInput = {
    ...imported,
    derive_obligations: false,
    obligations: auto.derived_obligations.map(({ txn_ids: _t, last_date: _l, ...o }) => o),
    txns: imported.txns.map((t) => (scheduled.has(t.id) ? { ...t, is_recurring: true } : t)),
  };
  const manual = analyzeHousehold(byHand, TODAY);
  assert.deepEqual(auto.forecast, manual.forecast);
  assert.deepEqual(auto.indicators, manual.indicators);
  // Each bill lands once a month on its day, and nothing else is scheduled (the window runs Nov 7 to Feb 4).
  assert.deepEqual(
    auto.forecast.filter((p) => p.obligations_due > 0).map((p) => `${p.date} ${p.obligations_due}`),
    ['2026-11-14 150.35', '2026-11-22 915.11', '2026-12-01 1650', '2026-12-06 15.49', '2026-12-14 150.35', '2026-12-22 915.11',
      '2027-01-01 1650', '2027-01-06 15.49', '2027-01-14 150.35', '2027-01-22 915.11', '2027-02-01 1650'],
  );
  // Without detection, rent and electric sat in the daily discretionary spend and the card bill was missing from the
  // forecast altogether (the card's purchases are not cash). With it the card payment is in, and nothing counts twice.
  const before = analyzeHousehold({ ...imported, derive_obligations: false }, TODAY);
  assert.equal(before.derived_obligations.length, 0);
  assert.ok(before.forecast.every((p) => p.obligations_due === 0));
  const drop = before.forecast[89]!.balance - auto.forecast[89]!.balance;
  assert.ok(drop > 2500 && drop < 3500, `90-day end balance moved by ${drop}`); // about three card payments
});

test('imported household: a bill already charged early this month is not due again before next month', () => {
  const input = importedHousehold();
  // November's electric came on the 3rd instead of the 14th.
  input.txns.push(txn({ account_id: 'acct_p_chk', date: '2026-11-03', amount: -140.12, merchant: 'TXU Energy', category: 'utilities' }));
  const a = analyzeHousehold(input, TODAY);
  const txuBill = a.derived_obligations.find((o) => o.name === 'TXU Energy')!;
  assert.equal(txuBill.due_day, 14);
  assert.equal(a.forecast.find((p) => p.date === '2026-11-14')!.obligations_due, 0);
  assert.equal(a.forecast.find((p) => p.date === '2026-12-14')!.obligations_due, txuBill.amount);
});

test('imported household: a payee renamed or re-filed between bank syncs is one bill; a misfiled utility is not a card payment', () => {
  const input = importedHousehold();
  for (const m of ['2026-05', '2026-06', '2026-07', '2026-08']) {
    input.txns.push(txn({ account_id: 'acct_p_chk', date: `${m}-11`, amount: -84.99, merchant: 'SPECTRUM INTERNET AUTOPAY', category: 'credit_card_payment', description: 'SPECTRUM INTERNET AUTOPAY' }));
  }
  for (const m of ['2026-09', '2026-10']) {
    input.txns.push(txn({ account_id: 'acct_p_chk', date: `${m}-11`, amount: -84.99, merchant: 'Spectrum', category: 'utilities', description: 'SPECTRUM INTERNET AUTOPAY' }));
  }
  const a = analyzeHousehold(input, TODAY);
  const spectrum = a.derived_obligations.filter((o) => /spectrum/i.test(o.name));
  assert.deepEqual(spectrum.map(({ name, kind, amount, due_day }) => ({ name, kind, amount, due_day })), [{ name: 'Spectrum internet', kind: 'bill', amount: 84.99, due_day: 11 }]);
  assert.equal(spectrum[0]!.txn_ids.length, 6);
  assert.equal(a.derived_obligations.filter((o) => o.kind === 'loan').length, 1); // still only the card payment
});

test('detection never runs for a household with obligations on file, even if asked to', () => {
  const seeded = baseHousehold();
  const plain = analyzeHousehold(seeded, TODAY);
  const asked = analyzeHousehold({ ...seeded, derive_obligations: true }, TODAY);
  assert.deepEqual(asked, plain);
  assert.deepEqual(plain.derived_obligations, []);
});

// ---- regression: the five seeded families keep exactly their numbers -----------------------------------------------
// Fingerprints of analyzeHousehold on data/seed/*.json, taken with the code from before bill detection existed. Any change
// to a seeded family's indicators, forecast, alerts or cash numbers fails here.
const SEED_DIR = new URL('../../data/seed/', import.meta.url);
const SEEDED_ANALYSIS_SHA256: Record<string, string> = {
  hh_rivera: '3c8993998b2d87140ae59abd82bf2db46b758ddff2e844266e9e0ff0caad5cb0',
  hh_okafor: '01941002adc99b60a9daa440aea010ee8a30725115e2b9482329e1d266ccd378',
  hh_nguyen: '14a5f3dd191ce69ebe07de7c61f54463f40bec5517901d47d7714c70668852eb',
  hh_patel: 'af2bda85007cb8529af91ba25b0d4335a35cf29a1b871cdb1a8b34e9fd3bdf1f',
  hh_brooks: 'c6a3a503cad1952b1cd27e686557d5b35c579359905934fb9d17c33e1673eccc',
};
const haveSeed = ['households', 'members', 'accounts', 'transactions', 'credit_profiles', 'obligations'].every((f) => existsSync(new URL(`${f}.json`, SEED_DIR)));

test('the seeded families are unchanged: same indicators, forecast, alerts and cash numbers, and no detected bills', { skip: !haveSeed }, () => {
  const rows = (f: string): Record<string, any>[] => JSON.parse(readFileSync(new URL(`${f}.json`, SEED_DIR), 'utf8'));
  const accounts = rows('accounts');
  const allTxns = rows('transactions');
  const seen: string[] = [];
  for (const hh of rows('households')) {
    const accts = accounts.filter((a) => a.household_id === hh.id);
    const ids = new Set(accts.map((a) => a.id));
    const input: HouseholdInput = {
      household_id: hh.id,
      home_value: hh.home_value,
      vehicle_value: hh.vehicle_value,
      accounts: accts as never,
      txns: allTxns.filter((t) => ids.has(t.account_id)).map((t) => ({ id: t.id, account_id: t.account_id, date: t.date, amount: t.amount, merchant: t.merchant, category: t.category, description: t.description, is_recurring: Boolean(t.is_recurring) })),
      obligations: rows('obligations').filter((o) => o.household_id === hh.id) as never,
      members: rows('members').filter((m) => m.household_id === hh.id) as never,
      credit: rows('credit_profiles').filter((c) => c.household_id === hh.id) as never,
    };
    for (const derive of [undefined, true]) {
      const a = analyzeHousehold({ ...input, derive_obligations: derive }, '2026-11-07');
      const { as_of, indicators, forecast, alerts, cash } = a;
      const sha = createHash('sha256').update(JSON.stringify({ as_of, indicators, forecast, alerts, cash })).digest('hex');
      assert.equal(sha, SEEDED_ANALYSIS_SHA256[hh.id], `${hh.id} changed (derive_obligations=${derive})`);
      assert.deepEqual(a.derived_obligations, []);
    }
    seen.push(hh.id);
  }
  assert.deepEqual(seen.sort(), Object.keys(SEEDED_ANALYSIS_SHA256).sort());
});
