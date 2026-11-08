// "Call Brian by phone" module tests: the 5-digit code per household (reducers/phone.ts, phone.ts).
//   npm test
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as m from './index';
import { hashPin, PHONE_PIN_PEPPER, weakPinReason } from './phone';

const NOW = Timestamp.fromDate(new Date('2026-11-07T18:00:00Z'));
let conn = 100n;
const who = (sub: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));
const worker = who('worker');
const alice = who('alice');
const bob = who('bob');
const carol = who('carol');

/** A module with one seeded (ownerless) demo household and a registered worker. */
function fresh() {
  const test = createModuleTestHarness(spacetimedb, m, { rngSeed: 11n });
  test.clock.set(NOW);
  test.withReducerTx(worker, (ctx) => m.register_worker(ctx, { secret: 'keystone-dev-secret', label: 'test worker' }));
  test.withReducerTx(worker, (ctx) =>
    m.seed_households(ctx, {
      rows_json: JSON.stringify([
        { id: 'hh_demo', name: 'The Demos', city: 'Dallas', state: 'TX', persona: 'bakers', home_value: 0, vehicle_value: 0 },
        { id: 'hh_other', name: 'The Others', city: 'Plano', state: 'TX', persona: 'nurses', home_value: 0, vehicle_value: 0 },
      ]),
    }),
  );
  return test;
}
type Test = ReturnType<typeof fresh>;

const onboard = (test: Test, auth: typeof alice, name: string) => {
  test.withReducerTx(auth, (ctx) => m.start_onboarding(ctx, { household_name: name, display_name: 'Pat' }));
  const mine = [...test.db.household.iter()].filter((h) => h.id.startsWith('hh_onb_') && h.owner?.isEqual(authIdentity(test, auth)));
  return mine[mine.length - 1]!;
};
/** The identity a test auth maps to (read it off a household the caller just created). */
function authIdentity(test: Test, auth: typeof alice) {
  let id: import('spacetimedb').Identity | undefined;
  test.withReducerTx(auth, (ctx) => {
    id = ctx.sender;
  });
  return id!;
}
const join = (test: Test, auth: typeof alice, household_id: string) =>
  test.withReducerTx(auth, (ctx) => m.join_room(ctx, { household_id, display_name: 'Visitor', role: 'family' }));
const setPin = (test: Test, auth: typeof alice, household_id: string, pin: string) =>
  test.withReducerTx(auth, (ctx) => m.set_phone_pin(ctx, { household_id, pin }));
const seenByWorker = (test: Test, auth: typeof alice) => [...(m.worker_phone_access(test.viewContext(auth)) as unknown as { household_id: string }[])];

describe('code rules (pure)', () => {
  it('rejects the same digit, straight runs (up, down, wrapping) and two alternating digits', () => {
    for (const weak of ['00000', '77777', '12345', '23456', '56789', '54321', '98765', '43210', '67890', '90123', '09876', '12121', '40404', '90909']) {
      expect(weakPinReason(weak), weak).not.toBe('');
    }
  });
  it('accepts ordinary codes', () => {
    for (const ok of ['13579', '24680', '48151', '90210', '12346', '11112', '10001', '35712']) expect(weakPinReason(ok), ok).toBe('');
  });
  it('hash is sha256(pepper:salt:pin), pinned to a known vector so the worker can match it', () => {
    expect(PHONE_PIN_PEPPER).toBe('keystone/phone-pin/v1');
    const vector = '96ae30a261f7404cd4910cd1e1596d50d8cea4f6dc81ce369a09ac2a587b4675';
    expect(createHash('sha256').update('keystone/phone-pin/v1:0123456789abcdef01234567:48151').digest('hex')).toBe(vector);
    expect(hashPin('0123456789abcdef01234567', '48151')).toBe(vector);
    expect(hashPin('aaaaaaaaaaaaaaaaaaaaaaaa', '48151')).not.toBe(hashPin('bbbbbbbbbbbbbbbbbbbbbbbb', '48151'));
  });
});

describe('set_phone_pin', () => {
  it('the owner of a private household sets a code: only a salted hash is stored, plus a public status row', () => {
    const test = fresh();
    const hh = onboard(test, alice, 'The Whitfields');
    setPin(test, alice, hh.id, '48151');

    const row = test.db.phone_access.household_id.find(hh.id)!;
    expect(row.pin_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.salt).toMatch(/^[0-9a-f]{24}$/);
    expect(row.pin_hash).toBe(hashPin(row.salt, '48151'));
    expect(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('48151');
    expect(row.updated_at.microsSinceUnixEpoch).toBe(NOW.microsSinceUnixEpoch);

    const status = test.db.phone_access_status.household_id.find(hh.id)!;
    expect(status).toMatchObject({ household_id: hh.id, has_pin: true });
    expect(Object.keys(status).sort()).toEqual(['has_pin', 'household_id', 'updated_at']);
  });

  it('changing the code re-salts the row, and the old code stops matching', () => {
    const test = fresh();
    const hh = onboard(test, alice, 'The Whitfields');
    setPin(test, alice, hh.id, '48151');
    const before = test.db.phone_access.household_id.find(hh.id)!;
    test.clock.set(Timestamp.fromDate(new Date('2026-11-07T19:00:00Z')));
    setPin(test, alice, hh.id, '24681');
    const after = test.db.phone_access.household_id.find(hh.id)!;
    expect(after.salt).not.toBe(before.salt);
    expect(after.pin_hash).toBe(hashPin(after.salt, '24681'));
    expect(after.pin_hash).not.toBe(hashPin(after.salt, '48151'));
    expect(after.updated_at.microsSinceUnixEpoch).toBeGreaterThan(before.updated_at.microsSinceUnixEpoch);
    expect(test.db.phone_access.count()).toBe(1n);
    expect(test.db.phone_access_status.household_id.find(hh.id)!.updated_at.microsSinceUnixEpoch).toBe(after.updated_at.microsSinceUnixEpoch);
  });

  it('setting your own current code again is allowed', () => {
    const test = fresh();
    const hh = onboard(test, alice, 'The Whitfields');
    setPin(test, alice, hh.id, '48151');
    expect(() => setPin(test, alice, hh.id, '48151')).not.toThrow();
  });

  it('only the owner may change a private household', () => {
    const test = fresh();
    const hh = onboard(test, alice, 'The Whitfields');
    join(test, bob, hh.id); // being in the room is not enough when the household has an owner
    expect(() => setPin(test, bob, hh.id, '48151')).toThrow('only the household owner');
    expect(test.db.phone_access.count()).toBe(0n);
    expect(test.db.phone_access_status.count()).toBe(0n);
  });

  it('a seeded household has no owner: anyone in that room may set its code, nobody outside it', () => {
    const test = fresh();
    expect(() => setPin(test, bob, 'hh_demo', '48151')).toThrow('join this household room');
    join(test, bob, 'hh_other'); // in a different room
    expect(() => setPin(test, bob, 'hh_demo', '48151')).toThrow('join this household room');
    join(test, bob, 'hh_demo');
    setPin(test, bob, 'hh_demo', '48151');
    expect(test.db.phone_access.household_id.find('hh_demo')!.set_by.isEqual(authIdentity(test, bob))).toBe(true);
    expect(test.db.phone_access_status.household_id.find('hh_demo')!.has_pin).toBe(true);
  });

  it('rejects anything that is not exactly 5 digits', () => {
    const test = fresh();
    const hh = onboard(test, alice, 'The Whitfields');
    for (const bad of ['', '1234', '123456', '4815a', '48 51', '48151 ', 'abcde', '４８１５１', '-4815', '4815.']) {
      expect(() => setPin(test, alice, hh.id, bad), JSON.stringify(bad)).toThrow('exactly 5 digits');
    }
    expect(test.db.phone_access.count()).toBe(0n);
  });

  it('rejects weak codes', () => {
    const test = fresh();
    const hh = onboard(test, alice, 'The Whitfields');
    for (const weak of ['00000', '99999', '12345', '54321', '67890', '12121']) {
      expect(() => setPin(test, alice, hh.id, weak), weak).toThrow(/can not/);
    }
    expect(test.db.phone_access.count()).toBe(0n);
  });

  it('rejects a code another household already uses, whatever salt it was stored with, but lets a freed one be reused', () => {
    const test = fresh();
    const a = onboard(test, alice, 'The Whitfields');
    const b = onboard(test, bob, 'The Garcias');
    setPin(test, alice, a.id, '48151');
    expect(() => setPin(test, bob, b.id, '48151')).toThrow('already taken');
    expect(test.db.phone_access.household_id.find(b.id)).toBeFalsy();
    setPin(test, bob, b.id, '48152');
    // alice moves off 48151: it is free again
    setPin(test, alice, a.id, '97531');
    setPin(test, bob, b.id, '48151');
    expect(test.db.phone_access.count()).toBe(2n);
    // two households, two different salts
    const rows = [...test.db.phone_access.iter()];
    expect(new Set(rows.map((r) => r.salt)).size).toBe(2);
  });

  it('an unknown household is refused', () => {
    const test = fresh();
    expect(() => setPin(test, alice, 'hh_nope', '48151')).toThrow('unknown household');
  });

  it('never logs or echoes the code', () => {
    const test = fresh();
    const hh = onboard(test, alice, 'The Whitfields');
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k));
    try {
      setPin(test, alice, hh.id, '48151');
      const other = onboard(test, bob, 'The Garcias');
      let message = '';
      try {
        setPin(test, bob, other.id, '48151');
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      try {
        setPin(test, bob, other.id, '00000');
      } catch (e) {
        message += e instanceof Error ? e.message : String(e);
      }
      expect(message).not.toContain('48151');
      expect(message).not.toContain('00000');
      const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
      expect(logged).not.toContain('48151');
      expect(logged).toContain(hh.id); // the household id is what we do log
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('clear_phone_pin', () => {
  it('removes the hash, keeps a has_pin=false status row, and is allowed only for the same people', () => {
    const test = fresh();
    const hh = onboard(test, alice, 'The Whitfields');
    setPin(test, alice, hh.id, '48151');
    expect(() => test.withReducerTx(bob, (ctx) => m.clear_phone_pin(ctx, { household_id: hh.id }))).toThrow('only the household owner');
    test.withReducerTx(alice, (ctx) => m.clear_phone_pin(ctx, { household_id: hh.id }));
    expect(test.db.phone_access.household_id.find(hh.id)).toBeFalsy();
    expect(test.db.phone_access_status.household_id.find(hh.id)!.has_pin).toBe(false);
    // clearing again, or on a household that never had a code, is a quiet no-op
    test.withReducerTx(alice, (ctx) => m.clear_phone_pin(ctx, { household_id: hh.id }));
    const other = onboard(test, bob, 'The Garcias');
    test.withReducerTx(bob, (ctx) => m.clear_phone_pin(ctx, { household_id: other.id }));
    expect(test.db.phone_access_status.household_id.find(other.id)).toBeFalsy();
    // and the freed code can be taken by someone else
    setPin(test, bob, other.id, '48151');
  });
});

describe('worker_phone_access view', () => {
  it('registered workers see the hashes and salts; everyone else sees nothing', () => {
    const test = fresh();
    const a = onboard(test, alice, 'The Whitfields');
    join(test, bob, 'hh_demo');
    setPin(test, alice, a.id, '48151');
    setPin(test, bob, 'hh_demo', '97531');

    const rows = m.worker_phone_access(test.viewContext(worker)) as unknown as { household_id: string; pin_hash: string; salt: string }[];
    expect(rows.map((r) => r.household_id).sort()).toEqual([a.id, 'hh_demo'].sort());
    const mine = rows.find((r) => r.household_id === a.id)!;
    expect(mine.pin_hash).toBe(hashPin(mine.salt, '48151'));
    // a worker-side check: only the right digits reproduce a stored hash
    expect(rows.filter((r) => hashPin(r.salt, '48151') === r.pin_hash).map((r) => r.household_id)).toEqual([a.id]);
    expect(rows.filter((r) => hashPin(r.salt, '00001') === r.pin_hash)).toEqual([]);

    expect(seenByWorker(test, alice)).toEqual([]);
    expect(seenByWorker(test, carol)).toEqual([]);
  });
});

describe('sandboxes and cleanup', () => {
  it('create_sandbox does not copy a code; delete_sandbox removes the copy’s code and status', () => {
    const test = fresh();
    join(test, alice, 'hh_demo');
    setPin(test, alice, 'hh_demo', '48151');
    test.withReducerTx(alice, (ctx) => m.create_sandbox(ctx, { template_household_id: 'hh_demo', display_name: 'Alice' }));
    const sbx = [...test.db.household.iter()].find((h) => h.id.startsWith('hh_sbx_'))!;
    expect(test.db.phone_access.household_id.find(sbx.id)).toBeFalsy();
    expect(test.db.phone_access_status.household_id.find(sbx.id)).toBeFalsy();
    // the sandbox owner can give the copy its own code (not the template's)
    expect(() => setPin(test, alice, sbx.id, '48151')).toThrow('already taken');
    setPin(test, alice, sbx.id, '97531');
    expect(test.db.phone_access.count()).toBe(2n);
    test.withReducerTx(alice, (ctx) => m.delete_sandbox(ctx, { household_id: sbx.id }));
    expect(test.db.phone_access.household_id.find(sbx.id)).toBeFalsy();
    expect(test.db.phone_access_status.household_id.find(sbx.id)).toBeFalsy();
    expect(test.db.phone_access.household_id.find('hh_demo')).toBeTruthy(); // the demo keeps its own
  });
});
