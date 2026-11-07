// Module configuration helpers (not part of the module surface: nothing here is exported from index.ts).
//
// The worker-secret hash is resolved in two layers:
//   1. the PRIVATE `module_config` row, when `worker_secret_hash` is non-empty (set by `admin_set_worker_secret_hash`)
//   2. the dev hash below, so a fresh checkout works with WORKER_SECRET=keystone-dev-secret
// Production therefore needs no source edit: `infra/deploy.sh` calls the admin reducer right after publishing.
import type { Ctx } from './util';

/** SHA-256 (hex) of the PUBLIC dev secret `keystone-dev-secret`. Never a production value (the repo is public). */
export const DEV_WORKER_SECRET_SHA256 = '42c50c717ac955d1a374d919e57aa767830e7a175f16f609657ea8fce2a422eb';

/** `module_config` holds exactly one row, with this id. */
export const CONFIG_ID = 1;

export function readConfig(ctx: Ctx) {
  return ctx.db.module_config.id.find(CONFIG_ID) ?? null;
}

/** The hash `register_worker` compares against: the override if one is set, otherwise the dev hash. */
export function effectiveWorkerHash(ctx: Ctx): string {
  const override = readConfig(ctx)?.worker_secret_hash ?? '';
  return override !== '' ? override : DEV_WORKER_SECRET_SHA256;
}

/** Record `ctx.sender` as the publisher. Called from `init`, which the host runs as the publishing identity. */
export function recordPublisher(ctx: Ctx): void {
  const prev = readConfig(ctx);
  const row = { id: CONFIG_ID, publisher: ctx.sender, worker_secret_hash: prev?.worker_secret_hash ?? '', updated_at: ctx.timestamp };
  if (prev) ctx.db.module_config.id.update(row);
  else ctx.db.module_config.insert(row);
}

/** Length-independent-looking compare for hex digests (the digests are public-length, so this is belt and braces). */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
