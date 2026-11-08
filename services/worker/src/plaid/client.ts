// The real Plaid client: the official `plaid` npm package (its `plaid/legacy` entry point), narrowed to PlaidClient.
// Errors are reduced to Plaid's own error body (code, type, message, request id): the axios error object carries the
// request headers, which include the client id and secret, so it is never logged or rethrown.
import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from 'plaid/legacy';
import { PlaidApiError, type PlaidClient, type PlaidConfig } from './types.js';

export function toPlaidError(e: unknown): PlaidApiError {
  if (e instanceof PlaidApiError) return e;
  const err = e as { response?: { status?: number; data?: Record<string, unknown> }; code?: string; message?: string };
  const d = err?.response?.data;
  if (d && typeof d === 'object' && typeof d.error_code === 'string') {
    const msg = String(d.display_message ?? d.error_message ?? d.error_code);
    return new PlaidApiError(msg, d.error_code, String(d.error_type ?? 'API_ERROR'), err.response?.status, typeof d.request_id === 'string' ? d.request_id : undefined);
  }
  const status = err?.response?.status;
  return new PlaidApiError(status ? `Plaid answered HTTP ${status}` : `Could not reach Plaid (${err?.code ?? err?.message ?? 'network error'})`, status ? 'HTTP_ERROR' : 'NETWORK_ERROR', 'TRANSPORT', status);
}

async function wrap<T>(p: Promise<{ data: T }>): Promise<T> {
  try {
    return (await p).data;
  } catch (e) {
    throw toPlaidError(e);
  }
}

export function createPlaidClient(cfg: PlaidConfig): PlaidClient {
  const basePath = (PlaidEnvironments as Record<string, string>)[cfg.env];
  if (!basePath) throw new PlaidApiError(`PLAID_ENV "${cfg.env}" is not one of ${Object.keys(PlaidEnvironments).join(', ')}`, 'BAD_ENV');
  const api = new PlaidApi(new Configuration({ basePath, baseOptions: { headers: { 'PLAID-CLIENT-ID': cfg.clientId, 'PLAID-SECRET': cfg.secret, 'Plaid-Version': '2020-09-14' }, timeout: 30_000 } }));
  const products = (xs: string[]): Products[] => xs as Products[];
  const countries = cfg.countryCodes as CountryCode[];

  return {
    linkTokenCreate: (r) =>
      wrap(api.linkTokenCreate({ client_name: 'Keystone', language: 'en', country_codes: countries.length ? countries : [CountryCode.Us], user: { client_user_id: r.client_user_id }, products: products(r.products) })),
    sandboxPublicTokenCreate: (r) =>
      wrap(api.sandboxPublicTokenCreate({ institution_id: r.institution_id, initial_products: products(r.initial_products), options: { override_username: r.username, override_password: r.password ?? 'pass_good', ...(r.password ? { transactions: { days_requested: 365 } } : {}) } })),  // a custom user carries ~6 months of history: Plaid's default window is 90 days, and 180 silently clips the first ~10 days of a 6-month profile once its dates roll forward (checked live)
    itemPublicTokenExchange: (public_token) => wrap(api.itemPublicTokenExchange({ public_token })),
    async institutionName(institution_id) {
      try {
        const r = await wrap(api.institutionsGetById({ institution_id, country_codes: countries.length ? countries : [CountryCode.Us] }));
        return r.institution?.name ?? null;
      } catch {
        return null;
      }
    },
    async itemInstitution(access_token) {
      try {
        const item = await wrap(api.itemGet({ access_token }));
        const id = item.item?.institution_id;
        if (!id) return null;
        const r = await wrap(api.institutionsGetById({ institution_id: id, country_codes: countries.length ? countries : [CountryCode.Us] }));
        return { institution_id: id, name: r.institution?.name ?? '' };
      } catch {
        return null;
      }
    },
    accountsGet: (access_token) => wrap(api.accountsGet({ access_token })),
    liabilitiesGet: (access_token) => wrap(api.liabilitiesGet({ access_token })),
    transactionsSync: (access_token, cursor, count = 500) => wrap(api.transactionsSync({ access_token, ...(cursor ? { cursor } : {}), count, options: { include_personal_finance_category: true } })),
  };
}
