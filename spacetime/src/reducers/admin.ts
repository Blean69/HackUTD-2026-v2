// Operator-only reducers. Today: rotating the worker-secret hash without editing source (see src/config.ts).
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { CONFIG_ID, readConfig } from '../config';
import { fail } from '../util';

/**
 * Set (or with "" clear) the SHA-256 that `register_worker` accepts, overriding the dev hash compiled into the module.
 *
 *   printf %s "$WORKER_SECRET" | sha256sum | cut -d' ' -f1      # then pass the hex digest
 *
 * Who may call it:
 *  - the publisher: `init` records `ctx.sender` of the publishing call in `module_config.publisher` (verified against a real
 *    SpacetimeDB 2.14.1 server: the recorded identity equals the CLI identity that ran `spacetime publish`). The publisher can call it any time, including to rotate.
 *  - LEGACY ONLY, for a database published before `init` recorded anyone (init does not re-run on a republish): while no
 *    publisher is recorded AND no override exists yet, a caller that is already registered as a worker may set the first
 *    override, and is then recorded as the publisher so it can rotate later. Document: DEPLOY.md, "database published
 *    before this change".
 * Everyone else gets "not allowed". The hash is stored in a private table; it is never logged or returned.
 */
export const admin_set_worker_secret_hash = spacetimedb.reducer({ sha256_hex: t.string() }, (ctx, { sha256_hex }) => {
  const cfg = readConfig(ctx);
  let allowed = false;
  let adopt = false;
  if (cfg?.publisher) {
    allowed = cfg.publisher.isEqual(ctx.sender);
  } else if ((cfg?.worker_secret_hash ?? '') === '' && ctx.db.worker.identity.find(ctx.sender)) {
    allowed = true;
    adopt = true;
  }
  if (!allowed) fail('not allowed: only the identity that published this database can change the worker secret hash');

  const hex = (sha256_hex ?? '').trim().toLowerCase();
  if (hex !== '' && !/^[0-9a-f]{64}$/.test(hex)) fail('sha256_hex must be 64 hex characters (pass "" to go back to the dev default)');

  const row = {
    id: CONFIG_ID,
    publisher: adopt ? ctx.sender : cfg?.publisher,
    worker_secret_hash: hex,
    updated_at: ctx.timestamp,
  };
  if (cfg) ctx.db.module_config.id.update(row);
  else ctx.db.module_config.insert(row);
  console.info(`admin_set_worker_secret_hash: ${hex === '' ? 'override cleared (dev default active)' : 'override set'}`);
});
