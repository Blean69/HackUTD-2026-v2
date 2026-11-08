import { describe, expect, it } from 'vitest';
import { Router, type HttpRequest } from '../http.js';
import { CONFIG, FakePlaid, pAcct } from '../testing/plaid_fake.js';
import { registerPlaidRoutes } from './routes.js';
import type { PlaidRuntime } from './runtime.js';
import { MemoryPlaidStore } from './store.js';
import { PlaidApiError } from './types.js';
import { loadPlaidConfig } from './config.js';
import type { SandboxProfile, SandboxProfiles } from './profiles.js';

/** An in-memory stand-in for the profile files: `family_demo` is the default custom user, the rest come from `extra` (id -> custom-user JSON). */
export function fakeProfiles(familyJson: string | null, extra: Record<string, string> = {}): SandboxProfiles {
  const entry = (id: string, name: string): SandboxProfile => ({ profile_id: id, display_name: name, summary: `${name} summary`, accounts: [{ name: 'Everyday Checking', type: 'depository', subtype: 'checking', mask: '0001', balance: 1 }], txn_count: 3 });
  const entries = [entry('family_demo', 'The Whitfields'), ...Object.keys(extra).map((id) => entry(id, id))];
  return { list: () => entries, has: (id) => entries.some((e) => e.profile_id === id), customUserJson: (id) => (id === 'family_demo' ? familyJson : extra[id] ?? null) };
}

function setup(over: Partial<PlaidRuntime> = {}, customUser: string | null = null, extra: Record<string, string> = {}) {
  const store = new MemoryPlaidStore();
  const client = new FakePlaid();
  const rt: PlaidRuntime = { config: CONFIG, client, store, sleep: async () => undefined, pollAttempts: 1, pollMs: 0, ...over };
  const router = new Router();
  const profiles = fakeProfiles(customUser, extra);
  registerPlaidRoutes(router, () => rt, () => profiles);
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

// ---- sandbox bank profiles (docs/contracts.md section 7b) -----------------------------------------------------------------

const maya = JSON.stringify({ seed: 'pnc-c001-2026', roll_dates_forward: true, override_accounts: [{ type: 'depository', subtype: 'checking', starting_balance: 1604, meta: { name: 'Everyday Checking', mask: '4577' } }, { type: 'credit', subtype: 'credit card', starting_balance: 500, meta: { name: 'Rewards Visa', mask: '7572' } }] });
const marcus = JSON.stringify({ seed: 'pnc-c002-2026', override_accounts: [{ type: 'depository', subtype: 'checking', starting_balance: 4007, meta: { name: 'Everyday Checking', mask: '1111' } }] });
const family = JSON.stringify({ override_accounts: [{ type: 'depository', subtype: 'checking', starting_balance: 6200, meta: { name: 'Everyday Checking', mask: '0001' } }] });
const extra = { pnc_c001: maya, pnc_c002: marcus };
const createCalls = (t: ReturnType<typeof setup>) => t.client.calls.filter((c) => c.method === 'sandboxPublicTokenCreate').map((c) => c.args[0] as { username: string; password?: string; initial_products: string[] });

describe('GET /plaid/sandbox_profiles and POST /plaid/sandbox_connect {profile_id}', () => {
  it('lists the profiles (the index as is, no secrets), even when Plaid is not configured', async () => {
    const t = setup({ config: null, client: null }, family, extra);
    const r = await t.post('/plaid/sandbox_profiles', {}, 'GET');
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({ 'Cache-Control': expect.stringContaining('max-age') });
    const list = r.body as SandboxProfile[];
    expect(list.map((p) => p.profile_id)).toEqual(['family_demo', 'pnc_c001', 'pnc_c002']);
    expect(list[0]).toMatchObject({ display_name: 'The Whitfields', txn_count: 3, accounts: [{ name: 'Everyday Checking', type: 'depository', subtype: 'checking', mask: '0001', balance: 1 }] });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('starting_balance'); // the custom-user config itself is never served
    expect(text).not.toMatch(/secret|token/i);
  });

  it('a PNC profile is sent to Plaid as the custom user: user_custom + its JSON as the password', async () => {
    const t = setup({}, family, extra);
    const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: 'pnc_c001', select: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 'selecting', username: 'user_custom', profile_id: 'pnc_c001', accounts: 10, reused: false });
    expect(JSON.stringify(r.body)).not.toContain('starting_balance');
    expect(createCalls(t)).toEqual([{ institution_id: 'ins_109508', initial_products: ['transactions', 'liabilities', 'investments'], username: 'user_custom', password: maya }]);
    expect(t.store.syncRequests).toEqual([]);
    expect(t.store.connections.get('item_fake_1')).toMatchObject({ status: 'selecting' });
  });

  it('without profile_id the default is the family profile; profile_id family_demo behaves the same', async () => {
    for (const body of [{ household_id: 'hh_test', select: true }, { household_id: 'hh_test', select: true, profile_id: 'family_demo' }]) {
      const t = setup({}, family, extra);
      const r = await t.post('/plaid/sandbox_connect', body);
      expect(r.body).toMatchObject({ username: 'user_custom', status: 'selecting' });
      expect(createCalls(t)[0]!.password).toBe(family);
    }
  });

  it('404 unknown_profile for an id that is not in the index, before any Plaid call or write', async () => {
    const t = setup({}, family, extra);
    for (const id of ['pnc_c999', 'PNC_C001', '../../etc/passwd', 'user_good']) {
      const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: id });
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ error: 'unknown_profile', profiles: ['family_demo', 'pnc_c001', 'pnc_c002'] });
    }
    expect(t.client.calls).toEqual([]);
    expect(t.store.calls).toEqual([]);
  });

  it('rejects a non-string profile_id and profile_id together with username (400)', async () => {
    const t = setup({}, family, extra);
    expect((await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: 7 })).body).toMatchObject({ error: 'bad_profile_id' });
    expect((await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: ['pnc_c001'] })).status).toBe(400);
    expect((await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: 'pnc_c001', username: 'user_good' })).body).toMatchObject({ error: 'profile_id_and_username' });
    expect(t.client.count('sandboxPublicTokenCreate')).toBe(0);
  });

  it('an empty profile_id means the default profile', async () => {
    const t = setup({}, family, extra);
    expect((await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: '', select: true })).body).toMatchObject({ username: 'user_custom' });
    expect(createCalls(t)[0]!.password).toBe(family);
  });

  it('never swaps in another bank when Plaid rejects a chosen PNC profile (the family default may fall back)', async () => {
    const t = setup({}, family, extra);
    t.client.publicTokenErrors.set('user_custom', new PlaidApiError('invalid override_password', 'INVALID_FIELD', 'INVALID_REQUEST', 400));
    const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: 'pnc_c002', select: true });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'plaid_error', code: 'INVALID_FIELD' });
    expect(createCalls(t).every((c) => c.username === 'user_custom' && c.password === marcus)).toBe(true);
    expect(t.store.itemsById.size).toBe(0);
    // the default family profile keeps its old fallback to user_transactions_dynamic
    const fam = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: 'family_demo', select: true });
    expect(fam.status).toBe(200);
    expect(fam.body).toMatchObject({ username: 'user_transactions_dynamic', rejected: [{ username: 'user_custom' }] });
  });

  it('retries a chosen profile with only the transactions product if the extra products are refused', async () => {
    const t = setup({}, family, extra);
    const orig = t.client.sandboxPublicTokenCreate.bind(t.client);
    t.client.sandboxPublicTokenCreate = async (req) => {
      if (req.initial_products.length > 1) {
        t.client.calls.push({ method: 'sandboxPublicTokenCreate', args: [req] });
        throw new PlaidApiError('products not supported', 'PRODUCTS_NOT_SUPPORTED', 'INVALID_INPUT', 400);
      }
      return orig(req);
    };
    const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: 'pnc_c001', select: true });
    expect(r.body).toMatchObject({ username: 'user_custom', products: ['transactions'], profile_id: 'pnc_c001' });
  });

  it('a second click on the same profile reuses the item; another profile (different accounts) becomes its own item', async () => {
    const t = setup({}, family, extra);
    // the fake bank reports the accounts of whatever was linked last: here Maya's two masks
    t.client.accounts = [pAcct('chk4577', 'depository', 'checking', 1604), pAcct('cc007572', 'credit', 'credit card', 500)];
    const first = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: 'pnc_c001', select: true });
    expect(first.body).toMatchObject({ reused: false, item_id: 'item_fake_1', accounts: 2 });
    const again = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: 'pnc_c001', select: true });
    expect(again.body).toMatchObject({ reused: true, status: 'selecting', item_id: 'item_fake_1', profile_id: 'pnc_c001', username: 'user_custom' });
    expect(t.client.count('sandboxPublicTokenCreate')).toBe(1);
    const other = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: 'pnc_c002', select: true });
    expect(other.body).toMatchObject({ reused: false, profile_id: 'pnc_c002' });
    expect(t.client.count('sandboxPublicTokenCreate')).toBe(2);
    expect(createCalls(t).map((c) => c.password)).toEqual([maya, marcus]);
  });

  it('500 profile_unreadable when the index lists a profile whose file cannot be read', async () => {
    const t = setup({}, family, { pnc_c003: '' });
    const r = await t.post('/plaid/sandbox_connect', { household_id: 'hh_test', profile_id: 'pnc_c003' });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ error: 'profile_unreadable' });
    expect(t.client.count('sandboxPublicTokenCreate')).toBe(0);
  });
});
