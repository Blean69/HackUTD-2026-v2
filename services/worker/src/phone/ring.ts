// In-app callback verification (docs/contracts.md section 13). The voice service opens a browser call in callback mode only for a ring that was
// REALLY answered in this household, once. Without this, anyone who can reach /api/offer could ask for callback mode and make Brian write a
// fabricated critical alert onto any household's dashboard.
import { subscribeAndWait } from '../db/connection.js';
import type { DbConnection } from '../module_bindings/index.js';

/** A ring is usable this long after it started: 45 s of ringing plus time to connect. */
export const RING_USABLE_MS = 150_000;

export interface RingRow {
  id: string;
  household_id: string;
  status: string;
  created_ms: number;
}
export interface RingSource {
  /** The ring row with this id, or undefined. Never rejects. */
  find(householdId: string, callId: string): Promise<RingRow | undefined>;
}

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export class SpacetimeRingSource implements RingSource {
  private subs = new Map<string, Promise<unknown>>();
  constructor(private conn: DbConnection) {}

  async find(householdId: string, callId: string): Promise<RingRow | undefined> {
    let p = this.subs.get(householdId);
    if (!p) {
      p = subscribeAndWait(this.conn, [`SELECT * FROM incoming_call WHERE household_id = ${sqlStr(householdId)}`], 8_000).catch(() => {
        this.subs.delete(householdId);
      });
      this.subs.set(householdId, p);
    }
    await p;
    const r = this.conn.db.incomingCall?.id.find(callId);
    if (!r) return undefined;
    const ts = r.createdAt as unknown as { toDate?: () => Date };
    return { id: r.id, household_id: r.householdId, status: r.status, created_ms: typeof ts?.toDate === 'function' ? ts.toDate().getTime() : 0 };
  }
}

/** Accepts a ring once: it must exist, belong to the household, have been answered, and be recent. */
export class RingGate {
  private used = new Map<string, number>();
  constructor(
    private source: RingSource | undefined,
    private now: () => number = Date.now,
  ) {}

  async check(householdId: string, callId: string): Promise<{ ok: boolean; reason?: string }> {
    const t = this.now();
    for (const [id, at] of this.used) if (t - at > RING_USABLE_MS * 2) this.used.delete(id);
    if (!this.source) return { ok: false, reason: 'unavailable' };
    if (!callId || !householdId) return { ok: false, reason: 'missing' };
    if (this.used.has(callId)) return { ok: false, reason: 'used' };
    const row = await this.source.find(householdId, callId).catch(() => undefined);
    if (!row || row.household_id !== householdId) return { ok: false, reason: 'unknown' };
    if (row.status !== 'answered') return { ok: false, reason: 'not_answered' };
    if (t - row.created_ms > RING_USABLE_MS) return { ok: false, reason: 'stale' };
    this.used.set(callId, t);
    return { ok: true };
  }
}
