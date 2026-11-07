import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { LLMClient, buildLLMClient } from './client.js';
import { RateLimiter, Semaphore } from './limiter.js';
import { LocalProvider } from './local.js';
import { OpenAICompatProvider, buildBody, portableSchema } from './openai.js';
import { extractFromLines, findDate, findMoney, parseScenarioPrompt } from './rules.js';
import { structured } from './structured.js';
import { LLMError, type ChatRequest, type ChatResult, type LLMProvider, type ProviderId } from './types.js';

const ok = (provider: ProviderId, content = 'hi'): ChatResult => ({ content, toolCalls: [], provider, model: `${provider}-model`, latencyMs: 5, tokensIn: 10, tokensOut: 3 });
const req: ChatRequest = { role: 'agent', messages: [{ role: 'user', content: 'hello' }] };

function fake(id: ProviderId, impl: (n: number) => ChatResult | Error): LLMProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    modelFor: () => `${id}-model`,
    async call(): Promise<ChatResult> {
      const r = impl(p.calls++);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return p;
}

describe('LLMClient failover', () => {
  it('retries a 429 with exponential backoff, then succeeds on the same provider', async () => {
    const sleeps: number[] = [];
    const nv = fake('nvidia', (n) => (n < 2 ? new LLMError('rate limited', 429) : ok('nvidia')));
    const c = new LLMClient([nv], { retriesPerProvider: 2, backoffBaseMs: 100, sleep: async (ms) => void sleeps.push(ms) });
    const r = await c.chat(req);
    expect(r.provider).toBe('nvidia');
    expect(nv.calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(100);
    expect(sleeps[1]!).toBeGreaterThanOrEqual(200);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });
  it('fails over nvidia -> tenvor -> local and records who failed', async () => {
    const nv = fake('nvidia', () => new LLMError('HTTP 503', 503));
    const tv = fake('tenvor_nemotron', () => new LLMError('timeout', undefined));
    const c = new LLMClient([nv, tv, new LocalProvider()], { retriesPerProvider: 0, sleep: async () => undefined });
    const r = await c.chat({ ...req, task: 'x', local: { text: 'offline answer' } });
    expect(r.provider).toBe('local');
    expect(r.content).toBe('offline answer');
    expect(r.failovers?.map((f) => f.provider)).toEqual(['nvidia', 'tenvor_nemotron']);
  });
  it('on 429 waits on the same provider (up to ~3 s) so Nemotron can still answer, honouring Retry-After', async () => {
    const sleeps: number[] = [];
    const nv = fake('nvidia', (n) => (n === 0 ? new LLMError('HTTP 429', 429, 1000) : ok('nvidia')));
    const qw = fake('tenvor_qwen', () => ok('tenvor_qwen'));
    const c = new LLMClient([nv, qw], { retriesPerProvider: 0, sleep: async (ms) => void sleeps.push(ms) });
    expect((await c.chat(req)).provider).toBe('nvidia');
    expect(qw.calls).toBe(0);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(1000);
    expect(sleeps[0]!).toBeLessThan(1200);
  });
  it('a persistent 429 fails over to Qwen after at most ~3 s of waiting, and the result says tenvor_qwen', async () => {
    const sleeps: number[] = [];
    const nv = fake('nvidia', () => new LLMError('HTTP 429', 429));
    const qw = fake('tenvor_qwen', () => ok('tenvor_qwen'));
    const c = new LLMClient([nv, qw], { retriesPerProvider: 0, backoffBaseMs: 500, sleep: async (ms) => void sleeps.push(ms) });
    const r = await c.chat(req);
    expect(r.provider).toBe('tenvor_qwen');
    expect(r.model).toBe('tenvor_qwen-model');
    expect(r.failovers?.[0]?.provider).toBe('nvidia');
    const waited = sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeLessThanOrEqual(3000 + 100 * sleeps.length);
    expect(waited).toBeGreaterThanOrEqual(2500);
  });
  it('primary() skips a provider that is cooling down', async () => {
    let t = 0;
    const c = new LLMClient([fake('nvidia', () => new LLMError('down', 500)), fake('tenvor_qwen', () => ok('tenvor_qwen'))], { retriesPerProvider: 0, now: () => t, sleep: async () => undefined });
    expect(c.primary().provider).toBe('nvidia');
    await c.chat(req);
    expect(c.primary()).toEqual({ provider: 'tenvor_qwen', model: 'tenvor_qwen-model' });
  });
  it('a 400 does not burn retries; it moves on immediately', async () => {
    const nv = fake('nvidia', () => new LLMError('bad request', 400, undefined, false));
    const tv = fake('tenvor_qwen', () => ok('tenvor_qwen'));
    const c = new LLMClient([nv, tv], { retriesPerProvider: 3, sleep: async () => undefined });
    expect((await c.chat(req)).provider).toBe('tenvor_qwen');
    expect(nv.calls).toBe(1);
  });
  it('skips a provider that just failed (cooldown) instead of paying a timeout per call', async () => {
    let t = 0;
    const nv = fake('nvidia', () => new LLMError('down', 500));
    const lo = fake('local', () => ok('local'));
    const c = new LLMClient([nv, lo], { retriesPerProvider: 0, cooldownMs: 1000, now: () => t, sleep: async () => undefined });
    await c.chat(req);
    await c.chat(req);
    expect(nv.calls).toBe(1);
    t = 5000;
    await c.chat(req);
    expect(nv.calls).toBe(2);
  });
  it('throws when every provider fails', async () => {
    const c = new LLMClient([fake('nvidia', () => new LLMError('x', 500))], { retriesPerProvider: 0, sleep: async () => undefined });
    await expect(c.chat(req)).rejects.toThrow(/all LLM providers failed/);
  });
  it('default order is nvidia,brev,tenvor_qwen; providers with an empty key, model or base URL are skipped silently', () => {
    expect(loadConfig({}).providerOrder).toEqual(['nvidia', 'brev', 'tenvor_qwen']);
    const env = { NVIDIA_API_KEY: 'k', TENVOR_API_KEY: 't', TENVOR_NEMOTRON_MODEL: '', TENVOR_QWEN_MODEL: 'Qwen/Qwen3-30B-A3B' };
    const c = loadConfig({ ...env, LLM_PROVIDER_ORDER: 'nvidia,tenvor_nemotron,tenvor_qwen' });
    expect(c.providers.find((p) => p.id === 'tenvor_nemotron')!.enabled).toBe(false);
    expect(buildLLMClient(c).providers.map((p) => p.id)).toEqual(['nvidia', 'tenvor_qwen', 'local']);
    expect(loadConfig({ ...env, TENVOR_BASE_URL: '' }).providers.find((p) => p.id === 'tenvor_qwen')!.enabled).toBe(false);
    expect(loadConfig({ NVIDIA_API_KEY: 'k', NEMOTRON_MODEL: '' }).providers[0]!.enabled).toBe(true); // empty model falls back to the default id
    expect(loadConfig({ NVIDIA_API_KEY: 'k', NVIDIA_BASE_URL: '' }).providers[0]!.enabled).toBe(false);
  });
  it('brev (our Nemotron on an NVIDIA Brev GPU) sits between the API and Qwen once configured; key defaults to EMPTY', () => {
    const env = { NVIDIA_API_KEY: 'k', TENVOR_API_KEY: 't', TENVOR_QWEN_MODEL: 'qwen' };
    expect(buildLLMClient(loadConfig(env)).providers.map((p) => p.id)).toEqual(['nvidia', 'tenvor_qwen', 'local']);
    const c = loadConfig({ ...env, BREV_BASE_URL: 'https://brev.example/v1', BREV_NEMOTRON_MODEL: 'nemotron-lightning' });
    expect(buildLLMClient(c).providers.map((p) => p.id)).toEqual(['nvidia', 'brev', 'tenvor_qwen', 'local']);
    const brev = c.providers.find((p) => p.id === 'brev')!;
    expect(brev.apiKey).toBe('EMPTY');
    expect(brev.fastModel).toBe('nemotron-lightning');
  });
  it('builds from config: no keys -> local only; keys -> nvidia first, local appended', () => {
    expect(buildLLMClient(loadConfig({})).providers.map((p) => p.id)).toEqual(['local']);
    const withKey = buildLLMClient(loadConfig({ NVIDIA_API_KEY: 'k', TENVOR_API_KEY: 't', TENVOR_QWEN_MODEL: 'qwen' }));
    expect(withKey.providers.map((p) => p.id)).toEqual(['nvidia', 'tenvor_qwen', 'local']);
    expect(withKey.providers[0]!.modelFor('agent')).toBe('nvidia/nemotron-3-ultra-550b-a55b');
    expect(withKey.providers[0]!.modelFor('fast')).toBe('nvidia/nemotron-3.5-lightning-30b-a3b');
  });
});

describe('limiters', () => {
  it('RateLimiter makes the 3rd request in a 2 rpm window wait for the window to roll', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter(2, () => t, async (ms) => { sleeps.push(ms); t += ms; });
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(59_000);
  });
  it('Semaphore caps concurrency', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => sem.run(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; })));
    expect(peak).toBe(2);
  });
});

describe('OpenAI-compatible provider', () => {
  const cfg = loadConfig({ NVIDIA_API_KEY: 'k', NEMOTRON_MODEL: 'nvidia/nemotron-3-super-120b-a12b' }).providers[0]!;
  it('sends enable_thinking in chat_template_kwargs and maps reasoning_content + tool calls + usage', async () => {
    let sent: any;
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'nvidia/nemotron-3-super-120b-a12b', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: 'I should check the balances first.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_accounts', arguments: '{}' } }] } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const p = new OpenAICompatProvider(cfg, { timeoutMs: 5000, fetch: fetchFn as never });
    const r = await p.call({ ...req, thinking: true, tools: [{ name: 'get_accounts', description: 'd', parameters: { type: 'object', properties: {} } }] });
    expect(String(fetchFn.mock.calls[0]![0])).toContain('integrate.api.nvidia.com/v1/chat/completions');
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: true, low_effort: true });
    expect(sent.model).toBe('nvidia/nemotron-3-super-120b-a12b');
    expect(sent.tools[0].function.name).toBe('get_accounts');
    expect(sent.tool_choice).toBe('auto');
    expect(r).toMatchObject({ provider: 'nvidia', reasoning: 'I should check the balances first.', tokensIn: 120, tokensOut: 30 });
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'get_accounts', arguments: '{}' }]);
  });
  it('uses the fast model with thinking off for extraction and forces the named tool', async () => {
    const body = buildBody(cfg, cfg.fastModel, { role: 'fast', messages: [], thinking: false, tools: [{ name: 'extract', description: 'd', parameters: {} }], toolChoice: { name: 'extract' } });
    expect(body.model).toBe('nvidia/nemotron-3.5-lightning-30b-a3b');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'extract' } });
    expect(body.reasoning_budget).toBeUndefined();
  });
  it('falls back to the next Nemotron when the configured model answers 404 for this key, and says so', async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const model = JSON.parse(String(init?.body)).model as string;
      seen.push(model);
      if (model.includes('super')) return new Response('{"status":404,"title":"Not Found"}', { status: 404, headers: { 'content-type': 'application/problem+json' } });
      return new Response(JSON.stringify({ model, choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const p = new OpenAICompatProvider(cfg, { timeoutMs: 5000, fetch: fetchFn as never, fallbackModels: ['nvidia/nemotron-3-ultra-550b-a55b'] });
    expect(p.modelFor('agent')).toBe('nvidia/nemotron-3-super-120b-a12b');
    const r = await p.call(req);
    expect(r.model).toBe('nvidia/nemotron-3-ultra-550b-a55b');
    expect(r.modelSwitch).toEqual([expect.objectContaining({ from: 'nvidia/nemotron-3-super-120b-a12b', to: 'nvidia/nemotron-3-ultra-550b-a55b' })]);
    expect(p.modelFor('agent')).toBe('nvidia/nemotron-3-ultra-550b-a55b'); // remembered: no second 404 probe
    await p.call(req);
    expect(seen).toEqual(['nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-ultra-550b-a55b']);
  });
  it('sends Ultra its own effort knob and the tool-call flag', () => {
    const body = buildBody(cfg, 'nvidia/nemotron-3-ultra-550b-a55b', { role: 'agent', messages: [], thinking: true, tools: [{ name: 't', description: 'd', parameters: {} }] });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, medium_effort: true, force_nonempty_content: true });
  });
  it('strips numeric/length constraints from tool schemas for non-NVIDIA providers (tenvor 400s on them) but keeps them as hints', () => {
    const schema = { type: 'object', properties: { months: { type: 'integer', minimum: 1, maximum: 60, description: 'Horizon' }, format: { type: 'string', maxLength: 10 } }, additionalProperties: false };
    const out = portableSchema(schema) as { properties: Record<string, { description?: string; minimum?: number; maxLength?: number }> };
    expect(out.properties.months).toEqual({ type: 'integer', description: 'Horizon (min 1, max 60)' });
    expect(out.properties.format).toEqual({ type: 'string', description: '(max 10 characters)' }); // a property NAMED "format" survives
    const tv = { ...cfg, id: 'tenvor_qwen' as const, agentModel: 'qwen', fastModel: 'qwen' };
    const tools = [{ name: 'define', description: 'd', parameters: schema }];
    expect(JSON.stringify(buildBody(tv, 'qwen', { role: 'fast', messages: [], tools }).tools)).not.toContain('maximum');
    expect(JSON.stringify(buildBody(cfg, cfg.fastModel, { role: 'fast', messages: [], tools }).tools)).toContain('maximum');
  });
  it('tenvor answers without reasoning unless TENVOR_THINKING=1; NVIDIA keeps the toggle', () => {
    const tv = { ...cfg, id: 'tenvor_qwen' as const, agentModel: 'qwen', fastModel: 'qwen' };
    expect(buildBody(tv, 'qwen', { role: 'agent', messages: [], thinking: true }).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(buildBody(cfg, cfg.agentModel, { role: 'agent', messages: [], thinking: true }).chat_template_kwargs).toMatchObject({ enable_thinking: true });
  });
  it('maps HTTP 429 to a retryable LLMError', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' } }));
    const p = new OpenAICompatProvider(cfg, { timeoutMs: 5000, fetch: fetchFn as never });
    await expect(p.call(req)).rejects.toMatchObject({ status: 429, retryable: true, retryAfterMs: 2000 });
  });
});

describe('structured output', () => {
  const schema = z.object({ n: z.number(), label: z.string() });
  it('validates, retries once with the error, and succeeds', async () => {
    let calls = 0;
    const llm = {
      hasProvider: () => true,
      chat: async (): Promise<ChatResult> => ({ ...ok('nvidia'), toolCalls: [{ id: '1', name: 'rec', arguments: calls++ === 0 ? '{"n":"oops"}' : '{"n":3,"label":"fine"}' }] }),
    };
    const r = await structured(llm, { name: 'rec', description: 'd', schema, task: 't', messages: [{ role: 'user', content: 'x' }] });
    expect(r.value).toEqual({ n: 3, label: 'fine' });
    expect(r.meta.attempts).toBe(2);
    expect(r.meta.tokensIn).toBe(20);
  });
  it('falls back to the local provider after two bad answers', async () => {
    const seen: (ProviderId[] | undefined)[] = [];
    const llm = {
      hasProvider: (id: ProviderId) => id === 'local',
      chat: async (r: ChatRequest): Promise<ChatResult> => {
        seen.push(r.only);
        return r.only ? { ...ok('local'), toolCalls: [{ id: '1', name: 'rec', arguments: '{"n":1,"label":"local"}' }] } : { ...ok('nvidia'), content: 'not json' };
      },
    };
    const r = await structured(llm, { name: 'rec', description: 'd', schema, task: 't', messages: [] });
    expect(r.meta.provider).toBe('local');
    expect(seen).toEqual([undefined, undefined, ['local']]);
  });
});

describe('local rules', () => {
  it('parses spoken and written money', () => {
    const v = (s: string) => findMoney(s).map((m) => m.value);
    expect(v('about two hundred fifty thousand for the build-out')).toEqual([250000]);
    expect(v('we have fourteen thousand five hundred saved')).toEqual([14500]);
    expect(v('$14,500 and 250k and one point three million')).toEqual([14500, 250000, 1300000]);
    expect(v('she is 68 years old and it takes 6 months at 5 percent')).toEqual([]);
  });
  it('parses dates relative to today', () => {
    expect(findDate('by October 2028', '2026-11-07')).toBe('2028-10-31');
    expect(findDate('the landlord will hold it until December first', '2026-11-07')).toBe('2026-12-01');
    expect(findDate('open by the end of September next year', '2026-11-07')).toBe('2027-09-30');
    expect(findDate('in 5 years', '2026-11-07')).toBe('2031-11-07');
    expect(findDate('nothing here', '2026-11-07')).toBe('');
  });
  it('parses what-if prompts into scenarios', () => {
    expect(parseScenarioPrompt('Can we afford a $32,000 car with 10% down at 6.5% APR over 5 years?')).toMatchObject({ kind: 'purchase', amount: 32000, down_payment: 3200, apr_pct: 6.5, term_months: 60, financed: true });
    expect(parseScenarioPrompt('What if Daniel loses his job for 6 months?')).toMatchObject({ kind: 'income_change', income_change_pct: -50, duration_months: 6 });
    expect(parseScenarioPrompt('Should we pay off the car loan?')).toMatchObject({ kind: 'payoff', account_hint: 'auto_loan' });
    expect(parseScenarioPrompt('What if interest rates go up 2 points?')).toMatchObject({ kind: 'rate_change', rate_delta_pct: 2 });
  });
  it('extracts goals with amounts, dates and evidence from a conversation', () => {
    const r = extractFromLines(
      [
        { speaker: 'Marisol', text: 'The contractor said about two hundred fifty thousand for the build-out of the second location. We want to open by the end of September next year.' },
        { speaker: 'Daniel', text: 'I am worried that we are too tight in January.' },
        { speaker: 'Marisol', text: 'We should set aside nine thousand for Abuela\'s medical costs by next June.' },
      ],
      '2026-11-07',
    );
    const biz = r.goals.find((g) => g.kind === 'business')!;
    expect(biz.target_amount).toBe(250000);
    expect(biz.target_date).toBe('2027-09-30');
    expect(biz.evidence_quote).toMatch(/two hundred fifty thousand/);
    expect(r.goals.find((g) => g.kind === 'care')?.target_amount).toBe(9000);
    expect(r.concerns.length).toBeGreaterThan(0);
  });
});
