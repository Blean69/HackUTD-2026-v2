// One registry of agent tools. Each tool = zod schema (-> JSON schema for the model) + a plain function returning small JSON.
import { z } from 'zod';
import type { ToolSpec } from '../llm/types.js';
import { toJsonSchema } from '../llm/structured.js';
import type { HouseholdData } from '../types.js';
import { fitJson } from '../util.js';
import type { ExternalApis } from './external.js';

export interface ToolContext {
  data: HouseholdData;
  external: ExternalApis;
  /** Writes a tool may make for the family. Only Brian's call session provides them; elsewhere write tools refuse. */
  act?: {
    addKidTask(member_id: string, title: string, reward: number): Promise<void>;
    depositKidJar(member_id: string, amount: number): Promise<void>;
    /** Two-step confirmation, enforced here rather than trusted to the prompt: propose(key) when the action is first asked
     *  for; confirmable(key) is true only for a key proposed earlier in this call, with time for a spoken yes in between. */
    propose(key: string): void;
    confirmable(key: string): boolean;
  };
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): unknown | Promise<unknown>;
  /** Human-readable one-liner for the tool_call trace title. */
  describe?(args: z.infer<S>): string;
  /** Human-readable one-liner for the tool_result trace title. */
  summarize?(result: any, args: z.infer<S>): string;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export type ToolOutcome =
  | { ok: true; result: unknown; summary: string; durationMs: number }
  | { ok: false; error: string; summary: string; durationMs: number };

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(...defs: ToolDef<any>[]): this {
    for (const d of defs) {
      if (this.tools.has(d.name)) throw new Error(`duplicate tool ${d.name}`);
      this.tools.set(d.name, d);
    }
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }
  names(): string[] {
    return [...this.tools.keys()];
  }

  specs(names?: string[]): ToolSpec[] {
    return [...this.tools.values()]
      .filter((t) => !names || names.includes(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: toJsonSchema(t.schema) }));
  }

  describeCall(name: string, rawArgs: unknown): string {
    const t = this.tools.get(name);
    const parsed = t?.schema.safeParse(rawArgs ?? {});
    if (t?.describe && parsed?.success) return t.describe(parsed.data);
    return `${name}(${formatArgs(rawArgs)})`;
  }

  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const t0 = Date.now();
    const t = this.tools.get(name);
    if (!t) return { ok: false, error: `unknown tool "${name}"`, summary: `Unknown tool ${name}`, durationMs: 0 };
    const parsed = t.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const error = `invalid arguments for ${name}: ${z.prettifyError(parsed.error).slice(0, 400)}`;
      return { ok: false, error, summary: `${name} rejected its arguments`, durationMs: Date.now() - t0 };
    }
    try {
      const result = await t.run(parsed.data, ctx);
      let summary = `${name} returned`;
      try {
        summary = t.summarize ? t.summarize(result, parsed.data) : `${name} returned ${fitJson(result, 80)}`;
      } catch {
        /* keep default */
      }
      return { ok: true, result, summary, durationMs: Date.now() - t0 };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { ok: false, error, summary: `${name} failed: ${error.slice(0, 120)}`, durationMs: Date.now() - t0 };
    }
  }
}

export function formatArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : fitJson(v, 40)}`)
    .join(', ');
}
