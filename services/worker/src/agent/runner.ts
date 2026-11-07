// runJob: claim -> start_run -> (cache replay | live workflow) -> finish_run, with every step traced.
import type { LLMLike } from '../llm/client.js';
import type { ExternalApis } from '../tools/external.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { HouseholdData } from '../types.js';
import { truncate } from '../util.js';
import { getWorkflow } from '../workflows/index.js';
import type { JobInfo, WorkflowEnv } from '../workflows/types.js';
import { replayRun, type RunHistory } from './cache.js';
import { RunContext } from './run.js';
import type { WorkerSink } from './sink.js';

export interface RunnerDeps {
  sink: WorkerSink;
  llm: LLMLike;
  registry: ToolRegistry;
  external: ExternalApis;
  loadData(householdId: string): Promise<HouseholdData>;
  env: WorkflowEnv;
  history: RunHistory;
  demoMode: 'cache_first' | 'live';
  /** Replay runs that only the local rule-based provider produced (true for keyless workers). */
  allowLocalCache?: boolean;
  maxAgentSteps?: number;
  agentThinking?: boolean;
  /** Provider/model a new request would try first (resolved when the run starts, so cooling-down providers are skipped). */
  primary: { provider: string; model: string } | (() => { provider: string; model: string });
  sleep?: (ms: number) => Promise<void>;
  maxReplayMs?: number;
}

export interface RunOutcome {
  runId: string;
  status: 'done' | 'error';
  replayed: boolean;
  error?: string;
}

const rand = (): string => Math.random().toString(36).slice(2, 6);

export async function runJob(job: JobInfo, deps: RunnerDeps): Promise<RunOutcome> {
  const runId = `run_${job.id}_${rand()}`;
  await deps.sink.startRun(runId, job.id);

  let run: RunContext | undefined;
  let cacheKey: string | null = null;
  try {
    const data = await deps.loadData(job.householdId);
    run = new RunContext(
      { runId, workflow: job.workflow, householdId: job.householdId, subjectId: job.subjectId },
      {
        sink: deps.sink,
        llm: deps.llm,
        registry: deps.registry,
        toolContext: { data, external: deps.external },
        primary: typeof deps.primary === 'function' ? deps.primary() : deps.primary,
        ...(deps.maxAgentSteps !== undefined ? { maxAgentSteps: deps.maxAgentSteps } : {}),
        ...(deps.agentThinking !== undefined ? { agentThinking: deps.agentThinking } : {}),
      },
    );
    run.emit('planner', 'run_started', `Started ${job.workflow.replace('_', ' ')} run for ${data.household.name}`, { job_id: job.id.toString(), workflow: job.workflow, subject_id: job.subjectId, household_id: job.householdId, demo_mode: deps.demoMode, template_id: data.household.template_id || data.household.id });

    const def = getWorkflow(job.workflow);
    if (!def) throw new Error(`no workflow registered for "${job.workflow}"`);

    try {
      cacheKey = (await def.cacheKey?.(run, job, deps.env)) ?? null;
    } catch {
      cacheKey = null;
    }

    if (deps.demoMode === 'cache_first' && cacheKey) {
      const cached = await deps.history.findCompletedRun(job.workflow, cacheKey, runId, deps.allowLocalCache ?? true);
      if (cached) {
        const events = await deps.history.traceEvents(cached.runId);
        if (events.length > 2) {
          const r = await replayRun(run, cached, events, { ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.maxReplayMs ? { maxMs: deps.maxReplayMs } : {}) });
          await run.drain();
          await deps.sink.finishRun(runId, 'done', JSON.stringify([{ provider: 'cache', model: '', calls: r.replayed, tokens_in: 0, tokens_out: 0 }]), JSON.stringify({ ...cached.result, cache_key: cacheKey, replayed_from: cached.runId, effects: cached.effects }));
          return { runId, status: 'done', replayed: true };
        }
      }
    }

    const result = await def.run(run, job, deps.env);
    const errs = await run.drain();
    await deps.sink.finishRun(runId, 'done', run.providersJson(), JSON.stringify({ ...result, ...(cacheKey ? { cache_key: cacheKey } : {}), effects: run.effects, ...(errs.length ? { sink_errors: errs.slice(0, 5) } : {}) }));
    return { runId, status: 'done', replayed: false };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`[run ${runId}] ${job.workflow} failed:`, err.message);
    if (run) {
      run.emit('planner', 'error', `Run failed: ${truncate(err.message, 200)}`, { error: err.message });
      try {
        getWorkflow(job.workflow)?.onError?.(run, job, err);
      } catch {
        /* best effort */
      }
      await run.drain();
    }
    await deps.sink.finishRun(runId, 'error', run?.providersJson() ?? '[]', JSON.stringify({ error: err.message })).catch(() => undefined);
    return { runId, status: 'error', replayed: false, error: err.message };
  }
}
