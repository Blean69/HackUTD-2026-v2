// Lifecycle reducers: init, client connected, client disconnected.
import spacetimedb from '../schema';
import { recordPublisher } from '../config';
import { ensureTick } from '../recompute';

export const init = spacetimedb.init((ctx) => {
  // Runs on first publish and after `publish --delete-data` (not on a plain republish). The host calls it as the
  // publishing identity, so ctx.sender is who may later call admin_set_worker_secret_hash. Also starts the 60 s tick.
  recordPublisher(ctx);
  ensureTick(ctx);
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  // A module republished without --delete-data does not re-run init(), so make sure the tick exists.
  ensureTick(ctx);
  // The agent worker is not a "person in the room".
  if (ctx.db.worker.identity.find(ctx.sender)) return;
  const prev = ctx.db.presence.identity.find(ctx.sender);
  if (prev) {
    ctx.db.presence.identity.update({ ...prev, last_seen: ctx.timestamp });
  } else {
    // Everyone starts in the lobby until they call join_room.
    ctx.db.presence.insert({
      identity: ctx.sender,
      household_id: '',
      display_name: 'Guest',
      role: 'guest',
      last_seen: ctx.timestamp,
    });
  }
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  ctx.db.presence.identity.delete(ctx.sender);
});
