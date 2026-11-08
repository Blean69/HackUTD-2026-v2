// Pure Plaid -> Keystone mappings: account types, accounts, transactions, categories. No I/O.
import type { PlaidAccount, PlaidLiabilities, PlaidTransaction } from './types.js';

export const ACCOUNT_TYPES = ['checking', 'savings', 'cd', 'ira', 'auto_loan', 'personal_loan', 'credit_card', 'mortgage'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const DEBT_TYPES: ReadonlySet<string> = new Set(['auto_loan', 'personal_loan', 'credit_card', 'mortgage']);

export const accountId = (plaidAccountId: string): string => `acct_plaid_${plaidAccountId}`;
export const txnId = (plaidTransactionId: string): string => `txn_plaid_${plaidTransactionId}`;

const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

// ---- account type ------------------------------------------------------------------------------------------------------

export interface TypeDecision {
  type: AccountType;
  /** false = a guess: the fast model is asked about it. */
  confident: boolean;
  /** One line for the trace. */
  why: string;
}

const RETIREMENT = new Set(['ira', 'roth', 'roth 401k', '401k', '401a', '403b', '457b', 'sep ira', 'simple ira', 'keogh', 'pension', 'retirement', 'sarsep', 'profit sharing plan', 'thrift savings plan', 'roth ira']);

const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/[_-]+/g, ' ').trim();

/** Plaid type/subtype -> one of our 8 account types. Anything outside the clear rules is flagged for the model. */
export function mapAccountType(type: string, subtype: string | null | undefined): TypeDecision {
  const t = norm(type);
  const s = norm(subtype);
  const ok = (a: AccountType, why: string): TypeDecision => ({ type: a, confident: true, why });
  const guess = (a: AccountType, why: string): TypeDecision => ({ type: a, confident: false, why });

  if (t === 'depository') {
    if (s === 'checking') return ok('checking', 'depository/checking');
    if (s === 'savings') return ok('savings', 'depository/savings');
    if (s === 'cd') return ok('cd', 'depository/cd');
    if (s === 'money market') return ok('savings', 'money market behaves like savings');
    if (s === 'cash management') return ok('checking', 'cash management behaves like checking');
    if (s === 'hsa') return guess('savings', 'HSA is a savings-like deposit account');
    return guess('checking', `depository/${s || 'unknown'}`);
  }
  if (t === 'credit') {
    if (s === 'credit card' || s === 'paypal') return ok('credit_card', `credit/${s}`);
    return guess('credit_card', `credit/${s || 'unknown'}`);
  }
  if (t === 'loan') {
    if (s === 'mortgage') return ok('mortgage', 'loan/mortgage');
    if (s === 'auto') return ok('auto_loan', 'loan/auto');
    if (s === 'student') return ok('personal_loan', 'student loans are filed as personal loans');
    if (s === 'personal' || s === 'consumer') return ok('personal_loan', `loan/${s}`); // Plaid has no 'personal' subtype: a personal loan is its 'consumer' loan
    if (s === 'home equity') return guess('mortgage', 'home equity loans are secured by the house');
    return guess('personal_loan', `loan/${s || 'unknown'}`);
  }
  if (t === 'investment' || t === 'brokerage') {
    if (RETIREMENT.has(s)) return ok('ira', `investment/${s} is a retirement account`);
    return guess('savings', `investment/${s || 'unknown'} is not a retirement account`);
  }
  return guess('checking', `${t || 'unknown'}/${s || 'unknown'} has no obvious match`);
}

// ---- accounts ----------------------------------------------------------------------------------------------------------

export interface AccountRow {
  id: string;
  household_id: string;
  type: AccountType;
  institution: string;
  nickname: string;
  balance: number;
  rate_pct?: number;
  credit_limit?: number;
  monthly_payment?: number;
  maturity_date?: string;
  opened_date: string;
}

interface LiabilityFacts {
  rate_pct?: number;
  monthly_payment?: number;
  maturity_date?: string;
  opened_date?: string;
}

export function liabilityFacts(l: PlaidLiabilities | null | undefined): Map<string, LiabilityFacts> {
  const out = new Map<string, LiabilityFacts>();
  const put = (id: string | null | undefined, f: LiabilityFacts): void => {
    if (!id) return;
    const clean: LiabilityFacts = {};
    if (f.rate_pct !== undefined && Number.isFinite(f.rate_pct)) clean.rate_pct = round2(f.rate_pct);
    if (f.monthly_payment !== undefined && Number.isFinite(f.monthly_payment) && f.monthly_payment > 0) clean.monthly_payment = round2(f.monthly_payment);
    if (f.maturity_date) clean.maturity_date = f.maturity_date;
    if (f.opened_date) clean.opened_date = f.opened_date;
    out.set(id, { ...out.get(id), ...clean });
  };
  for (const c of l?.credit ?? []) {
    const apr = c.aprs?.find((a) => a.apr_type === 'purchase_apr') ?? c.aprs?.[0];
    put(c.account_id, { ...(apr ? { rate_pct: apr.apr_percentage } : {}), ...(c.minimum_payment_amount != null ? { monthly_payment: c.minimum_payment_amount } : {}) });
  }
  for (const m of l?.mortgage ?? []) {
    put(m.account_id, { ...(m.interest_rate?.percentage != null ? { rate_pct: m.interest_rate.percentage } : {}), ...(m.next_monthly_payment != null ? { monthly_payment: m.next_monthly_payment } : {}), ...(m.maturity_date ? { maturity_date: m.maturity_date } : {}), ...(m.origination_date ? { opened_date: m.origination_date } : {}) });
  }
  for (const s of [...(l?.student ?? []), ...(l?.loan ?? [])]) {
    put(s.account_id, { ...(s.interest_rate_percentage != null ? { rate_pct: s.interest_rate_percentage } : {}), ...(s.minimum_payment_amount != null ? { monthly_payment: s.minimum_payment_amount } : {}), ...(s.expected_payoff_date ? { maturity_date: s.expected_payoff_date } : {}), ...(s.origination_date ? { opened_date: s.origination_date } : {}) });
  }
  return out;
}

/** Loan types whose payment Plaid's liabilities cannot give us (custom sandbox users, many real banks): read it from the payment history instead. */
export const PAID_FROM_HISTORY: ReadonlySet<string> = new Set(['mortgage', 'auto_loan', 'personal_loan']);

/**
 * The monthly payment of a loan account, read from what was actually paid: the median of the latest three payments
 * (Keystone sign: a payment received on a debt account is positive; interest and fees are negative and ignored).
 * Needs at least two payments so one lump sum is not mistaken for a schedule.
 */
export function inferMonthlyPayment(rows: { date: string; amount: number }[]): number | undefined {
  const pays = rows.filter((r) => r.amount > 0).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (pays.length < 2) return undefined;
  const last = pays.slice(0, 3).map((r) => r.amount).sort((a, b) => a - b);
  return round2(last.length === 3 ? last[1]! : (last[0]! + last[1]!) / 2);
}

/** Deposit accounts hold money (may be overdrawn); debt accounts hold a positive amount owed. */
export function mapBalance(a: PlaidAccount, type: AccountType): number {
  const cur = a.balances.current ?? a.balances.available ?? 0;
  return round2(DEBT_TYPES.has(type) ? Math.max(0, cur) : cur);
}

export function mapAccount(a: PlaidAccount, o: { householdId: string; institution: string; type: AccountType; liability?: LiabilityFacts | undefined }): AccountRow {
  const base = (a.official_name || a.name || 'Account').trim();
  const nickname = `${base}${a.mask ? ` ••${a.mask}` : ''}`.slice(0, 80);
  const row: AccountRow = {
    id: accountId(a.account_id),
    household_id: o.householdId,
    type: o.type,
    institution: o.institution,
    nickname,
    balance: mapBalance(a, o.type),
    // Plaid does not say when an account was opened; only loans carry an origination date
    opened_date: o.liability?.opened_date ?? '',
  };
  if (o.liability?.rate_pct !== undefined) row.rate_pct = o.liability.rate_pct;
  if (o.liability?.monthly_payment !== undefined) row.monthly_payment = o.liability.monthly_payment;
  if (o.liability?.maturity_date) row.maturity_date = o.liability.maturity_date;
  if (o.type === 'credit_card' && a.balances.limit != null && a.balances.limit > 0) row.credit_limit = round2(a.balances.limit);
  return row;
}

// ---- transactions ------------------------------------------------------------------------------------------------------

export interface TxnRow {
  id: string;
  household_id: string;
  account_id: string;
  date: string;
  /** Keystone sign: negative = outflow. */
  amount: number;
  merchant: string;
  category: string;
  description: string;
  is_recurring: false;
}

/** Plaid personal_finance_category -> the lowercase category words the seed data and the SpacetimeDB math use. */
export function mapCategory(t: Pick<PlaidTransaction, 'personal_finance_category' | 'category'>): string {
  const pfc = t.personal_finance_category;
  if (pfc?.primary) {
    const primary = pfc.primary.toUpperCase();
    // 'RENT_AND_UTILITIES_RENT' -> 'RENT': drop the primary prefix so a word in the prefix cannot match
    const full = (pfc.detailed ?? '').toUpperCase();
    const detailed = full.startsWith(`${primary}_`) ? full.slice(primary.length + 1) : full;
    const has = (s: string): boolean => detailed.includes(s);
    switch (primary) {
      case 'INCOME':
        return 'income';
      case 'TRANSFER_IN':
        if (has('SAVINGS') || has('INVESTMENT_AND_RETIREMENT')) return 'savings';
        if (has('DEPOSIT')) return 'deposit';
        return 'transfer';
      case 'TRANSFER_OUT':
        if (has('SAVINGS') || has('INVESTMENT_AND_RETIREMENT')) return 'savings';
        return 'transfer';
      case 'LOAN_PAYMENTS':
        if (has('CREDIT_CARD')) return 'credit_card_payment';
        if (has('MORTGAGE')) return 'mortgage';
        return 'loan_payment';
      case 'LOAN_DISBURSEMENTS':
        return 'transfer'; // borrowed money arriving is not income
      case 'BANK_FEES':
        return has('INTEREST') ? 'interest' : 'fees';
      case 'ENTERTAINMENT':
        return 'entertainment';
      case 'FOOD_AND_DRINK':
        return has('GROCERIES') ? 'groceries' : 'dining';
      case 'GENERAL_MERCHANDISE':
        return 'shopping';
      case 'HOME_IMPROVEMENT':
        return 'home_repair';
      case 'MEDICAL':
        return 'health';
      case 'PERSONAL_CARE':
        return 'personal_care';
      case 'GENERAL_SERVICES':
        if (has('INSURANCE')) return 'insurance';
        if (has('EDUCATION')) return 'education';
        if (has('CHILDCARE')) return 'kids';
        if (has('AUTOMOTIVE')) return 'auto';
        return 'services';
      case 'GOVERNMENT_AND_NON_PROFIT':
        if (has('DONATIONS')) return 'charity';
        if (has('TAX')) return 'taxes';
        return 'government';
      case 'TRANSPORTATION':
        return has('GAS') ? 'fuel' : 'transport';
      case 'TRAVEL':
        return 'travel';
      case 'RENT_AND_UTILITIES':
        return detailed === 'RENT' ? 'rent' : 'utilities';
      case 'OTHER':
        return 'other';
      default:
        return primary.toLowerCase();
    }
  }
  const legacy = t.category?.[0];
  return legacy ? legacy.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'other' : 'other';
}

export function mapTxn(t: PlaidTransaction, householdId: string): TxnRow {
  const merchant = (t.merchant_name || t.counterparties?.[0]?.name || t.name || 'Unknown').trim();
  // Plaid: positive = outflow. Keystone: negative = outflow. `|| 0` avoids -0 for zero amounts.
  const amount = round2(-t.amount) || 0;
  return {
    id: txnId(t.transaction_id),
    household_id: householdId,
    account_id: accountId(t.account_id),
    date: t.date.slice(0, 10),
    amount,
    merchant: merchant.slice(0, 120),
    category: mapCategory(t),
    description: `${(t.name || merchant).trim().slice(0, 160)}${t.pending ? ' (pending)' : ''}`,
    is_recurring: false,
  };
}
