import type { ProviderId } from '../config.js';

export type { ProviderId };

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string, exactly as the model produced it. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export type ToolChoice = 'auto' | 'none' | { name: string };

export interface ChatRequest {
  /** 'agent' = planning + tool use (NEMOTRON_MODEL); 'fast' = extraction/classification (NEMOTRON_FAST_MODEL). */
  role: 'agent' | 'fast';
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  /** Nemotron reasoning toggle (chat_template_kwargs.enable_thinking). Default false. */
  thinking?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /**
   * Identifies the step for the keyless `local` provider (e.g. "huddle.extract", "coach.step"). Remote providers
   * ignore it. `local` carries the structured facts the rule-based provider needs.
   */
  task?: string;
  local?: unknown;
  /** Restrict to these providers (e.g. force `local` after repeated validation failures). */
  only?: ProviderId[];
}

export interface ChatResult {
  content: string;
  /** Model reasoning trace (message.reasoning_content), when the provider returned one. */
  reasoning?: string;
  toolCalls: ToolCall[];
  provider: ProviderId;
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Models of the same provider that were skipped (HTTP 404 for this key) before `model` answered. */
  modelSwitch?: { from: string; to: string; reason: string }[];
  /** Providers that failed before this one answered (for the trace). */
  failovers?: { provider: ProviderId; error: string }[];
}

export interface LLMProvider {
  id: ProviderId;
  /** Model that would answer for this role (for logging / health). */
  modelFor(role: 'agent' | 'fast'): string;
  call(req: ChatRequest): Promise<ChatResult>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
