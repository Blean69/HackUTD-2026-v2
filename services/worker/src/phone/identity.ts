// PIN check for the phone path: constant-time compare against every configured PIN (no early exit), 3 tries per call,
// plus a looser lockout per caller hash so a caller cannot get a fresh 3 tries just by hanging up.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { PinEntry } from './config.js';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export type PinResult = { ok: true; entry: PinEntry } | { ok: false; triesLeft: number; locked: boolean };

interface Counter {
  fails: number;
  at: number;
}

export class PinChecker {
  private byCall = new Map<string, Counter>();
  private byCaller = new Map<string, Counter>();

  constructor(
    private pins: Map<string, PinEntry>,
    private maxTries = 3,
    private now: () => number = Date.now,
    private callerWindowMs = 15 * 60_000,
  ) {}

  private prune(): void {
    const cutoff = this.now() - Math.max(this.callerWindowMs, 30 * 60_000);
    for (const m of [this.byCall, this.byCaller]) for (const [k, v] of m) if (v.at < cutoff) m.delete(k);
  }

  private callerFails(callerHash: string): number {
    const c = callerHash ? this.byCaller.get(callerHash) : undefined;
    return c && this.now() - c.at < this.callerWindowMs ? c.fails : 0;
  }

  locked(callId: string, callerHash = ''): boolean {
    return (this.byCall.get(callId)?.fails ?? 0) >= this.maxTries || this.callerFails(callerHash) >= this.maxTries * 3;
  }

  check(callId: string, callerHash: string, pin: string): PinResult {
    this.prune();
    if (this.locked(callId, callerHash)) return { ok: false, triesLeft: 0, locked: true };
    const given = digest(String(pin ?? '').trim());
    let matched: PinEntry | undefined;
    for (const [p, entry] of this.pins) {
      // no break: every PIN is compared so timing does not reveal which one (or how many) exist
      if (timingSafeEqual(given, digest(p)) && !matched) matched = entry;
    }
    if (matched) {
      this.byCall.delete(callId);
      return { ok: true, entry: matched };
    }
    const c = this.byCall.get(callId) ?? { fails: 0, at: 0 };
    c.fails++;
    c.at = this.now();
    this.byCall.set(callId, c);
    if (callerHash) {
      const k = this.byCaller.get(callerHash) ?? { fails: 0, at: 0 };
      k.fails = this.callerFails(callerHash) + 1;
      k.at = this.now();
      this.byCaller.set(callerHash, k);
    }
    const left = Math.max(0, this.maxTries - c.fails);
    return { ok: false, triesLeft: left, locked: left === 0 };
  }
}
