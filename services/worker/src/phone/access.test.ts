import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemorySink } from '../agent/sink.js';
import { loadConfig } from '../config.js';
import { Router } from '../http.js';
import type { HttpRequest } from '../http.js';
import { buildLLMClient } from '../llm/client.js';
import { smallHousehold } from '../testing/fixtures.js';
import { FixedExternalApis } from '../tools/external.js';
import { buildRegistry } from '../tools/index.js';
import type { HouseholdData } from '../types.js';
import { hashPin, matchStoredPin, PHONE_PIN_PEPPER, StaticPhoneCodes, type PhoneCodeRow } from './access.js';
import { loadPhoneConfig, parsePins } from './config.js';
import { PinChecker } from './identity.js';
import { registerPhoneRoutes, type PhoneRuntime } from './routes.js';
import { PhoneService, type PhoneDeps } from './session.js';

const SECRET = 'test-voice-secret-0123456789';

/** Same shape the module stores: a per-row salt and sha256(pepper:salt:pin). */
const row = (householdId: string, salt: string, pin: string): PhoneCodeRow => ({ householdId, salt, pinHash: hashPin(salt, pin) });

describe('hash scheme (must match spacetime/src/phone.ts)', () => {
  it('is sha256(pepper:salt:pin), pinned to the same vector the module test uses', () => {
    expect(PHONE_PIN_PEPPER).toBe('keystone/phone-pin/v1');
    const vector = '96ae30a261f7404cd4910cd1e1596d50d8cea4f6dc81ce369a09ac2a587b4675';
    expect(createHash('sha256').update('keystone/phone-pin/v1:0123456789abcdef01234567:48151').digest('hex')).toBe(vector);
    expect(hashPin('0123456789abcdef01234567', '48151')).toBe(vector);
  });
});

describe('matchStoredPin', () => {
  const rows = [row('hh_a', 'aaaaaaaaaaaaaaaaaaaaaaaa', '48151'), row('hh_b', 'bbbbbbbbbbbbbbbbbbbbbbbb', '97531'), row('hh_c', 'cccccccccccccccccccccccc', '13579')];

  it('finds the household whose code was typed, whatever its salt', () => {
    expect(matchStoredPin(rows, '48151')).toBe('hh_a');
    expect(matchStoredPin(rows, '97531')).toBe('hh_b');
    expect(matchStoredPin(rows, ' 13579 ')).toBe('hh_c');
  });
  it('rejects wrong, empty, short, long and non-string input', () => {
    for (const bad of ['', '4815', '481510', '48152', '00000', 'abcde', '48151'.repeat(50)]) expect(matchStoredPin(rows, bad), bad).toBeUndefined();
    expect(matchStoredPin(rows, undefined as never)).toBeUndefined();
    expect(matchStoredPin([], '48151')).toBeUndefined();
  });
  it('a malformed stored hash never matches (and does not throw)', () => {
    const bad: PhoneCodeRow[] = [{ householdId: 'hh_x', salt: 's', pinHash: 'nothex' }, { householdId: 'hh_y', salt: 's', pinHash: '00'.repeat(32) }, ...rows];
    expect(matchStoredPin(bad, '00000')).toBeUndefined();
    expect(matchStoredPin(bad, '97531')).toBe('hh_b');
  });
});

describe('PinChecker with household codes', () => {
  const env = parsePins('55555:hh_envhome:mem_e,48151:hh_env_dup');
  const codes = new StaticPhoneCodes([row('hh_a', 'aaaaaaaaaaaaaaaaaaaaaaaa', '48151'), row('hh_b', 'bbbbbbbbbbbbbbbbbbbbbbbb', '97531')]);

  it('checks the household codes first, then the env PINs', () => {
    const c = new PinChecker(env, 3, Date.now, undefined, codes);
    expect(c.check('c1', '', '97531')).toEqual({ ok: true, entry: { householdId: 'hh_b', memberId: '' }, source: 'code' });
    expect(c.check('c2', '', '55555')).toEqual({ ok: true, entry: { householdId: 'hh_envhome', memberId: 'mem_e' }, source: 'env' });
    // the same digits in both lists: the household's own code wins
    expect(c.check('c3', '', '48151')).toMatchObject({ ok: true, source: 'code', entry: { householdId: 'hh_a' } });
  });

  it('keeps the three tries per call and the per-caller lockout', () => {
    let t = 0;
    const c = new PinChecker(env, 3, () => t, undefined, codes);
    expect(c.check('call1', 'h', '11112')).toMatchObject({ ok: false, triesLeft: 2, locked: false });
    expect(c.check('call1', 'h', '11113')).toMatchObject({ triesLeft: 1 });
    expect(c.check('call1', 'h', '11114')).toMatchObject({ triesLeft: 0, locked: true });
    expect(c.check('call1', 'h', '97531')).toEqual({ ok: false, triesLeft: 0, locked: true }); // right code, too late
    expect(c.check('call2', 'h2', '97531').ok).toBe(true); // another call is unaffected
    for (let i = 0; i < 9; i++) c.check(`hangup_${i}`, 'h3', '11112');
    expect(c.check('fresh', 'h3', '97531')).toMatchObject({ ok: false, locked: true });
    t += 16 * 60_000;
    expect(c.check('later', 'h3', '97531').ok).toBe(true);
  });

  it('sees codes set, changed and cleared while it runs', () => {
    const live = new StaticPhoneCodes([]);
    const c = new PinChecker(new Map(), 3, Date.now, undefined, live);
    expect(c.check('a', '', '48151').ok).toBe(false);
    live.list = [row('hh_a', 'aaaaaaaaaaaaaaaaaaaaaaaa', '48151')];
    expect(c.check('b', '', '48151').ok).toBe(true);
    live.list = [row('hh_a', 'dddddddddddddddddddddddd', '24681')]; // changed: new salt, new hash
    expect(c.check('c', '', '48151').ok).toBe(false);
    expect(c.check('d', '', '24681').ok).toBe(true);
    live.list = []; // cleared
    expect(c.check('e', '', '24681').ok).toBe(false);
  });
});

describe('/phone/identify with household codes', () => {
  function setup(opts: { codes?: StaticPhoneCodes; ready?: () => Promise<void>; env?: string } = {}) {
    const data: HouseholdData = smallHousehold();
    const lines: string[] = [];
    const codes = opts.codes ?? new StaticPhoneCodes([row('hh_test', 'aaaaaaaaaaaaaaaaaaaaaaaa', '48151')]);
    if (opts.ready) (codes as StaticPhoneCodes & { ready?: () => Promise<void> }).ready = opts.ready;
    const cfg = loadPhoneConfig({ VOICE_SHARED_SECRET: SECRET, PHONE_PINS: opts.env ?? '12346:hh_test:m1' });
    const deps: PhoneDeps = {
      sink: new MemorySink(),
      registry: buildRegistry(),
      external: new FixedExternalApis(),
      llm: buildLLMClient(loadConfig({})),
      loadData: async (id) => {
        if (id !== data.household.id) throw new Error(`unknown household ${id}`);
        return data;
      },
      enqueueJob: async () => 1n,
      cfg,
      codes,
      log: (m) => lines.push(m),
    };
    const svc = new PhoneService(deps);
    const rt: PhoneRuntime = { cfg, service: svc };
    const router = new Router();
    registerPhoneRoutes(router, () => rt);
    const identify = async (body: Record<string, unknown>) => {
      const h = router.find('POST', '/phone/identify')!;
      const req: HttpRequest = { method: 'POST', path: '/phone/identify', query: new URLSearchParams(), headers: { 'x-voice-secret': SECRET }, body: async () => Buffer.from(JSON.stringify(body)) };
      const r = await h(req);
      return { status: r.status, body: r.body as Record<string, unknown> };
    };
    return { identify, lines, codes, svc };
  }

  it('a household code identifies the household over HTTP; a wrong one does not', async () => {
    const { identify } = setup();
    const good = await identify({ call_id: 'CA1', caller_hash: 'h', pin: '48151' });
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ ok: true, household_id: 'hh_test', member_id: '', household_name: 'Test Family' });
    const bad = await identify({ call_id: 'CA2', caller_hash: 'h', pin: '48150' });
    expect(bad.body).toEqual({ ok: false, tries_left: 2, locked: false });
  });

  it('falls back to the env PHONE_PINS when no household code matches, with the member from the env entry', async () => {
    const { identify } = setup();
    const r = await identify({ call_id: 'CA3', pin: '12346' });
    expect(r.body).toMatchObject({ ok: true, household_id: 'hh_test', member_id: 'm1', first_name: 'Alex' });
  });

  it('three wrong codes lock the call, even if the fourth is right', async () => {
    const { identify } = setup();
    expect((await identify({ call_id: 'CA4', pin: '00001' })).body).toMatchObject({ tries_left: 2 });
    expect((await identify({ call_id: 'CA4', pin: '00002' })).body).toMatchObject({ tries_left: 1 });
    expect((await identify({ call_id: 'CA4', pin: '00003' })).body).toEqual({ ok: false, tries_left: 0, locked: true });
    expect((await identify({ call_id: 'CA4', pin: '48151' })).body).toMatchObject({ ok: false, locked: true });
  });

  it('a household whose data cannot load answers household_unavailable, not a crash', async () => {
    const { identify } = setup({ codes: new StaticPhoneCodes([row('hh_gone', 'aaaaaaaaaaaaaaaaaaaaaaaa', '48151')]) });
    expect((await identify({ call_id: 'CA5', pin: '48151' })).body).toMatchObject({ ok: false, error: 'household_unavailable' });
  });

  it('waits for the codes to load before checking the first call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const codes = new StaticPhoneCodes([]);
    const { identify } = setup({ codes, ready: () => gate });
    const pending = identify({ call_id: 'CA6', pin: '48151' });
    codes.list = [row('hh_test', 'aaaaaaaaaaaaaaaaaaaaaaaa', '48151')]; // arrives while the call waits
    release();
    expect((await pending).body).toMatchObject({ ok: true, household_id: 'hh_test' });
  });

  it('logs only the outcome: never the digits, the caller hash, or the household', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k));
    try {
      const { identify, lines } = setup();
      await identify({ call_id: 'CA7', caller_hash: 'secret-caller-hash', pin: '99887' });
      await identify({ call_id: 'CA7', caller_hash: 'secret-caller-hash', pin: '48151' });
      await identify({ call_id: 'CA8', caller_hash: 'secret-caller-hash', pin: '12346' });
      const all = [...lines, ...spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')))].join('\n');
      expect(lines).toEqual([
        '[phone] identify call=CA7: wrong, 2 tries left',
        '[phone] identify call=CA7: ok (household code)',
        '[phone] identify call=CA8: ok (env PIN)',
      ]);
      for (const secret of ['99887', '48151', '12346', 'secret-caller-hash', 'hh_test']) expect(all, secret).not.toContain(secret);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
