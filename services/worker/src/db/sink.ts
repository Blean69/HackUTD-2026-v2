import type { AlertInput, GoalInput, ProposalInput, TraceInput, WorkerSink } from '../agent/sink.js';
import type { DbConnection } from '../module_bindings/index.js';

/** The real WorkerSink: every method is one worker-only reducer call. */
export class SpacetimeSink implements WorkerSink {
  constructor(private conn: DbConnection) {}

  claimJob(jobId: bigint): Promise<void> {
    return this.conn.reducers.claimJob({ jobId });
  }
  startRun(runId: string, jobId: bigint): Promise<void> {
    return this.conn.reducers.startRun({ runId, jobId });
  }
  emitTrace(e: TraceInput): Promise<void> {
    return this.conn.reducers.emitTrace({
      runId: e.runId,
      seq: e.seq,
      workflow: e.workflow,
      agent: e.agent,
      type: e.type,
      title: e.title,
      dataJson: e.dataJson,
      model: e.model,
      provider: e.provider,
      latencyMs: e.latencyMs,
      tokensIn: e.tokensIn,
      tokensOut: e.tokensOut,
    });
  }
  upsertGoal(g: GoalInput): Promise<void> {
    return this.conn.reducers.agentUpsertGoal({
      id: g.id,
      householdId: g.household_id,
      title: g.title,
      targetAmount: g.target_amount,
      targetDate: g.target_date,
      priority: g.priority,
      feasibility: g.feasibility,
      evidenceQuote: g.evidence_quote,
      source: g.source,
    });
  }
  createAlert(a: AlertInput): Promise<void> {
    return this.conn.reducers.agentCreateAlert({
      id: a.id,
      householdId: a.household_id,
      severity: a.severity,
      kind: a.kind,
      title: a.title,
      detail: a.detail,
      relatedIdsJson: JSON.stringify(a.related_ids),
    });
  }
  updateScenario(id: string, status: string, resultJson: string): Promise<void> {
    return this.conn.reducers.agentUpdateScenario({ id, status, resultJson });
  }
  coachReply(householdId: string, text: string, runId: string): Promise<void> {
    return this.conn.reducers.agentCoachReply({ householdId, text, runId });
  }
  createProposal(p: ProposalInput): Promise<void> {
    return this.conn.reducers.createProposal({ householdId: p.household_id, title: p.title, amount: p.amount, detailsJson: JSON.stringify(p.details), closesInDays: p.closes_in_days, authorName: p.author_name });
  }
  updateProposal(proposalId: string, verdict: string, analysisJson: string, runId: string): Promise<void> {
    return this.conn.reducers.agentUpdateProposal({ proposalId, verdict, analysisJson, runId });
  }
  setHuddleStatus(huddleId: string, status: string): Promise<void> {
    return this.conn.reducers.setHuddleStatus({ huddleId, status });
  }
  purgeTranscript(huddleId: string): Promise<void> {
    return this.conn.reducers.purgeTranscript({ huddleId });
  }
  finishRun(runId: string, status: string, providersJson: string, resultJson: string): Promise<void> {
    return this.conn.reducers.finishRun({ runId, status, providersJson, resultJson });
  }
}
