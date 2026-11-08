import { describe, expect, it } from 'vitest';
import { liabilities, pAcct, ptxn } from '../testing/plaid_fake.js';
import { accountId, inferMonthlyPayment, liabilityFacts, mapAccount, mapAccountType, mapBalance, mapCategory, mapTxn, txnId } from './mapping.js';

describe('Plaid account type mapping', () => {
  it.each([
    ['depository', 'checking', 'checking'],
    ['depository', 'savings', 'savings'],
    ['depository', 'cd', 'cd'],
    ['depository', 'money market', 'savings'],
    ['depository', 'cash management', 'checking'],
    ['investment', 'ira', 'ira'],
    ['investment', '401k', 'ira'],
    ['investment', 'roth', 'ira'],
    ['credit', 'credit card', 'credit_card'],
    ['loan', 'mortgage', 'mortgage'],
    ['loan', 'auto', 'auto_loan'],
    ['loan', 'student', 'personal_loan'],
    ['loan', 'personal', 'personal_loan'],
    ['loan', 'consumer', 'personal_loan'], // how data/pnc_profiles.py files a PNC personal loan
  ])('%s/%s -> %s without asking a model', (type, subtype, want) => {
    const d = mapAccountType(type, subtype);
    expect(d.type).toBe(want);
    expect(d.confident).toBe(true);
  });

  it.each([
    ['depository', 'hsa', 'savings'],
    ['depository', 'prepaid', 'checking'],
    ['investment', 'brokerage', 'savings'],
    ['investment', '529', 'savings'],
    ['loan', 'home equity', 'mortgage'],
    ['loan', 'line of credit', 'personal_loan'],
    ['other', 'other', 'checking'],
  ])('%s/%s is a flagged guess (%s)', (type, subtype, want) => {
    const d = mapAccountType(type, subtype);
    expect(d.type).toBe(want);
    expect(d.confident).toBe(false);
  });

  it('tolerates a missing subtype and odd casing', () => {
    expect(mapAccountType('Depository', null).confident).toBe(false);
    expect(mapAccountType('LOAN', 'Mortgage')).toMatchObject({ type: 'mortgage', confident: true });
    expect(mapAccountType('investment', 'Roth_401k')).toMatchObject({ type: 'ira', confident: true });
  });
});

describe('Plaid account rows', () => {
  it('uses acct_plaid_ ids, positive debt balances, credit limits and liability terms', () => {
    const f = liabilityFacts(liabilities());
    const card = mapAccount(pAcct('cc000000', 'credit', 'credit card', 410, { balances: { available: null, current: 410, limit: 2000 } }), { householdId: 'hh_x', institution: 'First Platypus Bank', type: 'credit_card', liability: f.get('cc000000') });
    expect(card).toMatchObject({ id: 'acct_plaid_cc000000', household_id: 'hh_x', type: 'credit_card', balance: 410, credit_limit: 2000, rate_pct: 27.95, monthly_payment: 25, institution: 'First Platypus Bank' });
    const mtg = mapAccount(pAcct('mtg00000', 'loan', 'mortgage', 56302.06), { householdId: 'hh_x', institution: 'B', type: 'mortgage', liability: f.get('mtg00000') });
    expect(mtg).toMatchObject({ balance: 56302.06, rate_pct: 3.99, monthly_payment: 3141.54, maturity_date: '2045-07-28', opened_date: '2015-07-28' });
    expect(mtg.credit_limit).toBeUndefined();
  });
  it('never reports a negative amount owed, but keeps an overdrawn deposit account negative', () => {
    expect(mapBalance(pAcct('a', 'credit', 'credit card', -20), 'credit_card')).toBe(0);
    expect(mapBalance(pAcct('b', 'depository', 'checking', -35.5), 'checking')).toBe(-35.5);
    expect(mapBalance({ ...pAcct('c', 'depository', 'checking', 0), balances: { available: 12, current: null, limit: null } }, 'checking')).toBe(12);
  });
  it('builds a readable nickname and leaves unknown dates empty', () => {
    const row = mapAccount(pAcct('x1234', 'depository', 'checking', 5, { name: 'Plaid Checking', official_name: 'Plaid Gold Standard 0% Interest Checking', mask: '0000' }), { householdId: 'h', institution: 'B', type: 'checking' });
    expect(row.nickname).toBe('Plaid Gold Standard 0% Interest Checking ••0000');
    expect(row.opened_date).toBe('');
  });
});

describe('Plaid transaction rows', () => {
  it('flips the sign: Plaid positive = outflow becomes negative, deposits positive', () => {
    expect(mapTxn(ptxn('t1', 'a1', 89.4, '2026-11-01', 'STARBUCKS #1234', ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE'], { merchant_name: 'Starbucks' }), 'hh_x')).toMatchObject({ id: 'txn_plaid_t1', account_id: 'acct_plaid_a1', amount: -89.4, merchant: 'Starbucks', category: 'dining', description: 'STARBUCKS #1234', is_recurring: false, household_id: 'hh_x', date: '2026-11-01' });
    expect(mapTxn(ptxn('t2', 'a1', -4200, '2026-11-02', 'ACME PAYROLL', ['INCOME', 'INCOME_WAGES']), 'hh_x')).toMatchObject({ amount: 4200, category: 'income', merchant: 'ACME PAYROLL' });
    expect(Object.is(mapTxn(ptxn('t3', 'a1', 0, '2026-11-02', 'Zero'), 'h').amount, -0)).toBe(false);
  });
  it('rounds to cents, marks pending, and falls back from merchant_name to counterparty to name', () => {
    expect(mapTxn(ptxn('t4', 'a', 10.005, '2026-11-02T00:00:00Z', 'X'), 'h')).toMatchObject({ amount: -10.01, date: '2026-11-02' });
    expect(mapTxn(ptxn('t5', 'a', 1, '2026-11-02', 'RAW NAME', undefined, { pending: true, counterparties: [{ name: 'Nice Name' }] }), 'h')).toMatchObject({ merchant: 'Nice Name', description: 'RAW NAME (pending)' });
  });
  it('derives categories from personal_finance_category the way the math expects', () => {
    const c = (primary: string, detailed: string) => mapCategory({ personal_finance_category: { primary, detailed } });
    expect(c('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES')).toBe('groceries');
    expect(c('TRANSPORTATION', 'TRANSPORTATION_GAS')).toBe('fuel');
    expect(c('TRANSPORTATION', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES')).toBe('transport');
    expect(c('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')).toBe('credit_card_payment');
    expect(c('LOAN_PAYMENTS', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT')).toBe('mortgage');
    expect(c('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT')).toBe('loan_payment');
    expect(c('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER')).toBe('transfer');
    expect(c('TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS')).toBe('savings');
    expect(c('TRANSFER_IN', 'TRANSFER_IN_DEPOSIT')).toBe('deposit');
    expect(c('LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_PERSONAL_LOAN_DISBURSEMENT')).toBe('transfer');
    expect(c('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT')).toBe('rent');
    expect(c('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY')).toBe('utilities');
    expect(c('BANK_FEES', 'BANK_FEES_INTEREST_CHARGE')).toBe('interest');
    expect(c('GENERAL_SERVICES', 'GENERAL_SERVICES_INSURANCE')).toBe('insurance');
    expect(c('GOVERNMENT_AND_NON_PROFIT', 'GOVERNMENT_AND_NON_PROFIT_DONATIONS')).toBe('charity');
    expect(mapCategory({ personal_finance_category: null, category: ['Food and Drink', 'Restaurants'] })).toBe('food_and_drink');
    expect(mapCategory({ personal_finance_category: null })).toBe('other');
  });
  it('ids carry the plaid prefixes', () => {
    expect(accountId('abc')).toBe('acct_plaid_abc');
    expect(txnId('xyz')).toBe('txn_plaid_xyz');
  });
});

describe('inferMonthlyPayment', () => {
  it('is the median of the latest three payments (Keystone sign: payments positive, interest and fees negative)', () => {
    const rows = [
      { date: '2026-05-05', amount: 999 },
      { date: '2026-08-05', amount: 1810 },
      { date: '2026-09-05', amount: 1830 },
      { date: '2026-10-05', amount: 1820 },
      { date: '2026-10-05', amount: -220 }, // interest
    ];
    expect(inferMonthlyPayment(rows)).toBe(1820);
    expect(inferMonthlyPayment(rows.slice(2, 4))).toBe(1825); // two payments: their mean
  });
  it('needs two payments, and ignores accounts with none', () => {
    expect(inferMonthlyPayment([{ date: '2026-10-05', amount: 300 }])).toBeUndefined();
    expect(inferMonthlyPayment([{ date: '2026-10-05', amount: -30 }, { date: '2026-09-05', amount: -30 }])).toBeUndefined();
    expect(inferMonthlyPayment([])).toBeUndefined();
  });
});
