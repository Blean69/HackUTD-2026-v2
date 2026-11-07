// PLAID_* environment -> PlaidConfig. Read lazily (after index.ts has loaded the repo-root .env), never logged.
import type { PlaidConfig } from './types.js';

const list = (v: string | undefined, d: string[]): string[] => {
  const xs = (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return xs.length ? xs : d;
};

/** null when PLAID_CLIENT_ID or PLAID_SECRET is missing: the routes then answer 503 plaid_unconfigured. */
export function loadPlaidConfig(env: NodeJS.ProcessEnv = process.env): PlaidConfig | null {
  const clientId = (env.PLAID_CLIENT_ID ?? '').trim();
  const secret = (env.PLAID_SECRET ?? '').trim();
  if (!clientId || !secret) return null;
  return {
    clientId,
    secret,
    env: (env.PLAID_ENV ?? '').trim().toLowerCase() || 'sandbox',
    products: list(env.PLAID_PRODUCTS, ['transactions', 'liabilities', 'investments']),
    countryCodes: list(env.PLAID_COUNTRY_CODES, ['us']).map((c) => c.toUpperCase()),
  };
}
