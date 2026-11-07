// WorkerSink = everything the worker writes back to SpacetimeDB (the worker-only reducers). The real implementation
// is db/sink.ts; MemorySink records calls for tests.
export type TraceType = 'run_started' | 'plan' | 'thought' | 'tool_call' | 'tool_result' | 'handoff' | 'message' | 'final' | 'error';

export interface TraceInput {
  runId: string;
  seq: number;
  workflow: string;
  agent: string;
  type: TraceType;
  title: string;
  dataJson: string;
  model: string;
  provider: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

export interface GoalInput {
  id: string;
  household_id: string;
  title: string;
  target_amount: number;
  target_date: string;
  priority: number;
  feasibility: '' | 'on_track' | 'stretch' | 'off_track';
  evidence_quote: string;
  source: 'huddle' | 'manual' | 'coach';
}

export interface AlertInput {
  id: string;
  household_id: string;
  severity: 'info' | 'warn' | 'critical';
  kind: 'data_quality' | 'fraud' | 'scam' | 'obligation' | 'advisor';
  title: string;
  detail: string;
  related_ids: string[];
}

export interface WorkerSink {
  /** queued -> claimed. Rejects when another worker got there first. */
  claimJob(jobId: bigint): Promise<void>;
  startRun(runId: string, jobId: bigint): Promise<void>;
  emitTrace(e: TraceInput): Promise<void>;
  upsertGoal(g: GoalInput): Promise<void>;
  createAlert(a: AlertInput): Promise<void>;
  updateScenario(id: string, status: 'queued' | 'running' | 'done' | 'error', resultJson: string): Promise<void>;
  coachReply(householdId: string, text: string, runId: string): Promise<void>;
  setHuddleStatus(huddleId: string, status: 'live' | 'analyzing' | 'done'): Promise<void>;
  purgeTranscript(huddleId: string): Promise<void>;
  finishRun(runId: string, status: 'done' | 'error', providersJson: string, resultJson: string): Promise<void>;
}

export type SinkCall = { fn: keyof WorkerSink; args: unknown[] };

export class MemorySink implements WorkerSink {
  calls: SinkCall[] = [];
  private rec(fn: keyof WorkerSink, ...args: unknown[]): Promise<void> {
    this.calls.push({ fn, args });
    return Promise.resolve();
  }
  claimJob = (jobId: bigint) => this.rec('claimJob', jobId);
  startRun = (runId: string, jobId: bigint) => this.rec('startRun', runId, jobId);
  emitTrace = (e: TraceInput) => this.rec('emitTrace', e);
  upsertGoal = (g: GoalInput) => this.rec('upsertGoal', g);
  createAlert = (a: AlertInput) => this.rec('createAlert', a);
  updateScenario = (id: string, status: string, resultJson: string) => this.rec('updateScenario', id, status, resultJson);
  coachReply = (h: string, text: string, runId: string) => this.rec('coachReply', h, text, runId);
  setHuddleStatus = (id: string, status: string) => this.rec('setHuddleStatus', id, status);
  purgeTranscript = (id: string) => this.rec('purgeTranscript', id);
  finishRun = (runId: string, status: string, p: string, r: string) => this.rec('finishRun', runId, status, p, r);

  of<K extends keyof WorkerSink>(fn: K): unknown[][] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }
  get traces(): TraceInput[] {
    return this.of('emitTrace').map((a) => a[0] as TraceInput);
  }
}
