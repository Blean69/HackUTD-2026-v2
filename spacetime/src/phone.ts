// Phone-code helpers ("Call Brian by phone", docs/contracts.md section 8). Pure TypeScript, nothing here is exported from
// index.ts, so none of it becomes part of the module surface.
//
// The scheme is shared with the worker (services/worker/src/phone/access.ts), which must compute the same hash:
//
//     pin_hash = sha256_hex( PHONE_PIN_PEPPER + ":" + salt + ":" + pin )
//
// `salt` is random per row (a fresh one on every change), `PHONE_PIN_PEPPER` is a module-wide constant. The repo is public, so the
// pepper is domain separation, not a secret: the real protection is that `phone_access` is a private table and the hashes only
// reach registered workers (the `worker_phone_access` view). A 5-digit code has 100 000 values, so a leaked hash would be
// brute-forced in milliseconds whatever the hash is. Both sides pin a known test vector (phone.test.ts and the worker's access.test.ts).
import { sha256Hex } from './sha256';

/** Module-wide constant mixed into every code hash. Changing it invalidates every stored code (households would set theirs again). */
export const PHONE_PIN_PEPPER = 'keystone/phone-pin/v1';
export const PHONE_PIN_LENGTH = 5;

export function hashPin(salt: string, pin: string): string {
  return sha256Hex(`${PHONE_PIN_PEPPER}:${salt}:${pin}`);
}

/** A fresh salt: 24 hex characters from the reducer's RNG. It only has to be unique per row, not secret. */
export function newSalt(random: { integerInRange(min: number, max: number): number }): string {
  let out = '';
  for (let i = 0; i < 24; i++) out += '0123456789abcdef'[random.integerInRange(0, 15)];
  return out;
}

/**
 * Why a code is too easy to guess, or "" when it is acceptable. The caller must already have checked it is exactly 5 digits.
 *  - the same digit five times (00000, 77777)
 *  - a straight run, up or down, wrapping past 9 -> 0 (12345, 54321, 67890, 90123, 09876)
 *  - two digits alternating (12121, 40404)
 */
export function weakPinReason(pin: string): string {
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return 'a code can not be the same digit five times';
  const step = (a: number, b: number) => (b - a + 10) % 10;
  const deltas = d.slice(1).map((x, i) => step(d[i]!, x));
  if (deltas.every((x) => x === 1)) return 'a code can not count straight up (like 12345)';
  if (deltas.every((x) => x === 9)) return 'a code can not count straight down (like 54321)';
  if (d.every((x, i) => x === d[i % 2]!)) return 'a code can not just alternate two digits (like 12121)';
  return '';
}
