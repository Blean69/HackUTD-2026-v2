// DEMO_MODE=cache_first: replay an earlier identical run (same workflow + normalized input) instead of calling the LLM.
// Replay re-emits the original trace events under the new run with timing compressed to <= 8 s, provider "cache",
// and re-applies the recorded results. New input always runs live.
import { sha1, sleep as realSleep, truncate, workflowLabel } from '../util.js';
import { applyEffects, type Effect, type RunContext } from './run.js';

export interface CachedTraceEvent {
  seq: number;
  tsMs: number;
  agent: string;
  type: string;
  title: string;
  dataJson: string;
  model: string;
  provider: string;
  latencyMs: number;
}

export interface CachedRun {
  runId: string;
  effects: Effect[];
  result: Record<string, unknown>;
}

/** Read access to finished runs (implemented over the SpacetimeDB client cache; a fake in tests). */
export interface RunHistory {
  /** `allowLocalOnly`: also accept runs that only the keyless local provider answered. */
  findCompletedRun(workflow: string, cacheKey: string, excludeRunId: string, allowLocalOnly: boolean): Promise<CachedRun | null>;
  traceEvents(runId: string): Promise<CachedTraceEvent[]>;
}

export const MAX_REPLAY_MS = 8000;

/** Stable fingerprint of a workflow input: lowercase, punctuation and whitespace collapsed. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$%.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bump when the agents' behavior changes (prompts, tools, guardrails): a replay is only valid for the code that recorded it,
 * so older recordings stop being replayed and the next identical question runs live (and is recorded again).
 */
export const CACHE_EPOCH = 'e2'; // e2: grounding checks, find_savings, kid tools, Table Mode guardrails (2026-11-08)

export function makeCacheKey(workflow: string, templateId: string, normalizedInput: string): string {
  return `${workflow}@${CACHE_EPOCH}:${templateId}:${sha1(normalizedInput).slice(0, 20)}`;
}

/** Scale original inter-event gaps so the whole replay fits in `maxMs`. Returns per-event delays in ms. */
export function compressDelays(tsMs: number[], maxMs = MAX_REPLAY_MS): number[] {
  if (tsMs.length === 0) return [];
  const gaps = tsMs.map((t, i) => (i === 0 ? 0 : Math.max(0, t - tsMs[i - 1]!)));
  const total = gaps.reduce((s, g) => s + g, 0);
  const scale = total > maxMs ? maxMs / total : 1;
  return gaps.map((g) => Math.floor(g * scale)); // floor, never round: rounding each gap up can push the sum past maxMs
}

export async function replayRun(
  run: RunContext,
  cached: CachedRun,
  events: CachedTraceEvent[],
  opts: { maxMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ replayed: number; totalMs: number }> {
  const sleep = opts.sleep ?? realSleep;
  const body = events.filter((e) => e.type !== 'run_started').sort((a, b) => a.seq - b.seq);
  const delays = compressDelays(body.map((e) => e.tsMs), opts.maxMs ?? MAX_REPLAY_MS);
  const totalMs = delays.reduce((s, d) => s + d, 0);
  run.last = { provider: 'cache', model: '' };
  run.emit(
    'planner',
    'message',
    `Cache hit: an identical ${workflowLabel(run.info.workflow)} run finished earlier. Replaying its ${body.length} steps (about ${Math.max(1, Math.round(totalMs / 1000))} s).`,
    { replayed_from: cached.runId, steps: body.length },
    { provider: 'cache', model: '' },
  );
  for (let i = 0; i < body.length; i++) {
    const e = body[i]!;
    if (delays[i]) await sleep(delays[i]!);
    let data: unknown = {};
    try {
      data = JSON.parse(e.dataJson);
    } catch {
      data = { raw: truncate(e.dataJson, 500) };
    }
    const wrapped = data && typeof data === 'object' && !Array.isArray(data) ? { ...(data as object), cached: true, replayed_from: cached.runId, original_provider: e.provider } : { value: data, cached: true, replayed_from: cached.runId, original_provider: e.provider };
    run.emit(e.agent, e.type as Parameters<RunContext['emit']>[1], e.title, wrapped, { provider: 'cache', model: e.model, latencyMs: e.latencyMs, tokensIn: 0, tokensOut: 0 });
  }
  applyEffects(run, cached.effects);
  return { replayed: body.length, totalMs };
}
