import { describe, expect, it } from 'vitest';
import { CONFIG } from '../testing/plaid_fake.js';
import { createPlaidClient, toPlaidError } from './client.js';
import { PlaidApiError } from './types.js';

describe('Plaid client', () => {
  it('reduces an axios error to Plaid\'s error body, without the request headers that hold the secret', () => {
    const axiosLike = Object.assign(new Error('Request failed with status code 400'), {
      config: { headers: { 'PLAID-CLIENT-ID': 'cid_test', 'PLAID-SECRET': 'secret_test_value' } },
      response: { status: 400, data: { error_type: 'ITEM_ERROR', error_code: 'PRODUCT_NOT_READY', error_message: 'the requested product is not yet ready', display_message: null, request_id: 'req_9' } },
    });
    const e = toPlaidError(axiosLike);
    expect(e).toBeInstanceOf(PlaidApiError);
    expect(e).toMatchObject({ code: 'PRODUCT_NOT_READY', type: 'ITEM_ERROR', status: 400, requestId: 'req_9', message: 'the requested product is not yet ready' });
    expect(JSON.stringify(e)).not.toContain('secret_test_value');
    expect(Object.keys(e)).not.toContain('config');
  });
  it('turns transport failures into NETWORK_ERROR', () => {
    expect(toPlaidError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('ECONNRESET') });
    expect(toPlaidError({ response: { status: 502, data: '<html>' } })).toMatchObject({ code: 'HTTP_ERROR', status: 502 });
  });
  it('builds a client for sandbox and rejects an unknown PLAID_ENV', () => {
    const c = createPlaidClient(CONFIG);
    for (const m of ['linkTokenCreate', 'sandboxPublicTokenCreate', 'itemPublicTokenExchange', 'accountsGet', 'liabilitiesGet', 'transactionsSync'] as const) expect(typeof c[m]).toBe('function');
    expect(() => createPlaidClient({ ...CONFIG, env: 'mars' })).toThrow(/PLAID_ENV/);
  });
});
