// Brian calls the household in the app (docs/contracts.md section 13). Hackathon scope like every client reducer: anyone in the room may call these.
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { CLIENT_CALL_SOURCES, DEFAULT_RING_TITLE, ring } from '../calls';
import { callerName, cleanText, fail, requireHousehold } from '../util';

/**
 * Ring the household: "Brian is calling". A no-op while a ring is already going or very recent. alert_id may be "" (Brian picks the alert when answered).
 * What the screen SAYS is never taken from the client: it is the named alert's title, or a fixed line, so nobody can put words in Brian's mouth.
 * `title` is accepted for older clients and ignored.
 */
export const request_brian_call = spacetimedb.reducer(
  { household_id: t.string(), alert_id: t.string(), title: t.string(), source: t.string() },
  (ctx, { household_id, alert_id, source }) => {
    requireHousehold(ctx, household_id);
    if (!(CLIENT_CALL_SOURCES as readonly string[]).includes(source)) fail(`source must be one of ${CLIENT_CALL_SOURCES.join(', ')}`);
    let title = DEFAULT_RING_TITLE;
    if (alert_id) {
      const a = ctx.db.alert.id.find(alert_id);
      if (!a || a.household_id !== household_id) fail(`unknown alert "${alert_id}" for this household`);
      title = cleanText(a.title, 'title', 140, true) || DEFAULT_RING_TITLE;
    }
    ring(ctx, household_id, alert_id, title, source);
  },
);

/** Someone picked up. Only a call that is still ringing can be answered, so a second phone gets a clear "already answered". */
export const answer_brian_call = spacetimedb.reducer({ call_id: t.string(), display_name: t.string() }, (ctx, { call_id, display_name }) => {
  const c = ctx.db.incoming_call.id.find(call_id);
  if (!c) fail(`unknown call "${call_id}"`);
  if (c.status !== 'ringing') fail('this call was already answered or has ended');
  // Late: refuse, and leave the row to expire_brian_call (a write here would be rolled back by the failure anyway).
  if (c.expires_at.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) fail('this call has ended');
  ctx.db.incoming_call.id.update({ ...c, status: 'answered', answered_by: cleanText(display_name, 'display_name', 40, true) || callerName(ctx) });
});

/** Not now: ends the ring for everyone in the room. */
export const decline_brian_call = spacetimedb.reducer({ call_id: t.string() }, (ctx, { call_id }) => {
  const c = ctx.db.incoming_call.id.find(call_id);
  if (c && c.status === 'ringing') ctx.db.incoming_call.id.update({ ...c, status: 'declined' });
});

/** Nobody answered in time (any client may report it; it only works once the deadline has passed). */
export const expire_brian_call = spacetimedb.reducer({ call_id: t.string() }, (ctx, { call_id }) => {
  const c = ctx.db.incoming_call.id.find(call_id);
  if (c && c.status === 'ringing' && c.expires_at.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) ctx.db.incoming_call.id.update({ ...c, status: 'missed' });
});
