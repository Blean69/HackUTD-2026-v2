// Fake Plaid client + sandbox-like fixtures for the Plaid tests. No network.
import { PlaidApiError, type PlaidAccount, type PlaidClient, type PlaidConfig, type PlaidLiabilities, type PlaidTransaction, type SyncPage } from '../plaid/types.js';

export const CONFIG: PlaidConfig = { clientId: 'cid_test', secret: 'secret_test_value', env: 'sandbox', products: ['transactions', 'liabilities', 'investments'], countryCodes: ['US'] };

export function pAcct(id: string, type: string, subtype: string | null, current: number, extra: Partial<PlaidAccount> = {}): PlaidAccount {
  return { account_id: id, balances: { available: current, current, limit: null }, mask: id.slice(-4), name: `Plaid ${subtype ?? type}`, official_name: null, type, subtype, ...extra };
}

/** 10 accounts shaped like First Platypus Bank's sandbox user. */
export function sandboxAccounts(): PlaidAccount[] {
  return [
    pAcct('chk00000', 'depository', 'checking', 110),
    pAcct('sav00000', 'depository', 'savings', 210),
    pAcct('cd000000', 'depository', 'cd', 1000),
    pAcct('mm000000', 'depository', 'money market', 43200),
    pAcct('cc000000', 'credit', 'credit card', 410, { balances: { available: null, current: 410, limit: 2000 } }),
    pAcct('k4010000', 'investment', '401k', 23631.98),
    pAcct('ira00000', 'investment', 'ira', 320.76),
    pAcct('brk00000', 'investment', 'brokerage', 1500),
    pAcct('mtg00000', 'loan', 'mortgage', 56302.06),
    pAcct('stu00000', 'loan', 'student', 65262),
  ];
}

export function liabilities(): PlaidLiabilities {
  return {
    credit: [{ account_id: 'cc000000', aprs: [{ apr_percentage: 15.24, apr_type: 'balance_transfer_apr' }, { apr_percentage: 27.95, apr_type: 'purchase_apr' }], minimum_payment_amount: 25 }],
    mortgage: [{ account_id: 'mtg00000', interest_rate: { percentage: 3.99 }, next_monthly_payment: 3141.54, maturity_date: '2045-07-28', origination_date: '2015-07-28' }],
    student: [{ account_id: 'stu00000', interest_rate_percentage: 5.25, minimum_payment_amount: 138.05, expected_payoff_date: '2032-07-28', origination_date: '2012-08-28' }],
  };
}

export function ptxn(id: string, account: string, amount: number, date: string, name: string, pfc?: [string, string], extra: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return { transaction_id: id, account_id: account, amount, date, name, merchant_name: null, pending: false, personal_finance_category: pfc ? { primary: pfc[0], detailed: pfc[1] } : null, ...extra };
}

export function page(p: Partial<SyncPage> & { next_cursor: string }): SyncPage {
  return { added: [], modified: [], removed: [], has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE', ...p };
}

export class FakePlaid implements PlaidClient {
  calls: { method: string; args: unknown[] }[] = [];
  accounts: PlaidAccount[] = sandboxAccounts();
  liab: PlaidLiabilities | Error = liabilities();
  /** Served in order; an Error is thrown. The last entry repeats. */
  syncScript: (SyncPage | Error)[] = [];
  syncCursors: string[] = [];
  accountsError: Error | null = null;
  publicTokenErrors = new Map<string, Error>();
  institutions: Record<string, string> = { ins_109508: 'First Platypus Bank' };
  private syncIdx = 0;

  private rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  async linkTokenCreate(req: { client_user_id: string; products: string[]; country_codes: string[] }) {
    this.rec('linkTokenCreate', req);
    return { link_token: 'link-sandbox-abc123', expiration: '2026-11-08T00:00:00Z' };
  }
  async sandboxPublicTokenCreate(req: { institution_id: string; initial_products: string[]; username: string }) {
    this.rec('sandboxPublicTokenCreate', req);
    const err = this.publicTokenErrors.get(req.username);
    if (err) throw err;
    return { public_token: `public-sandbox-${req.username}` };
  }
  async itemPublicTokenExchange(publicToken: string) {
    this.rec('itemPublicTokenExchange', publicToken);
    return { access_token: 'access-sandbox-SECRET-TOKEN', item_id: 'item_fake_1' };
  }
  async institutionName(id: string) {
    this.rec('institutionName', id);
    return this.institutions[id] ?? null;
  }
  async itemInstitution(accessToken: string) {
    this.rec('itemInstitution', accessToken);
    return { institution_id: 'ins_109508', name: 'First Platypus Bank' };
  }
  async accountsGet(accessToken: string) {
    this.rec('accountsGet', accessToken);
    if (this.accountsError) throw this.accountsError;
    return { accounts: this.accounts, item: { institution_id: 'ins_109508' } };
  }
  async liabilitiesGet(accessToken: string) {
    this.rec('liabilitiesGet', accessToken);
    if (this.liab instanceof Error) throw this.liab;
    return { liabilities: this.liab };
  }
  async transactionsSync(accessToken: string, cursor: string, count?: number) {
    this.rec('transactionsSync', accessToken, cursor, count);
    this.syncCursors.push(cursor);
    const step = this.syncScript[Math.min(this.syncIdx, this.syncScript.length - 1)];
    this.syncIdx++;
    if (!step) throw new Error('no sync script');
    if (step instanceof Error) throw step;
    return step;
  }
}

export const notReady = (): PlaidApiError => new PlaidApiError('the requested product is not yet ready', 'PRODUCT_NOT_READY', 'ITEM_ERROR', 400);
