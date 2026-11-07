// LLMClient: ordered provider failover with exponential backoff, a global concurrency cap and per-provider RPM limits.
import type { Config } from '../config.js';
import { sleep as realSleep } from '../util.js';
import { RateLimiter, Semaphore } from './limiter.js';
import { LocalProvider } from './local.js';
import { OpenAICompatProvider, toLLMError } from './openai.js';
import { LLMError, type ChatRequest, type ChatResult, type LLMProvider, type ProviderId } from './types.js';

export interface LLMClientOptions {
  concurrency?: number;
  retriesPerProvider?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** After a provider exhausts its attempts it is skipped for this long (a dead provider should not cost a timeout per call). */
  cooldownMs?: number;
  /** On HTTP 429, wait/back off on the same provider for up to this long (default 3000 ms) before failing over. */
  rateLimitWaitMs?: number;
  rpm?: Partial<Record<ProviderId, number>>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface LLMLike {
  chat(req: ChatRequest): Promise<ChatResult>;
  hasProvider(id: ProviderId): boolean;
}

export interface ProviderStatus {
  provider: ProviderId;
  model_agent: string;
  model_fast: string;
  state: 'ready' | 'cooling_down';
  last_error: string;
  ok: number;
  failed: number;
}

export class LLMClient implements LLMLike {
  private sem: Semaphore;
  private limiters = new Map<ProviderId, RateLimiter>();
  private coolUntil = new Map<ProviderId, number>();
  private lastError = new Map<ProviderId, string>();
  private okCount = new Map<ProviderId, number>();
  private failCount = new Map<ProviderId, number>();
  private retries: number;
  private backoffBase: number;
  private backoffMax: number;
  private cooldown: number;
  private rateLimitWait: number;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(
    readonly providers: LLMProvider[],
    opts: LLMClientOptions = {},
  ) {
    this.sem = new Semaphore(opts.concurrency ?? 4);
    this.retries = opts.retriesPerProvider ?? 1;
    this.backoffBase = opts.backoffBaseMs ?? 800;
    this.backoffMax = opts.backoffMaxMs ?? 8000;
    this.cooldown = opts.cooldownMs ?? 30_000;
    this.rateLimitWait = opts.rateLimitWaitMs ?? 3000;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    for (const p of providers) {
      const rpm = opts.rpm?.[p.id] ?? 0;
      this.limiters.set(p.id, new RateLimiter(p.id === 'local' ? 0 : rpm, this.now, this.sleep));
    }
  }

  hasProvider(id: ProviderId): boolean {
    return this.providers.some((p) => p.id === id);
  }

  /** The provider/model a new request would try first (skips providers that are cooling down). */
  primary(role: 'agent' | 'fast' = 'agent'): { provider: ProviderId; model: string } {
    const t = this.now();
    const p = this.providers.find((x) => x.id === 'local' || (this.coolUntil.get(x.id) ?? 0) <= t) ?? this.providers[0]!;
    return { provider: p.id, model: p.modelFor(role) };
  }

  status(): ProviderStatus[] {
    const t = this.now();
    return this.providers.map((p) => ({
      provider: p.id,
      model_agent: p.modelFor('agent'),
      model_fast: p.modelFor('fast'),
      state: (this.coolUntil.get(p.id) ?? 0) > t ? 'cooling_down' : 'ready',
      last_error: this.lastError.get(p.id) ?? '',
      ok: this.okCount.get(p.id) ?? 0,
      failed: this.failCount.get(p.id) ?? 0,
    }));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const t = this.now();
    let candidates = req.only?.length
      ? this.providers.filter((p) => req.only!.includes(p.id))
      : this.providers.filter((p) => p.id === 'local' || (this.coolUntil.get(p.id) ?? 0) <= t);
    if (!candidates.length) candidates = this.providers.filter((p) => p.id === 'local'); // everything cooling down
    if (!candidates.length) candidates = this.providers; // nothing but cooling remote providers: try anyway

    const failovers: { provider: ProviderId; error: string }[] = [];
    for (const p of candidates) {
      const maxAttempts = p.id === 'local' ? 1 : this.retries + 1;
      let attempt = 0;
      let waited429 = 0;
      for (;;) {
        try {
          const res = await this.callOnce(p, req);
          this.okCount.set(p.id, (this.okCount.get(p.id) ?? 0) + 1);
          this.coolUntil.delete(p.id);
          return failovers.length ? { ...res, failovers } : res;
        } catch (e) {
          const err = toLLMError(e);
          this.lastError.set(p.id, err.message.slice(0, 200));
          this.failCount.set(p.id, (this.failCount.get(p.id) ?? 0) + 1);
          let backoff: number | null = null;
          if (err.status === 429 && p.id !== 'local') {
            // rate limited: prefer a short wait on this provider (so Nemotron answers) over failing over right away
            const left = this.rateLimitWait - waited429;
            if (left >= 250) {
              backoff = Math.min(left, this.backoffMax, err.retryAfterMs ?? this.backoffBase * 2 ** Math.min(attempt, 6));
              waited429 += backoff;
              this.limiters.get(p.id)?.penalize(backoff);
            }
          } else if (err.retryable && attempt < maxAttempts - 1) {
            backoff = Math.min(this.backoffMax, this.backoffBase * 2 ** attempt);
          }
          attempt++;
          if (backoff === null) {
            failovers.push({ provider: p.id, error: err.message.slice(0, 160) });
            if (p.id !== 'local' && !req.only) this.coolUntil.set(p.id, this.now() + (err.status === 429 ? Math.min(this.cooldown, 8000) : this.cooldown));
            break;
          }
          await this.sleep(backoff + Math.floor(Math.random() * 100));
        }
      }
    }
    throw new LLMError(`all LLM providers failed: ${failovers.map((f) => `${f.provider} (${f.error})`).join('; ') || 'none configured'}`);
  }

  private async callOnce(p: LLMProvider, req: ChatRequest): Promise<ChatResult> {
    if (p.id === 'local') return p.call(req);
    return this.sem.run(async () => {
      await this.limiters.get(p.id)?.acquire();
      return p.call(req);
    });
  }
}

export function buildLLMClient(
  cfg: Config,
  extra: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): LLMClient {
  const providers: LLMProvider[] = [];
  const rpm: Partial<Record<ProviderId, number>> = {};
  for (const id of cfg.providerOrder) {
    if (id === 'local') {
      if (!providers.some((p) => p.id === 'local')) providers.push(new LocalProvider());
      continue;
    }
    const pc = cfg.providers.find((p) => p.id === id);
    if (!pc || !pc.enabled) continue;
    providers.push(new OpenAICompatProvider(pc, { timeoutMs: cfg.llmTimeoutMs, ...(extra.fetch ? { fetch: extra.fetch } : {}) }));
    rpm[id] = pc.rpm;
  }
  if (cfg.localFallback && !providers.some((p) => p.id === 'local')) providers.push(new LocalProvider());
  return new LLMClient(providers, {
    concurrency: cfg.llmConcurrency,
    retriesPerProvider: cfg.llmRetriesPerProvider,
    rateLimitWaitMs: cfg.rateLimitWaitMs,
    rpm,
    ...(extra.sleep ? { sleep: extra.sleep } : {}),
  });
}
