import type { RunContext } from '../agent/run.js';
import type { Line } from '../llm/rules.js';

export interface JobInfo {
  id: bigint;
  workflow: string;
  householdId: string;
  subjectId: string;
  input: Record<string, unknown>;
}

/** Things workflows need that are not tools: raw rows that never become part of HouseholdData. */
export interface WorkflowEnv {
  transcript(huddleId: string): Promise<Line[]>;
}

export interface WorkflowDef {
  name: string;
  /** Normalized-input fingerprint for DEMO_MODE=cache_first, or null when this run must always be live. */
  cacheKey?(run: RunContext, job: JobInfo, env: WorkflowEnv): Promise<string | null>;
  run(run: RunContext, job: JobInfo, env: WorkflowEnv): Promise<Record<string, unknown>>;
  /** Leave the DB in a sensible state when the run failed (scenario error, huddle done, ...). */
  onError?(run: RunContext, job: JobInfo, err: Error): void;
}
