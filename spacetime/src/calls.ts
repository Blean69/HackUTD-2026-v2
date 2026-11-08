// In-app call helpers (docs/contracts.md section 13). Not exported from index.ts.
import { Timestamp } from 'spacetimedb';
import { newId, type Ctx } from './util';

export const RING_SECS = 45;
/** No new ring within this long of the last one for the same household, so an alert burst is one phone call, not ten. */
export const RING_COOLDOWN_SECS = 20;
export const CALL_SOURCES = ['alert', 'callback', 'demo'] as const;
/** What a client may claim. `alert` is reserved for the agents' own alert hook, so a client can never make a ring look like a real alert. */
export const CLIENT_CALL_SOURCES = ['callback', 'demo'] as const;
export const DEFAULT_RING_TITLE = 'Brian has a critical alert for you';
const KEEP_FINISHED = 20;

const micros = (secs: number) => BigInt(secs) * 1_000_000n;

/** Start a ring unless one is already going or the last one was very recent. Returns the new row's id, or "" when it did not ring. */
export function ring(ctx: Ctx, household_id: string, alert_id: string, title: string, source: string): string {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const c of ctx.db.incoming_call.household_id.filter(household_id)) {
    if (c.status === 'ringing' && c.expires_at.microsSinceUnixEpoch > now) return '';
    if (now - c.created_at.microsSinceUnixEpoch < micros(RING_COOLDOWN_SECS)) return '';
  }
  // Finished rings are history, not state: keep the newest few per household so the table cannot grow without bound.
  const finished = [...ctx.db.incoming_call.household_id.filter(household_id)].filter((c) => c.status !== 'ringing' || c.expires_at.microsSinceUnixEpoch <= now).sort((a, b) => (a.created_at.microsSinceUnixEpoch < b.created_at.microsSinceUnixEpoch ? 1 : -1));
  for (const c of finished.slice(KEEP_FINISHED)) ctx.db.incoming_call.id.delete(c.id);
  const id = newId(ctx, 'call_', (x) => !!ctx.db.incoming_call.id.find(x));
  ctx.db.incoming_call.insert({ id, household_id, alert_id, title, source, status: 'ringing', created_at: ctx.timestamp, expires_at: new Timestamp(now + micros(RING_SECS)), answered_by: '' });
  return id;
}
