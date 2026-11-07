// The slice of the Plaid API the worker uses, as plain structural types. The real client (client.ts) returns response
// bodies in exactly this shape; tests pass a fake that implements `PlaidClient`. Nothing here imports the plaid package.

export interface PlaidBalances {
  available: number | null;
  current: number | null;
  limit: number | null;
  iso_currency_code?: string | null;
}

export interface PlaidAccount {
  account_id: string;
  balances: PlaidBalances;
  mask: string | null;
  name: string;
  official_name: string | null;
  /** depository | credit | loan | investment | brokerage | other */
  type: string;
  subtype: string | null;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Plaid sign: positive = money out of the account. */
  amount: number;
  date: string;
  name: string;
  merchant_name?: string | null;
  pending?: boolean;
  personal_finance_category?: { primary: string; detailed: string } | null;
  /** Legacy category hierarchy; only a fallback. */
  category?: string[] | null;
  counterparties?: { name: string; type?: string }[] | null;
}

export interface PlaidLiabilities {
  credit?: { account_id: string | null; aprs?: { apr_percentage: number; apr_type: string }[]; minimum_payment_amount?: number | null }[] | null;
  mortgage?: { account_id: string; interest_rate?: { percentage: number | null } | null; next_monthly_payment?: number | null; maturity_date?: string | null; origination_date?: string | null }[] | null;
  student?: { account_id: string | null; interest_rate_percentage?: number | null; minimum_payment_amount?: number | null; expected_payoff_date?: string | null; origination_date?: string | null }[] | null;
  loan?: { account_id: string | null; interest_rate_percentage?: number | null; minimum_payment_amount?: number | null; expected_payoff_date?: string | null; origination_date?: string | null }[] | null;
  line_of_credit?: unknown[] | null;
}

export type UpdateStatus = 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN' | 'NOT_READY' | 'INITIAL_UPDATE_COMPLETE' | 'HISTORICAL_UPDATE_COMPLETE' | string;

export interface SyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string; account_id?: string }[];
  next_cursor: string;
  has_more: boolean;
  transactions_update_status?: UpdateStatus;
}

export interface LinkTokenRequest {
  client_user_id: string;
  products: string[];
  country_codes: string[];
}

export interface SandboxPublicTokenRequest {
  institution_id: string;
  initial_products: string[];
  username: string;
}

/** What the worker needs from Plaid. Every method resolves with the response body or rejects with a PlaidApiError. */
export interface PlaidClient {
  linkTokenCreate(req: LinkTokenRequest): Promise<{ link_token: string; expiration?: string }>;
  sandboxPublicTokenCreate(req: SandboxPublicTokenRequest): Promise<{ public_token: string }>;
  itemPublicTokenExchange(publicToken: string): Promise<{ access_token: string; item_id: string }>;
  /** Best effort: the institution behind an item (from /item/get + /institutions/get_by_id). */
  itemInstitution(accessToken: string): Promise<{ institution_id: string; name: string } | null>;
  institutionName(institutionId: string): Promise<string | null>;
  accountsGet(accessToken: string): Promise<{ accounts: PlaidAccount[]; item?: { institution_id?: string | null } }>;
  liabilitiesGet(accessToken: string): Promise<{ accounts?: PlaidAccount[]; liabilities: PlaidLiabilities }>;
  transactionsSync(accessToken: string, cursor: string, count?: number): Promise<SyncPage>;
}

/** A Plaid API error (or a transport failure). Never contains the client secret or an access token. */
export class PlaidApiError extends Error {
  constructor(
    message: string,
    readonly code: string = 'UNKNOWN',
    readonly type: string = 'API_ERROR',
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'PlaidApiError';
  }
}

export const isPlaidError = (e: unknown, ...codes: string[]): e is PlaidApiError => e instanceof PlaidApiError && (codes.length === 0 || codes.includes(e.code));

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: string;
  products: string[];
  countryCodes: string[];
}
