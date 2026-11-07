// Structured output via a forced tool call (works on the hosted API and on vLLM), validated with zod, retried once.
// If a remote model still returns garbage the local provider produces the structure (visible as provider=local).
import { z } from 'zod';
import { extractJson } from '../util.js';
import type { LLMLike } from './client.js';
import type { ChatMessage, ChatRequest, ChatResult } from './types.js';

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

export interface StructuredOptions<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  messages: ChatMessage[];
  role?: 'agent' | 'fast';
  task: string;
  local?: unknown;
  maxTokens?: number;
}

export interface StructuredResult<T> {
  value: T;
  /** Provenance of the call that produced `value`; latency and tokens are summed over all attempts. */
  meta: Pick<ChatResult, 'provider' | 'model' | 'latencyMs' | 'tokensIn' | 'tokensOut'> & { attempts: number; reasoning?: string };
}

export class StructuredOutputError extends Error {}

export async function structured<S extends z.ZodType>(llm: LLMLike, opts: StructuredOptions<S>): Promise<StructuredResult<z.infer<S>>> {
  const parameters = toJsonSchema(opts.schema);
  let messages = opts.messages;
  let latency = 0;
  let tin = 0;
  let tout = 0;
  let lastError = '';

  const attempt = async (only?: ChatRequest['only']): Promise<{ ok: true; value: z.infer<S>; res: ChatResult } | { ok: false; error: string }> => {
    const req: ChatRequest = {
      role: opts.role ?? 'fast',
      messages,
      tools: [{ name: opts.name, description: opts.description, parameters }],
      toolChoice: { name: opts.name },
      thinking: false,
      temperature: 0.2,
      maxTokens: opts.maxTokens ?? 2048,
      task: opts.task,
      local: opts.local,
      ...(only ? { only } : {}),
    };
    const res = await llm.chat(req);
    latency += res.latencyMs;
    tin += res.tokensIn;
    tout += res.tokensOut;
    let raw: unknown;
    try {
      const call = res.toolCalls.find((c) => c.name === opts.name) ?? res.toolCalls[0];
      raw = call ? extractJson(call.arguments) : extractJson(res.content);
    } catch (e) {
      return { ok: false, error: `could not parse JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    const parsed = opts.schema.safeParse(raw);
    if (parsed.success) return { ok: true, value: parsed.data, res };
    return { ok: false, error: z.prettifyError(parsed.error).slice(0, 600) };
  };

  for (let i = 0; i < 2; i++) {
    const r = await attempt();
    if (r.ok) return done(r.value, r.res, i + 1);
    lastError = r.error;
    messages = [
      ...opts.messages,
      { role: 'user', content: `Your previous answer failed validation:\n${r.error}\nCall ${opts.name} again with arguments that satisfy the schema exactly.` },
    ];
  }
  if (llm.hasProvider('local')) {
    const r = await attempt(['local']);
    if (r.ok) return done(r.value, r.res, 3);
    lastError = r.error;
  }
  throw new StructuredOutputError(`structured output "${opts.name}" failed validation: ${lastError}`);

  function done(value: z.infer<S>, res: ChatResult, attempts: number): StructuredResult<z.infer<S>> {
    return {
      value,
      meta: {
        provider: res.provider,
        model: res.model,
        latencyMs: latency,
        tokensIn: tin,
        tokensOut: tout,
        attempts,
        ...(res.reasoning ? { reasoning: res.reasoning } : {}),
      },
    };
  }
}
