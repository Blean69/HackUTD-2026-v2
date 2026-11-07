// OpenAI-compatible provider (NVIDIA API Catalog, tenvor.io vLLM). One class, three configs.
import OpenAI from 'openai';
import type { ProviderConfig } from '../config.js';
import { LLMError, type ChatMessage, type ChatRequest, type ChatResult, type LLMProvider, type ToolCall } from './types.js';

export interface OpenAIProviderOptions {
  timeoutMs: number;
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

/** Build the request body. Exported for tests (the reasoning toggle must reach the wire). */
export function buildBody(cfg: ProviderConfig, model: string, req: ChatRequest): Record<string, unknown> {
  const thinking = req.thinking === true;
  const kwargs: Record<string, unknown> = { enable_thinking: thinking };
  if (thinking && /nemotron-3-super/i.test(model)) kwargs.low_effort = true;
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
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const c = req.toolChoice ?? 'auto';
    body.tool_choice = typeof c === 'string' ? c : { type: 'function', function: { name: c.name } };
  }
  return body;
}

const THINK_RE = /<think>([\s\S]*?)<\/think>/gi;

export class OpenAICompatProvider implements LLMProvider {
  readonly id: ProviderConfig['id'];
  private client: OpenAI;

  constructor(
    private cfg: ProviderConfig,
    opts: OpenAIProviderOptions,
  ) {
    this.id = cfg.id;
    this.client = new OpenAI({
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey || 'not-needed',
      maxRetries: 0, // failover and backoff live in LLMClient
      timeout: opts.timeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  modelFor(role: 'agent' | 'fast'): string {
    return role === 'fast' ? this.cfg.fastModel : this.cfg.agentModel;
  }

  async call(req: ChatRequest): Promise<ChatResult> {
    const model = this.modelFor(req.role);
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
