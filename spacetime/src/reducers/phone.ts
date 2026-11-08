// "Call Brian by phone": a per-household 5-digit keypad code (docs/contracts.md section 8).
//
//  - `set_phone_pin(household_id, pin)`  the household owner, or (seeded demo households have no owner) anyone in that room
//  - `clear_phone_pin(household_id)`     same people; switches the household's code off
//  - `worker_phone_access`               VIEW, registered workers only: the salted hashes the worker checks a caller's keys against
//
// Why a view and not a `verify_phone_pin(pin) -> household_id` reducer: in SpacetimeDB 2.14.1 a reducer returns nothing to its caller
// (the TypeScript SDK resolves a reducer call with `void`; only procedures return values, and those are the unstable API this module
// avoids, see spacetime/README.md "Procedures"). The worker already reads its Plaid tokens through a worker-only view
// (`worker_plaid_items`), so the codes use the same pattern: the worker subscribes to the view, keeps the rows in its client
// cache, and checks a caller's digits against them with a constant-time compare (services/worker/src/phone/access.ts). That also keeps
// the per-call and per-caller try limits in one place, the worker, instead of handing out a guessing oracle that is open to every client.
//
// The code itself is never stored, logged, echoed in an error message or returned: `console.*` below only ever sees the household id.
import { t } from 'spacetimedb/server';
import spacetimedb, { phone_access } from '../schema';
import { sameHex } from '../config';
import { hashPin, newSalt, PHONE_PIN_LENGTH, weakPinReason } from '../phone';
import { fail, requireHousehold, type Ctx } from '../util';

/** Owner of the household; seeded households have no owner, so anyone who is in that room may manage the code. */
function requireCanManage(ctx: Ctx, household_id: string): void {
  const hh = requireHousehold(ctx, household_id);
  if (hh.owner) {
    if (!hh.owner.isEqual(ctx.sender)) fail('only the household owner can change its phone code');
    return;
  }
  const here = ctx.db.presence.identity.find(ctx.sender);
  if (!here || here.household_id !== household_id) fail('join this household room first to change its phone code');
}

function writeStatus(ctx: Ctx, household_id: string, has_pin: boolean): void {
  const row = { household_id, has_pin, updated_at: ctx.timestamp };
  if (ctx.db.phone_access_status.household_id.find(household_id)) ctx.db.phone_access_status.household_id.update(row);
  else ctx.db.phone_access_status.insert(row);
}

/**
 * Set or change the household's 5-digit phone code. Rejects: a code that is not exactly five digits, an easy one (same digit,
 * a straight run, two alternating digits), and one that another household already uses (compared by recomputing each other
 * row's salted hash, so no two households can ever share a code). Setting the household's own current code again is fine.
 */
export const set_phone_pin = spacetimedb.reducer({ household_id: t.string(), pin: t.string() }, (ctx, { household_id, pin }) => {
  requireCanManage(ctx, household_id);
  if (!new RegExp(`^[0-9]{${PHONE_PIN_LENGTH}}$`).test(pin)) fail(`the phone code must be exactly ${PHONE_PIN_LENGTH} digits`);
  const weak = weakPinReason(pin);
  if (weak) fail(weak);
  for (const other of ctx.db.phone_access.iter()) {
    if (other.household_id === household_id) continue;
    if (sameHex(hashPin(other.salt, pin), other.pin_hash)) fail('that code is already taken, pick a different one');
  }
  const salt = newSalt(ctx.random);
  const row = { household_id, pin_hash: hashPin(salt, pin), salt, updated_at: ctx.timestamp, set_by: ctx.sender };
  if (ctx.db.phone_access.household_id.find(household_id)) ctx.db.phone_access.household_id.update(row);
  else ctx.db.phone_access.insert(row);
  writeStatus(ctx, household_id, true);
  console.info(`set_phone_pin: code saved for ${household_id}`);
});

/** Switch the household's phone code off (callers can no longer use it). No-op when none is set. */
export const clear_phone_pin = spacetimedb.reducer({ household_id: t.string() }, (ctx, { household_id }) => {
  requireCanManage(ctx, household_id);
  ctx.db.phone_access.household_id.delete(household_id);
  if (ctx.db.phone_access_status.household_id.find(household_id)) writeStatus(ctx, household_id, false);
  console.info(`clear_phone_pin: code removed for ${household_id}`);
});

/**
 * Registered workers read the salted code hashes through this view; `phone_access` itself is private. Anyone who is not in the
 * `worker` table gets an empty result. (Same pattern as `worker_plaid_items`.)
 */
export const worker_phone_access = spacetimedb.view(
  { name: 'worker_phone_access', public: true },
  t.array(phone_access.rowType),
  (ctx) => (ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.phone_access.iter()] : []),
);
