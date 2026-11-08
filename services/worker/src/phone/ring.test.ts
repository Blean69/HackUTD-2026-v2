import { describe, expect, it } from 'vitest';
import { RING_USABLE_MS, RingGate, type RingRow, type RingSource } from './ring.js';

const NOW = 1_800_000_000_000;
const row = (over: Partial<RingRow> = {}): RingRow => ({ id: 'call_1', household_id: 'hh_a', status: 'answered', created_ms: NOW - 10_000, ...over });
const gate = (rows: RingRow[], source: RingSource | null = { find: async (_h, id) => rows.find((r) => r.id === id) }) => new RingGate(source ?? undefined, () => NOW);

describe('RingGate: a callback call needs a ring that was really answered, once', () => {
  it('accepts an answered, recent ring of this household, once only', async () => {
    const g = gate([row()]);
    expect(await g.check('hh_a', 'call_1')).toEqual({ ok: true });
    expect(await g.check('hh_a', 'call_1')).toEqual({ ok: false, reason: 'used' });
  });
  it.each([
    ['a ring still ringing', row({ status: 'ringing' }), 'not_answered'],
    ['a declined ring', row({ status: 'declined' }), 'not_answered'],
    ['another household\'s ring', row({ household_id: 'hh_b' }), 'unknown'],
    ['a stale ring', row({ created_ms: NOW - RING_USABLE_MS - 1 }), 'stale'],
  ])('rejects %s', async (_n, r, reason) => expect(await gate([r]).check('hh_a', 'call_1')).toEqual({ ok: false, reason }));
  it('rejects an unknown id, missing ids and a worker with no ring source', async () => {
    expect(await gate([row()]).check('hh_a', 'nope')).toEqual({ ok: false, reason: 'unknown' });
    expect(await gate([row()]).check('', 'call_1')).toEqual({ ok: false, reason: 'missing' });
    expect(await gate([row()], null).check('hh_a', 'call_1')).toEqual({ ok: false, reason: 'unavailable' });
  });
});
