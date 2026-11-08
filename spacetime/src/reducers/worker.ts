// Worker-only reducers. Every one except register_worker rejects callers that are not in the `worker` table.
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { effectiveWorkerHash, sameHex } from '../config';
import { sha256Hex } from '../sha256';
import { cleanText, enqueueJob, fail, newId, requireHousehold, WORKFLOWS, type Ctx } from '../util';

const ALERT_SEVERITIES = ['info', 'warn', 'critical'];
const ALERT_KINDS = ['data_quality', 'fraud', 'scam', 'obligation', 'advisor', 'insight', 'credit'];
// needs_details: no amount was said, so there is nothing to check yet; not_advised: gambling or speculation (Table Mode guardrail)
const FEASIBILITIES = ['', 'on_track', 'stretch', 'off_track', 'needs_details', 'not_advised'];
const GOAL_SOURCES = ['huddle', 'manual', 'coach', 'onboarding'];
const SCENARIO_STATUSES = ['queued', 'running', 'done', 'error'];
const PROPOSAL_VERDICTS = ['', 'fine', 'tight', 'risky'];
const HUDDLE_STATUSES = ['live', 'analyzing', 'done'];
const MAX_TRACE_DATA = 4096;

function requireWorker(ctx: Ctx): void {
  if (!ctx.db.worker.identity.find(ctx.sender)) fail('worker only');
}
function oneOf(value: string, allowed: string[], field: string): string {
  if (!allowed.includes(value)) fail(`${field} must be one of: ${allowed.map((a) => a || '""').join(', ')}`);
  return value;
}

/**
 * Add the caller to `worker` if sha256(secret) matches the worker-secret hash: the private `module_config` override set by
 * `admin_set_worker_secret_hash` when there is one, otherwise the DEV hash (`keystone-dev-secret`, src/config.ts).
 * Production never edits source: infra/deploy.sh sets the override right after publishing.
 */
export const register_worker = spacetimedb.reducer(
  { secret: t.string(), label: t.string() },
  (ctx, { secret, label }) => {
    if (!sameHex(sha256Hex(secret), effectiveWorkerHash(ctx))) fail('invalid worker secret');
    const row = { identity: ctx.sender, label: cleanText(label, 'label', 60, true) || 'worker', registered_at: ctx.timestamp };
    if (ctx.db.worker.identity.find(ctx.sender)) ctx.db.worker.identity.update(row);
    else ctx.db.worker.insert(row);
    ctx.db.presence.identity.delete(ctx.sender); // the worker is not a person in the lobby
  },
);

/**
 * Queue a job on behalf of the worker. A live phone call (workflow `phone`) is not started by any client reducer: the voice
 * service asks the worker, which enqueues the job here and then claims it itself (start_run needs a claimed job). The
 * worker's JobQueue ignores `phone` jobs because no WorkflowDef is registered for it, so the call session owns the run.
 */
export const agent_enqueue_job = spacetimedb.reducer(
  { workflow: t.string(), household_id: t.string(), subject_id: t.string(), input_json: t.string() },
  (ctx, { workflow, household_id, subject_id, input_json }) => {
    requireWorker(ctx);
    oneOf(workflow, [...WORKFLOWS], 'workflow');
    requireHousehold(ctx, household_id);
    const subject = cleanText(subject_id, 'subject_id', 120, true);
    const text = input_json.trim() === '' ? '{}' : input_json;
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return fail('input_json must be valid JSON');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('input_json must be a JSON object');
    if (text.length > 8192) fail('input_json is too long (max 8192 characters)');
    for (const j of ctx.db.agent_job.household_id.filter(household_id)) {
      if (j.workflow === workflow && j.subject_id === subject && subject !== '' && j.status === 'queued') fail(`a ${workflow} job for "${subject}" is already queued`);
    }
    enqueueJob(ctx, workflow as (typeof WORKFLOWS)[number], household_id, subject, input);
  },
);

/** queued -> claimed, atomically. A second claimer gets an error. */
export const claim_job = spacetimedb.reducer({ job_id: t.u64() }, (ctx, { job_id }) => {
  requireWorker(ctx);
  const job = ctx.db.agent_job.id.find(job_id);
  if (!job) fail(`unknown job ${job_id}`);
  if (job.status !== 'queued') fail(`job ${job_id} is already ${job.status}`);
  ctx.db.agent_job.id.update({ ...job, status: 'claimed', claimed_by: ctx.sender });
});

/**
 * Called by a worker once at startup. Any job still claimed by this worker's identity was in flight when it stopped (a deploy
 * restarts it mid-run), so nothing will ever finish it: its unfinished run is closed as an error and the job goes back to
 * queued, to run again instead of leaving "Checking your accounts" on screen forever. A phone job is closed, not re-queued:
 * that call is gone.
 */
export const release_my_claims = spacetimedb.reducer({}, (ctx) => {
  requireWorker(ctx);
  for (const job of [...ctx.db.agent_job.status.filter('claimed')]) {
    if (!job.claimed_by || !job.claimed_by.isEqual(ctx.sender)) continue;
    const run = job.run_id ? ctx.db.agent_run.run_id.find(job.run_id) : undefined;
    if (run && run.status === 'running') {
      ctx.db.agent_run.run_id.update({ ...run, status: 'error', finished_at: ctx.timestamp, result_json: JSON.stringify({ error: 'the worker restarted mid-run; the job was queued again' }) });
    }
    if (job.workflow === 'phone') ctx.db.agent_job.id.update({ ...job, status: 'error' });
    else ctx.db.agent_job.id.update({ ...job, status: 'queued', claimed_by: undefined, run_id: '' });
  }
});

export const start_run = spacetimedb.reducer(
  { run_id: t.string(), job_id: t.u64() },
  (ctx, { run_id, job_id }) => {
    requireWorker(ctx);
    const job = ctx.db.agent_job.id.find(job_id);
    if (!job) fail(`unknown job ${job_id}`);
    if (job.status !== 'claimed') fail(`job ${job_id} must be claimed before start_run (is ${job.status})`);
    const id = cleanText(run_id, 'run_id', 80);
    if (ctx.db.agent_run.run_id.find(id)) fail(`run ${id} already exists`);
    ctx.db.agent_run.insert({
      run_id: id,
      job_id,
      workflow: job.workflow,
      household_id: job.household_id,
      status: 'running',
      started_at: ctx.timestamp,
      finished_at: undefined,
      providers_json: '[]',
      result_json: '',
    });
    ctx.db.agent_job.id.update({ ...job, run_id: id });
  },
);

export const finish_run = spacetimedb.reducer(
  { run_id: t.string(), status: t.string(), providers_json: t.string(), result_json: t.string() },
  (ctx, { run_id, status, providers_json, result_json }) => {
    requireWorker(ctx);
    oneOf(status, ['done', 'error'], 'status');
    const run = ctx.db.agent_run.run_id.find(run_id);
    if (!run) fail(`unknown run ${run_id}`);
    ctx.db.agent_run.run_id.update({ ...run, status, finished_at: ctx.timestamp, providers_json, result_json });
    const job = ctx.db.agent_job.id.find(run.job_id);
    if (job) ctx.db.agent_job.id.update({ ...job, status });
  },
);

export const emit_trace = spacetimedb.reducer(
  {
    run_id: t.string(),
    seq: t.u32(),
    workflow: t.string(),
    agent: t.string(),
    type: t.string(),
    title: t.string(),
    data_json: t.string(),
    model: t.string(),
    provider: t.string(),
    latency_ms: t.u32(),
    tokens_in: t.u32(),
    tokens_out: t.u32(),
  },
  (ctx, a) => {
    requireWorker(ctx);
    const run = ctx.db.agent_run.run_id.find(a.run_id);
    if (!run) fail(`unknown run ${a.run_id} (call start_run first)`);
    // Payloads over 4 KB would bloat every subscriber; keep a valid-JSON marker plus a preview instead.
    const data_json =
      a.data_json.length <= MAX_TRACE_DATA
        ? a.data_json
        : JSON.stringify({ truncated: true, original_length: a.data_json.length, preview: a.data_json.slice(0, 3500) });
    ctx.db.trace_event.insert({
      id: 0n,
      run_id: a.run_id,
      household_id: run.household_id,
      seq: a.seq,
      ts: ctx.timestamp,
      workflow: a.workflow,
      agent: a.agent,
      type: a.type,
      title: a.title.slice(0, 300),
      data_json,
      model: a.model,
      provider: a.provider,
      latency_ms: a.latency_ms,
      tokens_in: a.tokens_in,
      tokens_out: a.tokens_out,
    });
  },
);

/** Create or update a goal with the agent-owned fields. id "" creates a new goal. */
export const agent_upsert_goal = spacetimedb.reducer(
  {
    id: t.string(),
    household_id: t.string(),
    title: t.string(),
    target_amount: t.f64(),
    target_date: t.string(),
    priority: t.i32(),
    feasibility: t.string(),
    evidence_quote: t.string(),
    source: t.string(),
  },
  (ctx, a) => {
    requireWorker(ctx);
    requireHousehold(ctx, a.household_id);
    oneOf(a.feasibility, FEASIBILITIES, 'feasibility');
    oneOf(a.source, GOAL_SOURCES, 'source');
    const base = {
      household_id: a.household_id,
      title: cleanText(a.title, 'title', 140),
      target_amount: Number.isFinite(a.target_amount) ? a.target_amount : 0,
      target_date: cleanText(a.target_date, 'target_date', 32, true),
      priority: a.priority,
      feasibility: a.feasibility,
      evidence_quote: cleanText(a.evidence_quote, 'evidence_quote', 300, true),
      source: a.source,
    };
    const prev = a.id ? ctx.db.goal.id.find(a.id) : null;
    if (prev) {
      ctx.db.goal.id.update({ ...prev, ...base, updated_at: ctx.timestamp });
      return;
    }
    const id = a.id || newId(ctx, 'goal_', (x) => !!ctx.db.goal.id.find(x));
    ctx.db.goal.insert({ id, ...base, created_at: ctx.timestamp, updated_at: ctx.timestamp });
  },
);

/** Create or replace an alert. A stable id makes re-runs idempotent. Ids starting with "rule:" are reserved. */
export const agent_create_alert = spacetimedb.reducer(
  {
    id: t.string(),
    household_id: t.string(),
    severity: t.string(),
    kind: t.string(),
    title: t.string(),
    detail: t.string(),
    related_ids_json: t.string(),
  },
  (ctx, a) => {
    requireWorker(ctx);
    requireHousehold(ctx, a.household_id);
    oneOf(a.severity, ALERT_SEVERITIES, 'severity');
    oneOf(a.kind, ALERT_KINDS, 'kind');
    if (a.id.startsWith('rule:')) fail('alert ids starting with "rule:" are reserved for recompute_household');
    const row = {
      household_id: a.household_id,
      severity: a.severity,
      kind: a.kind,
      title: cleanText(a.title, 'title', 200),
      detail: cleanText(a.detail, 'detail', 2000, true),
      related_ids_json: a.related_ids_json || '[]',
    };
    const prev = a.id ? ctx.db.alert.id.find(a.id) : null;
    if (prev) {
      ctx.db.alert.id.update({ ...prev, ...row });
      return;
    }
    const id = a.id || newId(ctx, 'alt_', (x) => !!ctx.db.alert.id.find(x));
    ctx.db.alert.insert({ id, ...row, created_at: ctx.timestamp, acknowledged_by: '' });
  },
);

/**
 * request_simulation on the worker's behalf (Brian saves a what-if to the What-If Studio after a spoken yes). Same rows as the
 * client reducer: a `scenario` plus a queued `what_if` job. The only difference is the name the Studio shows, because the worker
 * has no presence row and `request_simulation` would label it "Someone".
 */
export const agent_request_simulation = spacetimedb.reducer(
  { household_id: t.string(), prompt: t.string(), requested_by_name: t.string() },
  (ctx, { household_id, prompt, requested_by_name }) => {
    requireWorker(ctx);
    requireHousehold(ctx, household_id);
    const text = cleanText(prompt, 'prompt', 1000);
    const who = cleanText(requested_by_name, 'requested_by_name', 40, true) || 'Brian (AI)';
    const id = newId(ctx, 'scn_', (x) => !!ctx.db.scenario.id.find(x));
    ctx.db.scenario.insert({ id, household_id, prompt: text, status: 'queued', result_json: '', requested_by_name: who, created_at: ctx.timestamp });
    enqueueJob(ctx, 'what_if', household_id, id, { scenario_id: id, prompt: text, requested_by: who });
  },
);

export const agent_update_scenario = spacetimedb.reducer(
  { id: t.string(), status: t.string(), result_json: t.string() },
  (ctx, { id, status, result_json }) => {
    requireWorker(ctx);
    oneOf(status, SCENARIO_STATUSES, 'status');
    const s = ctx.db.scenario.id.find(id);
    if (!s) fail(`unknown scenario "${id}"`);
    ctx.db.scenario.id.update({ ...s, status, result_json });
  },
);

/** Attach the affordability check to a proposal (verdict + ScenarioResult-style analysis). Allowed after the vote closed. */
export const agent_update_proposal = spacetimedb.reducer(
  { proposal_id: t.string(), verdict: t.string(), analysis_json: t.string(), run_id: t.string() },
  (ctx, { proposal_id, verdict, analysis_json, run_id }) => {
    requireWorker(ctx);
    oneOf(verdict, PROPOSAL_VERDICTS, 'verdict');
    const p = ctx.db.proposal.id.find(proposal_id);
    if (!p) fail(`unknown proposal "${proposal_id}"`);
    if (analysis_json !== '') {
      try {
        JSON.parse(analysis_json);
      } catch {
        fail('analysis_json must be valid JSON');
      }
    }
    ctx.db.proposal.id.update({ ...p, verdict, analysis_json, run_id: cleanText(run_id, 'run_id', 80, true) });
  },
);

export const agent_coach_reply = spacetimedb.reducer(
  { household_id: t.string(), text: t.string(), run_id: t.string() },
  (ctx, { household_id, text, run_id }) => {
    requireWorker(ctx);
    requireHousehold(ctx, household_id);
    ctx.db.coach_message.insert({
      id: 0n,
      household_id,
      role: 'assistant',
      author_name: 'Coach',
      text: cleanText(text, 'text', 8000),
      run_id,
      created_at: ctx.timestamp,
    });
  },
);

export const set_huddle_status = spacetimedb.reducer(
  { huddle_id: t.string(), status: t.string() },
  (ctx, { huddle_id, status }) => {
    requireWorker(ctx);
    oneOf(status, HUDDLE_STATUSES, 'status');
    const h = ctx.db.huddle.id.find(huddle_id);
    if (!h) fail(`unknown huddle "${huddle_id}"`);
    ctx.db.huddle.id.update({ ...h, status, ended_at: h.ended_at ?? (status === 'live' ? undefined : ctx.timestamp) });
  },
);

/** Privacy: delete a huddle's raw transcript once the goals and evidence quotes have been extracted. */
export const purge_transcript = spacetimedb.reducer({ huddle_id: t.string() }, (ctx, { huddle_id }) => {
  requireWorker(ctx);
  const n = ctx.db.transcript_line.huddle_id.delete(huddle_id);
  console.info(`purge_transcript: removed ${n} line(s) for ${huddle_id}`);
});
