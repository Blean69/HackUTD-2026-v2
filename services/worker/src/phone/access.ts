// Household phone codes ("Call Brian by phone", docs/contracts.md section 8): the codes families set in the app, stored in
// SpacetimeDB as salted hashes (private table `phone_access`; spacetime/src/reducers/phone.ts) and read by this worker through the
// worker-only view `worker_phone_access` (the same pattern as `worker_plaid_items`).
//
// The hash must match spacetime/src/phone.ts exactly:  sha256_hex( PHONE_PIN_PEPPER + ":" + salt + ":" + pin ).
// The pepper is domain separation, not a secret (the repo is public); the vector in access.test.ts pins both sides to the same bytes.
//
// The code itself is never logged here. A caller's digits are hashed once per stored row and compared in constant time, with no
// early exit, so timing does not reveal which household (or how many) hold a code.
import { createHash, timingSafeEqual } from 'node:crypto';
import { subscribeAndWait } from '../db/connection.js';
import type { DbConnection } from '../module_bindings/index.js';

export const PHONE_PIN_PEPPER = 'keystone/phone-pin/v1';

/** One `phone_access` row as the worker sees it (the household's code is only ever present as hash + salt). */
export interface PhoneCodeRow {
  householdId: string;
  salt: string;
  pinHash: string;
}

/** Where the stored codes come from: the SpacetimeDB view in production, an array in tests. */
export interface PhoneCodeSource {
  /** Resolves once the codes are loaded (or have failed to; the caller then falls back to the env PINs). Never rejects. */
  ready?(): Promise<void>;
  rows(): readonly PhoneCodeRow[];
}

export function hashPin(salt: string, pin: string): string {
  return createHash('sha256').update(`${PHONE_PIN_PEPPER}:${salt}:${pin}`).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;
/** Longest input we bother hashing: a real code is 5 digits, anything longer cannot match and only costs CPU. */
const MAX_CODE_CHARS = 32;

/**
 * The household whose stored code equals `pin`, or undefined. Walks every row (no early exit, constant-time digest compare) and
 * returns the first match in row order. Rows with a malformed hash are skipped but still cost one compare.
 */
export function matchStoredPin(rows: readonly PhoneCodeRow[], pin: string): string | undefined {
  const given = String(pin ?? '').trim().slice(0, MAX_CODE_CHARS);
  const dummy = Buffer.alloc(32);
  let found: string | undefined;
  for (const row of rows) {
    const stored = HEX64.test(row.pinHash) ? Buffer.from(row.pinHash, 'hex') : dummy;
    const candidate = Buffer.from(hashPin(row.salt, given), 'hex');
    const equal = timingSafeEqual(candidate, stored);
    if (equal && stored !== dummy && found === undefined) found = row.householdId;
  }
  return found;
}

/** Fixed rows, for tests and for running without SpacetimeDB. */
export class StaticPhoneCodes implements PhoneCodeSource {
  constructor(public list: PhoneCodeRow[] = []) {}
  rows(): readonly PhoneCodeRow[] {
    return this.list;
  }
}

/**
 * Live codes: subscribes to `SELECT * FROM worker_phone_access` and reads the client cache, so a code a family sets in the app (or
 * changes, or clears) works on the very next call. If the module has no such view yet (published before this feature), `ready`
 * still resolves, `rows()` is empty and the env PINs keep working.
 */
export class SpacetimePhoneCodes implements PhoneCodeSource {
  private sub: Promise<unknown> | null = null;
  attached = false;

  constructor(
    private conn: DbConnection,
    private warn: (msg: string) => void = (m) => console.warn(m),
  ) {}

  /** Subscribe once. Safe to call again. */
  attach(): Promise<void> {
    this.sub ??= subscribeAndWait(this.conn, ['SELECT * FROM worker_phone_access'])
      .then(() => {
        this.attached = true;
      })
      .catch((e: unknown) => {
        this.sub = null; // try again on the next call (the module may be published a moment later)
        this.warn(`[phone] household codes unavailable (${e instanceof Error ? e.message.slice(0, 120) : 'subscription failed'}); only PHONE_PINS will work`);
      });
    return this.sub as Promise<void>;
  }

  async ready(): Promise<void> {
    await Promise.race([this.attach(), new Promise<void>((resolve) => setTimeout(resolve, 3000).unref())]);
  }

  rows(): readonly PhoneCodeRow[] {
    const table = (this.conn.db as unknown as { workerPhoneAccess?: { iter(): Iterable<{ householdId: string; salt: string; pinHash: string }> } }).workerPhoneAccess;
    if (!table) return [];
    const out: PhoneCodeRow[] = [];
    for (const r of table.iter()) out.push({ householdId: r.householdId, salt: r.salt, pinHash: r.pinHash });
    return out;
  }
}
