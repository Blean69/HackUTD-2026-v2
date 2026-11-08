import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PKG_ROOT } from '../config.js';
import { ACCOUNT_TYPES, mapAccountType } from './mapping.js';
import { createSandboxProfiles, profileMasks, profilesDir } from './profiles.js';

const entry = (id: string, extra: Record<string, unknown> = {}) => ({ profile_id: id, display_name: `${id} name`, summary: 's', accounts: [{ name: 'Everyday Checking', type: 'depository', subtype: 'checking', mask: '0001', balance: 5 }], txn_count: 2, ...extra });

function tmpTree() {
  const root = mkdtempSync(join(tmpdir(), 'keystone-profiles-'));
  const seed = join(root, 'seed');
  const profiles = join(root, 'plaid', 'profiles');
  mkdirSync(seed, { recursive: true });
  mkdirSync(profiles, { recursive: true });
  const env = { DATA_DIR: seed } as NodeJS.ProcessEnv;
  return { root, seed, profiles, env };
}

describe('profile files', () => {
  it('resolve next to the seed dir (the prod mount ../data/plaid:/data/plaid) unless PLAID_PROFILES_DIR says otherwise', () => {
    expect(profilesDir({ DATA_DIR: '/data/seed' })).toBe('/data/plaid/profiles');
    expect(profilesDir({}).replace(/\\/g, '/')).toMatch(/\/data\/plaid\/profiles$/);
    expect(profilesDir({ PLAID_PROFILES_DIR: '/x/y' })).toBe('/x/y');
  });

  it('serve the index, and load a profile as compact JSON only if the index lists it', () => {
    const t = tmpTree();
    writeFileSync(join(t.profiles, 'index.json'), JSON.stringify([entry('pnc_c001'), entry('pnc_c002')]));
    writeFileSync(join(t.profiles, 'pnc_c001.json'), '{\n "seed": "a",\n "override_accounts": [ {"type": "depository"} ]\n}\n');
    writeFileSync(join(t.profiles, 'pnc_c003.json'), '{"override_accounts":[]}'); // on disk but not in the index
    writeFileSync(join(t.root, 'secret.json'), '{"override_accounts":[]}');
    const p = createSandboxProfiles(t.env);
    expect(p.list().map((e) => e.profile_id)).toEqual(['pnc_c001', 'pnc_c002']);
    expect(p.has('pnc_c001')).toBe(true);
    expect(p.has('pnc_c003')).toBe(false);
    expect(p.customUserJson('pnc_c001')).toBe('{"seed":"a","override_accounts":[{"type":"depository"}]}');
    expect(p.customUserJson('pnc_c003')).toBeNull();
    expect(p.customUserJson('../secret')).toBeNull(); // path-like ids are never turned into a path
    expect(p.customUserJson('pnc_c002')).toBeNull(); // listed, file missing
  });

  it('keeps extra index fields, drops malformed rows, and caches until the file changes', () => {
    const t = tmpTree();
    const path = join(t.profiles, 'index.json');
    writeFileSync(path, JSON.stringify([entry('pnc_c001', { persona: 'early-career nurse', window: { from: '2026-05-07' } }), { profile_id: 'bad id', display_name: 'x', accounts: [] }, 'nope', entry('pnc_c002')]));
    const p = createSandboxProfiles(t.env);
    const first = p.list();
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ persona: 'early-career nurse', window: { from: '2026-05-07' } });
    expect(p.list()).toBe(first); // same array: served from the cache
    writeFileSync(path, JSON.stringify([entry('pnc_c009')]));
    utimesSync(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(p.list().map((e) => e.profile_id)).toEqual(['pnc_c009']);
    expect(p.has('pnc_c001')).toBe(false);
  });

  it('family_demo is the existing sandbox_user.json (or PLAID_SANDBOX_USER_FILE); without an index the picker still offers it', () => {
    const t = tmpTree();
    const user = { override_accounts: [{ type: 'depository', subtype: 'checking', starting_balance: 6200, meta: { name: 'Everyday Checking', mask: '0001' }, transactions: [{ amount: 1 }, { amount: 2 }] }, { type: 'loan', subtype: 'mortgage', starting_balance: 9, meta: { name: 'Home Mortgage', mask: '0004' } }] };
    writeFileSync(join(t.root, 'plaid', 'sandbox_user.json'), JSON.stringify(user, null, 1));
    const p = createSandboxProfiles(t.env);
    expect(p.has('family_demo')).toBe(true);
    expect(p.customUserJson('family_demo')).toBe(JSON.stringify(user));
    expect(p.list()).toMatchObject([{ profile_id: 'family_demo', txn_count: 2, accounts: [{ name: 'Everyday Checking', type: 'depository', subtype: 'checking', mask: '0001', balance: 6200 }, { name: 'Home Mortgage', mask: '0004' }] }]);
    const override = join(t.root, 'other.json');
    writeFileSync(override, '{"override_accounts":[]}');
    expect(createSandboxProfiles({ ...t.env, PLAID_SANDBOX_USER_FILE: override }).customUserJson('family_demo')).toBe('{"override_accounts":[]}');
    // nothing installed at all: no profiles, but the default id is still "known" (the route then falls back like before)
    const empty = createSandboxProfiles(tmpTree().env);
    expect(empty.list()).toEqual([]);
    expect(empty.has('family_demo')).toBe(true);
    expect(empty.customUserJson('family_demo')).toBeNull();
  });

  it('a corrupt profile file is null, not a crash', () => {
    const t = tmpTree();
    writeFileSync(join(t.profiles, 'index.json'), JSON.stringify([entry('pnc_c001'), entry('pnc_c002')]));
    writeFileSync(join(t.profiles, 'pnc_c001.json'), '{nope');
    writeFileSync(join(t.profiles, 'pnc_c002.json'), '{"seed":"no accounts"}');
    const p = createSandboxProfiles(t.env);
    expect(p.customUserJson('pnc_c001')).toBeNull();
    expect(p.customUserJson('pnc_c002')).toBeNull();
  });

  it('profileMasks reads the account masks that identify a profile', () => {
    expect([...profileMasks('{"override_accounts":[{"meta":{"mask":"4577"}},{"meta":{"mask":"7572"}},{"type":"x"}]}')].sort()).toEqual(['4577', '7572']);
    expect(profileMasks('not json').size).toBe(0);
  });
});

// The generated files in data/plaid/profiles (data/pnc_profiles.py): every one must be something Plaid accepts and our mapping understands.
const REAL = resolve(PKG_ROOT, '../../data/plaid/profiles');
describe.skipIf(!existsSync(join(REAL, 'index.json')))('the generated PNC profiles (data/plaid/profiles)', () => {
  const real = createSandboxProfiles({ PLAID_PROFILES_DIR: REAL, PLAID_SANDBOX_USER_FILE: resolve(REAL, '../sandbox_user.json') } as NodeJS.ProcessEnv);
  const index = real.list();
  const pnc = index.filter((e) => e.profile_id.startsWith('pnc_'));
  type Acct = { type: string; subtype: string; starting_balance: number; meta: { mask: string; limit?: number }; transactions?: { date_transacted: string; date_posted: string; amount: number; description: string; currency: string }[]; liability?: Record<string, unknown>; holdings?: { quantity: number; institution_price: number }[] };

  it('index.json: family_demo first, then 30 PNC customers, in the GET /plaid/sandbox_profiles shape', () => {
    expect(index[0]!.profile_id).toBe('family_demo');
    expect(pnc).toHaveLength(30);
    for (const e of index) {
      expect(e.display_name.length).toBeGreaterThan(10);
      expect(e.summary.length).toBeGreaterThan(10);
      expect(e.txn_count).toBeGreaterThan(50);
      expect(e.accounts.length).toBeGreaterThanOrEqual(4);
      for (const a of e.accounts) expect(a).toMatchObject({ name: expect.any(String), type: expect.any(String), subtype: expect.any(String), mask: expect.stringMatching(/^\d{4}$/), balance: expect.any(Number) });
      expect(JSON.stringify(e)).not.toMatch(/override_|secret|access_token/);
    }
    expect(new Set(index.map((e) => e.profile_id)).size).toBe(index.length);
    expect(new Set(pnc.map((e) => e.display_name)).size).toBe(30);
  });

  it.each(pnc.map((e) => [e.profile_id, e] as const))('%s: within Plaid caps, and every account lands in one of our 8 types without asking a model', (id, e) => {
    const json = real.customUserJson(id)!;
    expect(json).toBeTruthy();
    expect(Buffer.byteLength(json)).toBeLessThan(55_000);
    const cfg = JSON.parse(json) as { roll_dates_forward: boolean; override_accounts: Acct[] };
    expect(cfg.roll_dates_forward).toBe(true);
    const accts = cfg.override_accounts;
    expect(accts.length).toBeLessThanOrEqual(10);
    const txns = accts.flatMap((a) => a.transactions ?? []);
    expect(txns.length).toBe(e.txn_count);
    expect(txns.length).toBeLessThanOrEqual(240);
    const types = accts.map((a) => mapAccountType(a.type, a.subtype));
    expect(types.every((d) => d.confident && ACCOUNT_TYPES.includes(d.type))).toBe(true);
    const got = new Set(types.map((d) => d.type));
    for (const need of ['checking', 'savings', 'ira', 'credit_card']) expect(got.has(need as (typeof ACCOUNT_TYPES)[number])).toBe(true);
    expect(new Set(accts.map((a) => a.meta.mask)).size).toBe(accts.length); // masks identify the profile, so they are unique
    expect(e.accounts.map((a) => a.mask).sort()).toEqual(accts.map((a) => a.meta.mask).sort()); // the preview describes exactly these accounts
    for (const a of accts) {
      if (a.type === 'loan') expect(a.liability).toBeUndefined(); // any loan liability block makes Plaid answer INTERNAL_SERVER_ERROR (see data/pnc_profiles.py)
      if (a.type === 'loan') expect((a.transactions ?? []).some((t) => /^PAYMENT RECEIVED/.test(t.description) && t.amount < 0)).toBe(true); // the loan-side leg of each payment
      if (a.holdings) expect(Math.abs(a.holdings.reduce((s, h) => s + h.quantity * h.institution_price, 0) - a.starting_balance)).toBeLessThan(1);
      for (const t of a.transactions ?? []) {
        expect(t.currency).toBe('USD');
        expect(t.date_transacted <= t.date_posted && t.date_posted <= '2026-11-06').toBe(true);
      }
    }
  });

  it('keeps Plaid sign convention: paychecks and card payments are negative, purchases and bill payments positive', () => {
    const cfg = JSON.parse(real.customUserJson('pnc_c001')!) as { override_accounts: Acct[] };
    const chk = cfg.override_accounts.find((a) => a.subtype === 'checking')!.transactions!;
    const card = cfg.override_accounts.find((a) => a.subtype === 'credit card')!.transactions!;
    expect(chk.filter((t) => /PAYROLL/.test(t.description)).every((t) => t.amount < 0)).toBe(true);
    expect(chk.filter((t) => /CREDIT CARD AUTOPAY PAYMENT/.test(t.description)).every((t) => t.amount > 0)).toBe(true);
    expect(card.filter((t) => /PAYMENT THANK YOU/.test(t.description)).every((t) => t.amount < 0)).toBe(true);
    expect(card.filter((t) => !/PAYMENT THANK YOU/.test(t.description)).every((t) => t.amount > 0)).toBe(true);
    // both legs of a card payment: same amount, same day
    const out = chk.filter((t) => /CREDIT CARD AUTOPAY PAYMENT/.test(t.description)).map((t) => `${t.date_posted} ${t.amount}`).sort();
    const inn = card.filter((t) => /PAYMENT THANK YOU/.test(t.description)).map((t) => `${t.date_posted} ${-t.amount}`).sort();
    expect(out).toEqual(inn);
  });
});
