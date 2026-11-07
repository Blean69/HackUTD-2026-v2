// Keystone table definitions (docs/contracts.md section 2).
//
// Conventions
//  - Table and column names are snake_case here and in SQL. The generated TypeScript client bindings expose the same
//    columns as camelCase (household_id -> householdId) and tables as camelCase accessors (health_indicator ->
//    healthIndicator).
//  - Every household-scoped table has a btree index on household_id (subscribe with
//    `SELECT * FROM <table> WHERE household_id = '...'`).
//  - Everything the app needs to render is `public`. The private tables are `worker`, `module_config`,
//    `plaid_item`, `dirty_household` and `recompute_tick`. Row-level security is P1.
import { schema, table, t } from 'spacetimedb/server';

// --- seed / domain data -------------------------------------------------------------------------------------------

const household = table(
  { name: 'household', public: true },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    city: t.string(),
    state: t.string(),
    persona: t.string(),
    /** Estimated home / vehicle market value in USD (0 if renting / none). Counted in net worth. */
    home_value: t.f64(),
    vehicle_value: t.f64(),
    /** "" for seed templates; for sandboxes, the household they were copied from. */
    template_id: t.string(),
    /** Set for sandboxes (the identity that created them). */
    owner: t.option(t.identity()),
    created_at: t.timestamp(),
  },
);

const member = table(
  { name: 'member', public: true },
  {
    id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    name: t.string(),
    age: t.u32(),
    role: t.string(), // parent | child | grandparent | other
    income_annual: t.f64(),
  },
);

const account = table(
  { name: 'account', public: true },
  {
    id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    type: t.string(), // checking | savings | cd | ira | auto_loan | personal_loan | credit_card | mortgage
    institution: t.string(),
    nickname: t.string(),
    balance: t.f64(),
    rate_pct: t.option(t.f64()),
    credit_limit: t.option(t.f64()),
    monthly_payment: t.option(t.f64()),
    maturity_date: t.option(t.string()),
    opened_date: t.string(),
    owner_member_ids_json: t.string(),
    /** "seed" (data/seed) or "plaid" (Plaid Sandbox, written by the worker). Plaid ids are acct_plaid_<plaid account_id>. */
    source: t.string(),
  },
);

const txn = table(
  { name: 'txn', public: true },
  {
    id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    account_id: t.string().index('btree'),
    date: t.string(),
    amount: t.f64(), // negative = outflow
    merchant: t.string(),
    category: t.string(),
    description: t.string(),
    is_recurring: t.bool(),
    /** Ground truth for scoring ONLY ("" if none). No rule in this module ever reads it. */
    anomaly_truth: t.string(),
    /** "seed" or "plaid". Plaid ids are txn_plaid_<transaction_id>. */
    source: t.string(),
  },
);

const credit_profile = table(
  { name: 'credit_profile', public: true },
  {
    member_id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    score: t.u32(),
    utilization_pct: t.f64(),
    hard_inquiries_12m: t.u32(),
    oldest_account_years: t.f64(),
    late_payments_24m: t.u32(),
  },
);

const obligation = table(
  { name: 'obligation', public: true },
  {
    id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    name: t.string(),
    amount: t.f64(),
    due_day: t.u8(),
    account_id: t.string(),
    kind: t.string(), // bill | loan | subscription | tuition | insurance | tax
  },
);

const conversation = table(
  { name: 'conversation', public: true },
  {
    id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    title: t.string(),
    turns_json: t.string(),
    expected_goals_json: t.string(),
    scam_signals_json: t.string(),
  },
);

// --- computed in the database -------------------------------------------------------------------------------------

const health_indicator = table(
  { name: 'health_indicator', public: true },
  {
    id: t.string().primaryKey(), // `${household_id}:${key}`
    household_id: t.string().index('btree'),
    key: t.string(),
    label: t.string(),
    value: t.f64(),
    unit: t.string(),
    status: t.string(), // good | watch | risk
    explanation: t.string(),
    updated_at: t.timestamp(),
  },
);

const forecast_point = table(
  { name: 'forecast_point', public: true },
  {
    id: t.string().primaryKey(), // `${household_id}:${date}`
    household_id: t.string().index('btree'),
    date: t.string(),
    balance: t.f64(),
    obligations_due: t.f64(),
  },
);

const alert = table(
  { name: 'alert', public: true },
  {
    id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    severity: t.string(), // info | warn | critical
    kind: t.string(), // data_quality | fraud | scam | obligation | advisor | insight
    title: t.string(),
    detail: t.string(),
    related_ids_json: t.string(),
    created_at: t.timestamp(),
    acknowledged_by: t.string(), // "" if open
  },
);

// --- family-facing state ------------------------------------------------------------------------------------------

const goal = table(
  { name: 'goal', public: true },
  {
    id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    title: t.string(),
    target_amount: t.f64(),
    target_date: t.string(),
    priority: t.i32(), // 1 = most important
    feasibility: t.string(), // "" | on_track | stretch | off_track
    evidence_quote: t.string(),
    source: t.string(), // huddle | manual | coach | onboarding
    created_at: t.timestamp(),
    updated_at: t.timestamp(),
  },
);

const presence = table(
  { name: 'presence', public: true },
  {
    identity: t.identity().primaryKey(),
    household_id: t.string().index('btree'), // "" = lobby
    display_name: t.string(),
    role: t.string(), // family | advisor | guest
    last_seen: t.timestamp(),
  },
);

const huddle = table(
  { name: 'huddle', public: true },
  {
    id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    started_by_name: t.string(),
    status: t.string(), // live | analyzing | done
    started_at: t.timestamp(),
    ended_at: t.option(t.timestamp()),
    consent_names_json: t.string(),
  },
);

const transcript_line = table(
  { name: 'transcript_line', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    huddle_id: t.string().index('btree'),
    household_id: t.string().index('btree'),
    speaker: t.string(),
    text: t.string(),
    ts: t.timestamp(),
  },
);

const scenario = table(
  { name: 'scenario', public: true },
  {
    id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    prompt: t.string(),
    status: t.string(), // queued | running | done | error
    result_json: t.string(),
    requested_by_name: t.string(),
    created_at: t.timestamp(),
  },
);

const coach_message = table(
  { name: 'coach_message', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    household_id: t.string().index('btree'),
    role: t.string(), // user | assistant
    author_name: t.string(),
    text: t.string(),
    run_id: t.string(),
    created_at: t.timestamp(),
  },
);

const advisor_note = table(
  { name: 'advisor_note', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    household_id: t.string().index('btree'),
    author_name: t.string(),
    text: t.string(),
    created_at: t.timestamp(),
  },
);

// --- family voting (docs/contracts.md section 6) ------------------------------------------------------------------

const proposal = table(
  { name: 'proposal', public: true },
  {
    id: t.string().primaryKey(), // prop_...
    household_id: t.string().index('btree'),
    title: t.string(),
    amount: t.f64(), // USD
    details_json: t.string(), // free-form, e.g. {"down_pct":20,"term_months":60,"rate_pct":6.2}
    created_by_name: t.string(),
    created_at: t.timestamp(),
    closes_at: t.timestamp(),
    status: t.string(), // open | closed
    verdict: t.string(), // "" (not checked yet) | fine | tight | risky   (written by the worker)
    analysis_json: t.string(), // ScenarioResult-style {summary, metrics, suggestion, ...} (written by the worker)
    run_id: t.string(), // agent run that produced the verdict ("" until then)
  },
);

const vote = table(
  { name: 'vote', public: true },
  {
    id: t.string().primaryKey(), // `${proposal_id}:${voter_key}`
    proposal_id: t.string().index('btree'),
    household_id: t.string().index('btree'),
    voter_key: t.string(), // caller identity hex, or a member id for seeded votes
    voter_name: t.string(),
    choice: t.string(), // yes | no | abstain
    updated_at: t.timestamp(),
  },
);

// --- Plaid Sandbox (docs/contracts.md section 5) ------------------------------------------------------------------

/** What the UI shows about a linked bank. Safe for clients: no tokens. */
const bank_connection = table(
  { name: 'bank_connection', public: true },
  {
    item_id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    institution_name: t.string(),
    status: t.string(), // linking | selecting | syncing | ok | error
    accounts_count: t.u32(),
    txns_count: t.u32(),
    last_synced_at: t.option(t.timestamp()),
    error: t.string(), // "" when healthy
  },
);

// --- onboarding (docs/contracts.md section 7) ---------------------------------------------------------------------

const household_profile = table(
  { name: 'household_profile', public: true },
  {
    household_id: t.string().primaryKey(),
    onboarding_status: t.string(), // welcome | connect | selecting | questions | done
    answers_json: t.string(), // the raw answers last saved by save_onboarding_answers
    risk_comfort: t.u32(), // 1 (cautious) .. 5 (comfortable with risk)
    priorities_json: t.string(), // JSON array of priority keys, most important first
    voting_enabled: t.bool(),
    voice_consent: t.bool(),
    created_at: t.timestamp(),
    updated_at: t.timestamp(),
  },
);

/** One row per bank account Plaid offered during onboarding; `selected` decides what plaid_sync imports. Safe for clients: no tokens. */
const bank_account_option = table(
  { name: 'bank_account_option', public: true },
  {
    id: t.string().primaryKey(), // `${item_id}:${account_id}`
    household_id: t.string().index('btree'),
    item_id: t.string().index('btree'),
    account_id: t.string(), // the Plaid account id
    name: t.string(),
    official_name: t.string(),
    mask: t.string(),
    type: t.string(), // Plaid type: depository | credit | loan | investment | ...
    subtype: t.string(),
    balance: t.f64(), // current balance; for credit and loan accounts the amount owed
    selected: t.bool(),
  },
);

// --- agent job queue + glass box ----------------------------------------------------------------------------------

const agent_job = table(
  { name: 'agent_job', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    workflow: t.string(), // huddle | what_if | coach | scam_check | data_quality | plaid_sync | onboarding_insights
    household_id: t.string().index('btree'),
    subject_id: t.string(),
    input_json: t.string(),
    status: t.string().index('btree'), // queued | claimed | done | error
    claimed_by: t.option(t.identity()),
    run_id: t.string(),
    created_at: t.timestamp(),
  },
);

const agent_run = table(
  { name: 'agent_run', public: true },
  {
    run_id: t.string().primaryKey(),
    job_id: t.u64().index('btree'),
    workflow: t.string(),
    household_id: t.string().index('btree'),
    status: t.string(), // running | done | error
    started_at: t.timestamp(),
    finished_at: t.option(t.timestamp()),
    providers_json: t.string(),
    result_json: t.string(),
  },
);

const trace_event = table(
  { name: 'trace_event', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    run_id: t.string().index('btree'),
    household_id: t.string().index('btree'),
    seq: t.u32(),
    ts: t.timestamp(),
    workflow: t.string(),
    agent: t.string(),
    type: t.string(), // run_started | plan | thought | tool_call | tool_result | handoff | message | final | error
    title: t.string(),
    data_json: t.string(), // <= 4 KB (longer payloads are replaced by a truncation marker)
    model: t.string(),
    provider: t.string(), // nvidia | tenvor_nemotron | tenvor_qwen | cache | local
    latency_ms: t.u32(),
    tokens_in: t.u32(),
    tokens_out: t.u32(),
  },
);

// --- private -------------------------------------------------------------------------------------------------------

/** Identities allowed to call worker-only reducers. Added by `register_worker`. */
const worker = table(
  { name: 'worker' },
  {
    identity: t.identity().primaryKey(),
    label: t.string(),
    registered_at: t.timestamp(),
  },
);

/**
 * One private row (id 1): who published the module, and an optional override of the worker-secret hash.
 * `publisher` is recorded by `init` (ctx.sender of the publishing call). `worker_secret_hash` is "" until
 * `admin_set_worker_secret_hash` sets it; while "" `register_worker` falls back to the dev hash compiled into the module.
 */
const module_config = table(
  { name: 'module_config' },
  {
    id: t.u8().primaryKey(),
    publisher: t.option(t.identity()),
    worker_secret_hash: t.string(),
    updated_at: t.timestamp(),
  },
);

/**
 * Plaid access tokens. PRIVATE: clients cannot subscribe to this table. Registered workers read it through the
 * `worker_plaid_items` view (see reducers/plaid.ts), which returns no rows to anyone else.
 */
export const plaid_item = table(
  { name: 'plaid_item' },
  {
    item_id: t.string().primaryKey(),
    household_id: t.string().index('btree'),
    access_token: t.string(),
    institution_id: t.string(),
    institution_name: t.string(),
    cursor: t.string(), // /transactions/sync cursor ("" before the first sync)
    created_at: t.timestamp(),
  },
);

/** Households whose underlying rows changed since the last recompute (picked up by `tick_recompute`). */
const dirty_household = table(
  { name: 'dirty_household' },
  {
    household_id: t.string().primaryKey(),
    marked_at: t.timestamp(),
  },
);

/** Schedule table behind `tick_recompute` (one interval row, inserted by `init` / `client_connected`). */
export const recompute_tick = table(
  { name: 'recompute_tick' },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  },
);

const spacetimedb = schema({
  household,
  member,
  account,
  txn,
  credit_profile,
  obligation,
  conversation,
  health_indicator,
  forecast_point,
  alert,
  goal,
  presence,
  huddle,
  transcript_line,
  scenario,
  coach_message,
  advisor_note,
  proposal,
  vote,
  agent_job,
  agent_run,
  trace_event,
  bank_connection,
  household_profile,
  bank_account_option,
  plaid_item,
  worker,
  module_config,
  dirty_household,
  recompute_tick,
});

export default spacetimedb;
export { spacetimedb };
