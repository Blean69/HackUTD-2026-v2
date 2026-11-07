// Concurrency + requests-per-minute limiter. The free NVIDIA tier is ~40 requests/min, so every remote call goes
// through one of these. `now`/`sleep` are injectable so tests do not need real time.
import { sleep as realSleep } from '../util.js';

export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(); // hand the slot over directly
      else this.active--;
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get inFlight(): number {
    return this.active;
  }
}

/** Sliding-window rate limiter: at most `rpm` acquisitions in any 60 s window. rpm <= 0 disables it. */
export class RateLimiter {
  private stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private blockedUntil = 0;
  constructor(
    readonly rpm: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
    private readonly windowMs = 60_000,
  ) {}

  /** Resolves when a request slot is available (FIFO). */
  acquire(): Promise<void> {
    if (this.rpm <= 0) return Promise.resolve();
    const next = this.chain.then(async () => {
      for (;;) {
        const t = this.now();
        if (t < this.blockedUntil) {
          await this.sleep(this.blockedUntil - t);
          continue;
        }
        this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
        if (this.stamps.length < this.rpm) {
          this.stamps.push(t);
          return;
        }
        const wait = this.windowMs - (t - this.stamps[0]!) + 5;
        await this.sleep(wait);
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Called on a 429: hold new requests back for `ms` (the server said we are over its limit even if our count was off). */
  penalize(ms = 2000): void {
    if (this.rpm <= 0) return;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }
}
