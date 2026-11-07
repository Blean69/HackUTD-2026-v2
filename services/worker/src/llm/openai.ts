// OpenAI-compatible provider (NVIDIA API Catalog, tenvor.io vLLM). One class, three configs.
import OpenAI from 'openai';
import type { ProviderConfig } from '../config.js';
import { LLMError, type ChatMessage, type ChatRequest, type ChatResult, type LLMProvider, type ToolCall } from './types.js';

export interface OpenAIProviderOptions {
  timeoutMs: number;
  /** Models to try when the configured one answers 404 for this key (nvidia only). Default: see DEFAULT_NVIDIA_AGENT_FALLBACKS. */
  fallbackModels?: string[];
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'assistant':
        return m.tool_calls?.length
          ? {
              role: 'assistant',
              content: m.content || null,
              tool_calls: m.tool_calls.map((t) => ({
                id: t.id,
                type: 'function',
                function: { name: t.name, arguments: t.arguments },
              })),
            }
          : { role: 'assistant', content: m.content };
      case 'tool':
        return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      default:
        return { role: m.role, content: m.content };
    }
  });
}

const UNSUPPORTED_SCHEMA_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'multipleOf'] as const;

/**
 * tenvor.io (Qwen on vLLM) answers HTTP 400 "The tool schema could not be used" when a tool schema carries numeric/length
 * constraints (minimum, maximum, maxLength ...). The NVIDIA API accepts them. For other providers the constraints are moved into the
 * description (so the model still sees them); zod re-validates every answer anyway. Exported for tests.
 */
export function portableSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(portableSchema);
  if (!node || typeof node !== 'object') return node;
  const o = node as Record<string, unknown>;
  const hints: string[] = [];
  if (typeof o.minimum === 'number' || typeof o.maximum === 'number') hints.push(`${typeof o.minimum === 'number' ? `min ${o.minimum}` : ''}${typeof o.minimum === 'number' && typeof o.maximum === 'number' ? ', ' : ''}${typeof o.maximum === 'number' ? `max ${o.maximum}` : ''}`);
  if (typeof o.maxLength === 'number') hints.push(`max ${o.maxLength} characters`);
  if (typeof o.maxItems === 'number') hints.push(`at most ${o.maxItems} items`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if ((UNSUPPORTED_SCHEMA_KEYS as readonly string[]).includes(k)) continue;
    // a property literally named like a keyword (e.g. "format") lives under "properties", whose values are schemas
    out[k] = k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, portableSchema(pv)])) : portableSchema(v);
  }
  if (hints.length) out.description = `${typeof o.description === 'string' ? `${o.description} ` : ''}(${hints.join('; ')})`;
  return out;
}

/** Build the request body. Exported for tests (the reasoning toggle must reach the wire). */
export function buildBody(cfg: ProviderConfig, model: string, req: ChatRequest): Record<string, unknown> {
  // Qwen on tenvor.io is the slow fallback (~37 tokens/s: one reasoning-enabled plan took 38 s), so it answers without reasoning
  // unless TENVOR_THINKING=1. NVIDIA models keep the per-request toggle.
  const thinking = req.thinking === true && (cfg.id === 'nvidia' || cfg.id === 'brev' || process.env.TENVOR_THINKING === '1');
  const kwargs: Record<string, unknown> = { enable_thinking: thinking };
  if (thinking && /nemotron-3-super/i.test(model)) kwargs.low_effort = true;
  // Ultra card: effort knob is medium_effort, and tool calls + reasoning need force_nonempty_content
  if (thinking && /nemotron-3-ultra/i.test(model)) {
    kwargs.medium_effort = true;
    if (req.tools?.length) kwargs.force_nonempty_content = true;
  }
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(req.messages),
    temperature: req.temperature ?? 1.0,
    top_p: req.topP ?? 0.95,
    max_tokens: req.maxTokens ?? (thinking ? 4096 : 2048),
    chat_template_kwargs: kwargs,
  };
  if (thinking && cfg.id === 'nvidia') body.reasoning_budget = 1024;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: cfg.id === 'nvidia' ? t.parameters : portableSchema(t.parameters) },
    }));
    const c = req.toolChoice ?? 'auto';
    body.tool_choice = typeof c === 'string' ? c : { type: 'function', function: { name: c.name } };
  }
  return body;
}

const THINK_RE = /<think>([\s\S]*?)<\/think>/gi;

/**
 * Some NVIDIA accounts get HTTP 404 ("Function ... Not found for account") for models the public /v1/models list still
 * shows (observed 2026-11-07 for nemotron-3-super-120b-a12b). When the configured model 404s we remember that for a while and
 * answer with the next Nemotron on this list, so the agent role never silently depends on one model id. The trace
 * always records the model that really answered, and run.chat adds a message when the switch happens.
 * Override with NEMOTRON_MODEL_FALLBACKS="id1,id2" (agent role); the fast role falls back to the agent models.
 */
export const DEFAULT_NVIDIA_AGENT_FALLBACKS = ['nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3.5-lightning-30b-a3b'];
const MODEL_DOWN_MS = 15 * 60_000;

function envFallbacks(): string[] {
  const raw = process.env.NEMOTRON_MODEL_FALLBACKS;
  if (raw === undefined) return DEFAULT_NVIDIA_AGENT_FALLBACKS;
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
}

export class OpenAICompatProvider implements LLMProvider {
  readonly id: ProviderConfig['id'];
  private client: OpenAI;
  /** Models this key cannot use (HTTP 404), with the time they may be tried again. */
  private modelDownUntil = new Map<string, number>();
  private fallbackModels: string[];

  constructor(
    private cfg: ProviderConfig,
    opts: OpenAIProviderOptions,
  ) {
    this.id = cfg.id;
    this.fallbackModels = cfg.id === 'nvidia' ? (opts.fallbackModels ?? envFallbacks()) : [];
    this.client = new OpenAI({
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey || 'not-needed',
      maxRetries: 0, // failover and backoff live in LLMClient
      timeout: opts.timeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  private configured(role: 'agent' | 'fast'): string {
    return role === 'fast' ? this.cfg.fastModel : this.cfg.agentModel;
  }

  /** Configured model first, then the fallbacks; models that recently answered 404 go last (retried when nothing else is left). */
  private candidates(role: 'agent' | 'fast'): string[] {
    const all = [...new Set([this.configured(role), ...this.fallbackModels])];
    const t = Date.now();
    const up = all.filter((m) => (this.modelDownUntil.get(m) ?? 0) <= t);
    return up.length ? up : all;
  }

  /** The model that would answer right now (skips models known to 404 for this key). */
  modelFor(role: 'agent' | 'fast'): string {
    return this.candidates(role)[0]!;
  }

  async call(req: ChatRequest): Promise<ChatResult> {
    const models = this.candidates(req.role);
    const switched: { from: string; to: string; reason: string }[] = [];
    let lastErr: LLMError | undefined;
    for (const [i, model] of models.entries()) {
      try {
        const res = await this.callModel(model, req);
        if (switched.length) res.modelSwitch = switched;
        return res;
      } catch (e) {
        const err = toLLMError(e);
        const hasNext = i < models.length - 1;
        if (err.status === 404 && hasNext) {
          this.modelDownUntil.set(model, Date.now() + MODEL_DOWN_MS);
          switched.push({ from: model, to: models[i + 1]!, reason: 'HTTP 404: model not available for this API key' });
          lastErr = err;
          continue;
        }
        if (err.status === 404) this.modelDownUntil.set(model, Date.now() + MODEL_DOWN_MS);
        throw err;
      }
    }
    throw lastErr ?? new LLMError('no model configured');
  }

  private async callModel(model: string, req: ChatRequest): Promise<ChatResult> {
    const body = buildBody(this.cfg, model, req);
    const t0 = Date.now();
    let res: OpenAI.Chat.Completions.ChatCompletion;
    try {
      // chat_template_kwargs / reasoning_budget are NIM/vLLM extensions the SDK types do not know about.
      res = await this.client.chat.completions.create(body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    } catch (e) {
      throw toLLMError(e);
    }
    const msg = res.choices?.[0]?.message as
      | (OpenAI.Chat.Completions.ChatCompletionMessage & { reasoning_content?: string | null; reasoning?: string | null })
      | undefined;
    if (!msg) throw new LLMError('empty response (no choices)', undefined, undefined, true);

    let content = msg.content ?? '';
    let reasoning = (msg.reasoning_content ?? msg.reasoning ?? '') || '';
    // Some servers inline <think> blocks instead of using reasoning_content.
    content = content.replace(THINK_RE, (_m, inner: string) => {
      reasoning = reasoning ? reasoning : inner.trim();
      return '';
    });
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).flatMap((t, i) =>
      t.type === 'function'
        ? [{ id: t.id || `call_${i}`, name: t.function.name, arguments: t.function.arguments || '{}' }]
        : [],
    );
    return {
      content: content.trim(),
      ...(reasoning ? { reasoning: reasoning.trim() } : {}),
      toolCalls,
      provider: this.id,
      model: res.model || model,
      latencyMs: Date.now() - t0,
      tokensIn: res.usage?.prompt_tokens ?? 0,
      tokensOut: res.usage?.completion_tokens ?? 0,
    };
  }
}

export function toLLMError(e: unknown): LLMError {
  if (e instanceof LLMError) return e;
  const err = e as { status?: number; message?: string; name?: string; headers?: Headers | Record<string, string> };
  const status = typeof err.status === 'number' ? err.status : undefined;
  let retryAfterMs: number | undefined;
  const h = err.headers;
  const ra = h ? (typeof (h as Headers).get === 'function' ? (h as Headers).get('retry-after') : (h as Record<string, string>)['retry-after']) : null;
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) retryAfterMs = Math.min(30_000, Math.max(0, secs * 1000));
  }
  const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
  const name = err.name ?? '';
  const msg = `${name && name !== 'Error' ? `${name}: ` : ''}${err.message ?? String(e)}`;
  return new LLMError(status ? `HTTP ${status}: ${err.message ?? ''}`.trim() : msg, status, retryAfterMs, retryable);
}
