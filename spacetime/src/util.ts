// Helpers shared by the reducers. Nothing here is exported from the module entry point (index.ts), so none of it
// becomes part of the public reducer surface.
import { SenderError } from 'spacetimedb/server';
import type { InferSchema, ReducerCtx } from 'spacetimedb/server';
import type { Timestamp } from 'spacetimedb';
import type spacetimedb from './schema';

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

export const ROLES = ['family', 'advisor', 'guest'] as const;
export const WORKFLOWS = ['huddle', 'what_if', 'coach', 'scam_check', 'data_quality', 'plaid_sync', 'onboarding_insights', 'phone'] as const;

/** Reject the call with a message the client can show (a SenderError is the "expected error" channel). */
export function fail(message: string): never {
  throw new SenderError(message);
}

export function cleanText(value: string, field: string, max: number, allowEmpty = false): string {
  const v = (value ?? '').trim();
  if (!allowEmpty && v.length === 0) fail(`${field} must not be empty`);
  if (v.length > max) fail(`${field} is too long (max ${max} characters)`);
  return v;
}

/** YYYY-MM-DD (UTC) of a SpacetimeDB timestamp. */
export function isoDay(ts: Timestamp): string {
  return new Date(Number(ts.microsSinceUnixEpoch / 1000n)).toISOString().slice(0, 10);
}

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // 32 symbols, no i/l/o/u

/** Short random suffix. Uses ctx.random, which is deterministic per call and safe to use inside reducers. */
export function randomSuffix(ctx: Ctx, length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[ctx.random.integerInRange(0, 31)];
  return out;
}

/** `${prefix}${time-in-base36}${random}`: unique per call, sortable by creation time, built only from ctx. */
export function newId(ctx: Ctx, prefix: string, exists?: (id: string) => boolean): string {
  const time = (ctx.timestamp.microsSinceUnixEpoch / 1000n).toString(36);
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `${prefix}${time}${randomSuffix(ctx, 4)}`;
    if (!exists || !exists(id)) return id;
  }
  return fail('could not allocate an id, try again');
}

export function requireHousehold(ctx: Ctx, household_id: string) {
  const hh = ctx.db.household.id.find(household_id);
  if (!hh) fail(`unknown household "${household_id}"`);
  return hh;
}

/** Put the caller in a room (household_id "" = lobby), keeping one presence row per identity. */
export function upsertPresence(ctx: Ctx, household_id: string, display_name: string, role: string): void {
  const prev = ctx.db.presence.identity.find(ctx.sender);
  const row = { identity: ctx.sender, household_id, display_name, role, last_seen: ctx.timestamp };
  if (prev) ctx.db.presence.identity.update(row);
  else ctx.db.presence.insert(row);
}

/** Display name of the caller from their presence row, else a fallback. */
export function callerName(ctx: Ctx, fallback = 'Someone'): string {
  return ctx.db.presence.identity.find(ctx.sender)?.display_name || fallback;
}

export function parseJsonArray(text: string, field: string): unknown[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail(`${field} must be a JSON array`);
  }
  if (!Array.isArray(v)) return fail(`${field} must be a JSON array`);
  return v;
}

export function enqueueJob(
  ctx: Ctx,
  workflow: (typeof WORKFLOWS)[number],
  household_id: string,
  subject_id: string,
  input: unknown,
): void {
  ctx.db.agent_job.insert({
    id: 0n,
    workflow,
    household_id,
    subject_id,
    input_json: JSON.stringify(input ?? {}),
    status: 'queued',
    claimed_by: undefined,
    run_id: '',
    created_at: ctx.timestamp,
  });
}

/** Flag a household so `tick_recompute` refreshes its health math. */
export function markDirty(ctx: Ctx, household_id: string): void {
  if (ctx.db.dirty_household.household_id.find(household_id)) return;
  ctx.db.dirty_household.insert({ household_id, marked_at: ctx.timestamp });
}

/** A proposal from the seed data ("prop_rivera_second_location"), not one a visitor made: `newId` ids ("prop_mw7c64gtnr6k")
 *  never have a second underscore. Used to keep demo rooms and their private copies free of visitors' proposals. */
export const isSeededProposal = (id: string): boolean => id.startsWith('prop_') && id.slice(5).includes('_');
