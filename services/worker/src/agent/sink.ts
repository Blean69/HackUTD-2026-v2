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
  feasibility: '' | 'on_track' | 'stretch' | 'off_track' | 'needs_details' | 'not_advised';
  evidence_quote: string;
  source: 'huddle' | 'manual' | 'coach' | 'onboarding';
}

export interface AlertInput {
  id: string;
  household_id: string;
  severity: 'info' | 'warn' | 'critical';
  kind: 'data_quality' | 'fraud' | 'scam' | 'obligation' | 'advisor' | 'insight';
  title: string;
  detail: string;
  related_ids: string[];
}

export interface ProposalInput {
  household_id: string;
  title: string;
  amount: number;
  details: Record<string, unknown>;
  closes_in_days: number;
  author_name: string;
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
  /** The client reducer create_proposal, called as the worker: opens a Family-voting proposal (its affordability check is queued by the module). */
  createProposal(p: ProposalInput): Promise<void>;
  /** Family voting: attach the affordability verdict ('' | fine | tight | risky) and analysis to a proposal. */
  updateProposal(proposalId: string, verdict: string, analysisJson: string, runId: string): Promise<void>;
  /** Kids and teens, called as the worker when a parent asks Brian: the client reducers add_kid_task and deposit_kid_jar. */
  addKidTask(t: { household_id: string; member_id: string; title: string; reward: number; author_name: string }): Promise<void>;
  depositKidJar(d: { household_id: string; member_id: string; amount: number }): Promise<void>;
  /** More of what a family member does by hand, called as the worker when a caller asks Brian and says yes (tools/goals.ts, family.ts, studio.ts, kids.ts). */
  deleteGoal(goalId: string): Promise<void>; // client reducer delete_goal
  ackAlert(alertId: string, displayName: string): Promise<void>; // client reducer ack_alert ("Mark handled")
  approveKidTask(taskId: string): Promise<void>; // client reducer approve_kid_task (pays the chore's reward into the jar once)
  setKidGoal(g: { household_id: string; member_id: string; title: string; target: number }): Promise<void>; // client reducer set_kid_goal
  /** Saves a what-if to the What-If Studio: the worker-only twin of request_simulation (scenario row + queued what_if job), named for Brian. */
  requestSimulation(r: { household_id: string; prompt: string; requested_by_name: string }): Promise<void>;
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
  createProposal = (p: ProposalInput) => this.rec('createProposal', p);
  updateProposal = (id: string, verdict: string, analysisJson: string, runId: string) => this.rec('updateProposal', id, verdict, analysisJson, runId);
  addKidTask = (t: { household_id: string; member_id: string; title: string; reward: number; author_name: string }) => this.rec('addKidTask', t);
  depositKidJar = (d: { household_id: string; member_id: string; amount: number }) => this.rec('depositKidJar', d);
  deleteGoal = (id: string) => this.rec('deleteGoal', id);
  ackAlert = (id: string, name: string) => this.rec('ackAlert', id, name);
  approveKidTask = (id: string) => this.rec('approveKidTask', id);
  setKidGoal = (g: { household_id: string; member_id: string; title: string; target: number }) => this.rec('setKidGoal', g);
  requestSimulation = (r: { household_id: string; prompt: string; requested_by_name: string }) => this.rec('requestSimulation', r);
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
