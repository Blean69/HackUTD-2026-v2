import { describe, expect, it } from 'vitest';
import { Router, type HttpRequest } from '../http.js';
import { CONFIG, FakePlaid } from '../testing/plaid_fake.js';
import { registerPlaidRoutes } from './routes.js';
import type { PlaidRuntime } from './runtime.js';
import { MemoryPlaidStore } from './store.js';
import { PlaidApiError } from './types.js';
import { loadPlaidConfig } from './config.js';

function setup(over: Partial<PlaidRuntime> = {}, customUser: string | null = null) {
  const store = new MemoryPlaidStore();
  const client = new FakePlaid();
  const rt: PlaidRuntime = { config: CONFIG, client, store, sleep: async () => undefined, pollAttempts: 1, pollMs: 0, ...over };
  const router = new Router();
  registerPlaidRoutes(router, () => rt, () => customUser);
  const post = async (path: string, body: unknown, method = 'POST') => {
    const h = router.find(method, path);
    if (!h) throw new Error(`no route ${method} ${path}`);
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const req: HttpRequest = { method, path, query: new URLSearchParams(), headers: {}, body: async () => Buffer.from(raw) };
    return h(req);
  };
  return { store, client, rt, post };
}

describe('POST /plaid/* routes', () => {
  it('answer 503 plaid_unconfigured without keys', async () => {
    const t = setup({ config: null, client: null });
    for (const path of ['/plaid/link_token', '/plaid/exchange', '/plaid/sandbox_connect']) {
      const r = await t.post(path, { household_id: 'hh_test', public_token: 'x' });
      expect(r.status).toBe(503);
      expect((r.body as { error: string }).error).toBe('plaid_unconfigured');
    }
    const s = await t.post('/plaid/status', {}, 'GET');
    expect(s.body).toMatchObject({ configured: false });
  });

  it('config needs both PLAID_CLIENT_ID and PLAID_SECRET; lists and codes are parsed', () => {
    expect(loadPlaidConfig({ PLAID_CLIENT_ID: 'a' })).toBeNull();
    expect(loadPlaidConfig({ PLAID_SECRET: 'b' })).toBeNull();
    expect(loadPlaidConfig({ PLAID_CLIENT_ID: 'a', PLAID_SECRET: 'b', PLAID_PRODUCTS: 'transactions, liabilities,investments,', PLAID_COUNTRY_CODES: 'us,ca', PLAID_ENV: 'Sandbox' })).toEqual({ clientId: 'a', secret: 'b', env: 'sandbox', products: ['transactions', 'liabilities', 'investments'], countryCodes: ['US', 'CA'] });
    expect(loadPlaidConfig({ PLAID_CLIENT_ID: 'a', PLAID_SECRET: 'b' })).toMatchObject({ env: 'sandbox', products: ['transactions', 'liabilities', 'investments'], countryCodes: ['US'] });
  });

  it('link_token returns the token for the household', async () => {
    const t = setup();
    const r = await t.post('/plaid/link_token', { household_id: 'hh_test' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ link_token: 'link-sandbox-abc123' });
    expect(t.client.calls[0]).toMatchObject({ method: 'linkTokenCreate', args: [{ client_user_id: 'hh_test', products: ['transactions', 'liabilities', 'investments'], country_codes: ['US'] }] });
  });

  it('validates the body', async () => {
    const t = setup();
    expect((await t.post('/plaid/link_token', 'not json')).status).toBe(400);
    expect((await t.post('/plaid/link_token', {})).body).toEqual({ error: 'household_id_required' });
    expect((await t.post('/plaid/exchange', { household_id: 'hh_test' })).body).toEqual({ error: 'public_token_required' });
    expect((await t.post('/plaid/exchange', { household_id: 'hh_nope', public_token: 'p' })).status).toBe(404);
    expect(t.client.count('itemPublicTokenExchange')).toBe(0);
  });

  it('exchange: saves the item, sets bank_connection linking, queues request_bank_sync, never returns the token', async () => {
    const t = setup();
    const r = await t.post('/plaid/exchange', { household_id: 'hh_test', public_token: 'public-sandbox-from-link' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: 'linking', item_id: 'item_fake_1', institution_id: 'ins_109508', institution_name: 'First Platypus Bank' });
    expect(JSON.stringify(r.body)).not.toContain('SECRET-TOKEN');
    expect(t.store.itemsById.get('item_fake_1')).toMatchObject({ householdId: 'hh_test', accessToken: 'access-sandbox-SECRET-TOKEN', institutionName: 'First Platypus Bank', cursor: '' });
    expect(t.store.connections.get('item_fake_1')).toMatchObject({ status: 'linking', accountsCount: 0, txnsCount: 0 });
    expect(t.store.syncRequests).toEqual(['hh_test']);
    expect(t.store.calls).toEqual(['saveItem', 'setConnection', 'requestSync']); // in that order
  });

  it('sandbox_connect: First Platypus Bank with user_transactions_dynamic by default', async () => {
    const t = setup();
    const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 'linking', username: 'user_transactions_dynamic', institution_name: 'First Platypus Bank' });
    expect(t.client.calls.find((c) => c.method === 'sandboxPublicTokenCreate')!.args[0]).toEqual({ institution_id: 'ins_109508', initial_products: ['transactions', 'liabilities', 'investments'], username: 'user_transactions_dynamic' });
    expect(t.client.count('institutionName')).toBe(0); // known institution: no extra API call
    expect(t.store.syncRequests).toEqual(['hh_test']);
  });

  it('sandbox_connect twice on the same household reuses the linked bank (re-sync) instead of stacking a second copy; new_item forces one', async () => {
    const t = setup();
    expect((await t.post('/plaid/sandbox_connect', { household_id: 'hh_test' })).body).toMatchObject({ status: 'linking', reused: false });
    const again = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test' });
    expect(again.body).toMatchObject({ ok: true, status: 'syncing', reused: true, item_id: 'item_fake_1', institution_name: 'First Platypus Bank' });
    expect(t.client.count('sandboxPublicTokenCreate')).toBe(1);
    expect(t.store.syncRequests).toEqual(['hh_test', 'hh_test']);
    const forced = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', new_item: true });
    expect(forced.body).toMatchObject({ reused: false });
    expect(t.client.count('sandboxPublicTokenCreate')).toBe(2);
  });

  it('sandbox_connect falls back to user_good when the default user cannot be created, and honours an explicit username', async () => {
    const t = setup();
    t.client.publicTokenErrors.set('user_transactions_dynamic', new PlaidApiError('bad', 'INVALID_FIELD', 'INVALID_REQUEST', 400));
    const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: 'user_good' });

    const e = setup();
    e.client.publicTokenErrors.set('user_custom', new PlaidApiError('nope', 'INVALID_FIELD', 'INVALID_REQUEST', 400));
    const bad = await e.post('/plaid/sandbox_connect', { household_id: 'hh_test', username: 'user_custom' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'plaid_error', code: 'INVALID_FIELD' });
    expect(e.client.calls.filter((c) => c.method === 'sandboxPublicTokenCreate').every((c) => (c.args[0] as { username: string }).username === 'user_custom')).toBe(true);
    expect(e.store.itemsById.size).toBe(0);
  });

  it('sandbox_connect retries with just transactions when the institution rejects the extra products', async () => {
    const t = setup();
    let first = true;
    const orig = t.client.sandboxPublicTokenCreate.bind(t.client);
    t.client.sandboxPublicTokenCreate = async (req) => {
      if (first && req.initial_products.length > 1) {
        first = false;
        t.client.calls.push({ method: 'sandboxPublicTokenCreate', args: [req] });
        throw new PlaidApiError('products not supported', 'PRODUCTS_NOT_SUPPORTED', 'INVALID_INPUT', 400);
      }
      return orig(req);
    };
    const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: 'user_transactions_dynamic', products: ['transactions'] });
  });

  it('maps Plaid API failures to 502 and refuses sandbox_connect outside the sandbox', async () => {
    const t = setup();
    t.client.itemPublicTokenExchange = async () => {
      throw new PlaidApiError('Plaid is down', 'INTERNAL_SERVER_ERROR', 'API_ERROR', 500, 'req_1');
    };
    const r = await t.post('/plaid/exchange', { household_id: 'hh_test', public_token: 'p' });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: 'plaid_error', code: 'INTERNAL_SERVER_ERROR', request_id: 'req_1' });

    const p = setup({ config: { ...CONFIG, env: 'production' } });
    expect((await p.post('/plaid/sandbox_connect', { household_id: 'hh_test' })).body).toMatchObject({ error: 'sandbox_only' });
  });

  it('503 spacetime_unavailable when the worker has no database connection yet', async () => {
    const t = setup({ store: null });
    expect((await t.post('/plaid/exchange', { household_id: 'hh_test', public_token: 'p' })).body).toMatchObject({ error: 'spacetime_unavailable' });
    // link_token needs no database
    expect((await t.post('/plaid/link_token', { household_id: 'hh_test' })).status).toBe(200);
  });

  // ---- onboarding (docs/contracts.md section 7) ---------------------------------------------------------------------

  it('sandbox_connect with select: lists the accounts as options, sets "selecting" and does NOT queue a sync', async () => {
    const t = setup();
    const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', select: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 'selecting', item_id: 'item_fake_1', accounts: 10, reused: false });
    expect(JSON.stringify(r.body)).not.toContain('SECRET-TOKEN');
    expect(t.store.syncRequests).toEqual([]);
    expect(t.store.connections.get('item_fake_1')).toMatchObject({ status: 'selecting', accountsCount: 10 });
    const options = t.store.options.get('item_fake_1')!;
    expect(options).toHaveLength(10);
    expect(options[0]).toMatchObject({ accountId: 'chk00000', name: 'Plaid checking', type: 'depository', subtype: 'checking', balance: 110, mask: '0000' });
    expect(options.find((o) => o.accountId === 'cc000000')).toMatchObject({ type: 'credit', balance: 410 });
    expect(t.store.calls).toEqual(['saveItem', 'setConnection', 'setAccountOptions', 'setConnection']);
  });

  it('exchange with select behaves the same for a Plaid Link public token', async () => {
    const t = setup();
    const r = await t.post('/plaid/exchange', { household_id: 'hh_test', public_token: 'public-sandbox-from-link', select: true });
    expect(r.body).toMatchObject({ ok: true, status: 'selecting', accounts: 10 });
    expect(t.store.syncRequests).toEqual([]);
    expect(t.store.options.get('item_fake_1')).toHaveLength(10);
    // without select nothing changes: the old flow still queues the sync
    const plain = setup();
    expect((await plain.post('/plaid/exchange', { household_id: 'hh_test', public_token: 'p' })).body).toMatchObject({ status: 'linking' });
    expect(plain.store.syncRequests).toEqual(['hh_test']);
    expect(plain.store.options.size).toBe(0);
  });

  it('sandbox_connect select twice reuses the item and refreshes the options instead of syncing', async () => {
    const t = setup();
    await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', select: true });
    t.client.accounts = t.client.accounts.slice(0, 3);
    const again = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', select: true });
    expect(again.body).toMatchObject({ status: 'selecting', reused: true, accounts: 3 });
    expect(t.client.count('sandboxPublicTokenCreate')).toBe(1);
    expect(t.store.options.get('item_fake_1')).toHaveLength(3);
    expect(t.store.syncRequests).toEqual([]);
  });

  it('the demo bank is the custom user (password = its JSON) when data/plaid/sandbox_user.json is available', async () => {
    const custom = JSON.stringify({ override_accounts: [{ type: 'depository', subtype: 'checking', starting_balance: 100 }] });
    const t = setup({}, custom);
    const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', select: true });
    expect(r.body).toMatchObject({ username: 'user_custom', status: 'selecting' });
    expect(r.body).not.toHaveProperty('rejected');
    expect(t.client.calls.find((c) => c.method === 'sandboxPublicTokenCreate')!.args[0]).toEqual({ institution_id: 'ins_109508', initial_products: ['transactions', 'liabilities', 'investments'], username: 'user_custom', password: custom });
    expect(JSON.stringify(r.body)).not.toContain('starting_balance'); // the config is not echoed back
  });

  it('falls back to user_transactions_dynamic when Plaid rejects the custom user, and says why', async () => {
    const custom = '{"override_accounts":[]}';
    const t = setup({}, custom);
    t.client.publicTokenErrors.set('user_custom', new PlaidApiError('invalid override_password', 'INVALID_FIELD', 'INVALID_REQUEST', 400));
    const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', select: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: 'user_transactions_dynamic', status: 'selecting', rejected: [{ username: 'user_custom', code: 'INVALID_FIELD' }] });
    // the fallback user is sent without the custom password
    const last = t.client.calls.filter((c) => c.method === 'sandboxPublicTokenCreate').at(-1)!.args[0] as { username: string; password?: string };
    expect(last.username).toBe('user_transactions_dynamic');
    expect(last.password).toBeUndefined();
    // an explicit username skips the custom user entirely
    const e = setup({}, custom);
    expect((await e.post('/plaid/sandbox_connect', { household_id: 'hh_test', username: 'user_good' })).body).toMatchObject({ username: 'user_good' });
  });
});
