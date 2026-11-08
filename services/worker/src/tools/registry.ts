// One registry of agent tools. Each tool = zod schema (-> JSON schema for the model) + a plain function returning small JSON.
import { z } from 'zod';
import type { GoalInput } from '../agent/sink.js';
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
    approveKidTask(task_id: string): Promise<void>;
    setKidGoal(member_id: string, title: string, target: number): Promise<void>;
    /** Goals page: create or edit (agent_upsert_goal, with the feasibility the tool just worked out) and delete. */
    saveGoal(g: Omit<GoalInput, 'household_id'>): Promise<void>;
    deleteGoal(goal_id: string): Promise<void>;
    /** What-If Studio: a scenario row plus the queued what_if job, shown under Brian's name. */
    saveWhatIf(prompt: string): Promise<void>;
    /** Family voting: an open proposal (its affordability check is queued by the module). Voting itself stays in the app. */
    createProposal(p: { title: string; amount: number; details: Record<string, unknown>; closes_in_days: number }): Promise<void>;
    /** Alerts: "Mark handled". */
    markAlertHandled(alert_id: string): Promise<void>;
    /** Two-step confirmation, enforced here rather than trusted to the prompt: propose(key) when the action is first asked
     *  for; confirmable(key) is true only for a key proposed earlier in this call, with time for a spoken yes in between. */
    propose(key: string): void;
    confirmable(key: string): boolean;
    /** The yes for `key` is used up once its write succeeded, so the same call twice cannot write twice. Optional for fakes in tests. */
    consume?(key: string): void;
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
  | { ok: true; result: unknown; summary: string; durationMs: number; /** Arguments that were out of range and were fixed up (see parseToolArgs). */ adjusted?: string[] }
  | { ok: false; error: string; summary: string; durationMs: number };

type Path = readonly PropertyKey[];
const getAt = (v: unknown, path: Path): unknown => path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<PropertyKey, unknown>)[k] : undefined), v);
function setAt(root: unknown, path: Path, value: unknown): boolean {
  if (!path.length) return false;
  const parent = getAt(root, path.slice(0, -1));
  if (!parent || typeof parent !== 'object') return false;
  (parent as Record<PropertyKey, unknown>)[path[path.length - 1]!] = value;
  return true;
}

/**
 * Parse a model's tool arguments, fixing what a model commonly gets slightly wrong instead of failing the whole call:
 * an out-of-range number is clamped to the schema's bound ("limit: 100" with max 40 becomes 40), a number sent as a string
 * becomes a number, a float where an integer is required is rounded, and a too-long string or list is cut to the maximum.
 * Anything else (a missing required field, a wrong enum value) still fails with the schema's message.
 */
export function parseToolArgs<S extends z.ZodType>(schema: S, raw: unknown): { success: true; data: z.infer<S>; adjusted: string[] } | { success: false; error: z.ZodError } {
  let value: unknown = raw ?? {};
  try {
    value = structuredClone(value);
  } catch {
    /* parse as is */
  }
  const adjusted: string[] = [];
  for (let attempt = 0; ; attempt++) {
    const r = schema.safeParse(value);
    if (r.success) return { success: true, data: r.data, adjusted };
    if (attempt >= 4) return { success: false, error: r.error };
    let changed = false;
    for (const issue of r.error.issues as unknown as { code: string; origin?: string; expected?: string; maximum?: number | bigint; minimum?: number | bigint; inclusive?: boolean; path: Path }[]) {
      const cur = getAt(value, issue.path);
      let next: unknown = undefined;
      if ((issue.code === 'too_big' || issue.code === 'too_small') && cur !== undefined) {
        const big = issue.code === 'too_big';
        const bound = Number(big ? issue.maximum : issue.minimum);
        if (!Number.isFinite(bound)) continue;
        if (issue.origin === 'number' && typeof cur === 'number') {
          const step = issue.inclusive === false ? (Number.isInteger(cur) && Number.isInteger(bound) ? 1 : 0.01) : 0;
          next = big ? bound - step : bound + step;
        } else if (big && issue.origin === 'string' && typeof cur === 'string') next = cur.slice(0, bound);
        else if (big && issue.origin === 'array' && Array.isArray(cur)) next = cur.slice(0, bound);
      } else if (issue.code === 'invalid_type') {
        if ((issue.expected === 'number' || issue.expected === 'int') && typeof cur === 'string' && cur.trim() !== '' && Number.isFinite(Number(cur.replace(/[$,]/g, '')))) next = Number(cur.replace(/[$,]/g, ''));
        else if (issue.expected === 'int' && typeof cur === 'number' && Number.isFinite(cur)) next = Math.round(cur);
        else if (issue.expected === 'boolean' && (cur === 'true' || cur === 'false')) next = cur === 'true';
      }
      if (next !== undefined && next !== cur && setAt(value, issue.path, next)) {
        adjusted.push(`${issue.path.map(String).join('.')}: ${JSON.stringify(cur).slice(0, 40)} -> ${JSON.stringify(next).slice(0, 40)}`);
        changed = true;
      }
    }
    if (!changed) return { success: false, error: r.error };
  }
}

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
    const parsed = t ? parseToolArgs(t.schema, rawArgs) : undefined;
    if (t?.describe && parsed?.success) {
      try {
        return t.describe(parsed.data);
      } catch {
        /* fall through */
      }
    }
    return `${name.replace(/_/g, ' ')}${formatArgs(rawArgs) ? ` (${formatArgs(rawArgs)})` : ''}`;
  }

  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const t0 = Date.now();
    const t = this.tools.get(name);
    if (!t) return { ok: false, error: `unknown tool "${name}"`, summary: `Unknown tool ${name}`, durationMs: 0 };
    const parsed = parseToolArgs(t.schema, rawArgs);
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
      return { ok: true, result, summary, durationMs: Date.now() - t0, ...(parsed.adjusted.length ? { adjusted: parsed.adjusted } : {}) };
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
