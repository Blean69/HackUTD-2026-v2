/**
 * UI-facing row types for every SpacetimeDB table in docs/contracts.md.
 *
 * These are the shapes held in the client store (lib/data/store.ts) and returned by the hooks in lib/data/.
 * They mirror the table columns (snake_case) with two normalisations that the data adapter performs once, at ingest:
 *   - `*_json` string columns are parsed and exposed under the bare name (`data_json` -> `data`,
 *     `turns_json` -> `turns`, `consent_names_json` -> `consent_names`, ...).
 *   - SpacetimeDB `Timestamp`s become ISO-8601 strings. `u64` ids become numbers (or strings, both are fine).
 *
 * The generated bindings in lib/module_bindings/ are the source of truth for the DB; this file is the source of
 * truth for what React components consume.
 */

// ---------------------------------------------------------------- household side

export type MemberRole = "parent" | "child" | "grandparent" | "other";

export interface Household {
  id: string;
  name: string;
  city: string;
  state: string;
  persona: string;
  /** "" = seed template, otherwise the household this sandbox was copied from. */
  template_id: string;
  owner?: string;
  /** Estimated home / vehicle value; counted in net worth. 0 or absent when unknown. */
  home_value?: number;
  vehicle_value?: number;
  created_at: string;
}

export interface Member {
  id: string;
  household_id: string;
  name: string;
  age: number;
  role: MemberRole;
  income_annual: number;
}

export type AccountType =
  | "checking"
  | "savings"
  | "cd"
  | "ira"
  | "auto_loan"
  | "personal_loan"
  | "credit_card"
  | "mortgage";

export interface Account {
  id: string;
  household_id: string;
  type: AccountType;
  institution: string;
  nickname: string;
  balance: number;
  rate_pct?: number;
  credit_limit?: number;
  monthly_payment?: number;
  maturity_date?: string;
  opened_date: string;
  owner_member_ids: string[];
  /** "plaid" for rows written by the plaid_sync workflow (ids acct_plaid_...). Defaults to "seed". */
  source?: "seed" | "plaid";
}

export type AnomalyLabel =
  | "duplicate"
  | "garbled"
  | "impossible_value"
  | "card_testing"
  | "account_takeover"
  | "scam_payment"
  | "outlier";

export interface Transaction {
  id: string;
  household_id: string;
  account_id: string;
  date: string;
  amount: number;
  merchant: string;
  category: string;
  description: string;
  is_recurring: boolean;
  source?: "seed" | "plaid";
  /** Ground truth for evals. Never render this. */
  anomaly_truth?: AnomalyLabel | "";
}

export interface CreditProfile {
  member_id: string;
  household_id: string;
  score: number;
  utilization_pct: number;
  hard_inquiries_12m: number;
  oldest_account_years: number;
  late_payments_24m: number;
}

export interface Obligation {
  id: string;
  household_id: string;
  name: string;
  amount: number;
  due_day: number;
  account_id: string;
  kind: "bill" | "loan" | "subscription" | "tuition" | "insurance" | "tax";
}

export interface Conversation {
  id: string;
  household_id: string;
  title: string;
  turns: { speaker: string; text: string }[];
  expected_goals: Partial<Goal>[];
  scam_signals: string[];
}

// ---------------------------------------------------------------- computed in the DB

export type HealthKey =
  | "liquidity_runway"
  | "debt_to_income"
  | "credit_utilization"
  | "savings_rate"
  | "net_worth_trend"
  | "emergency_fund"
  | "forecast_low_point"
  | "credit_score";
export type HealthStatus = "good" | "watch" | "risk";

export interface HealthIndicator {
  id: string; // `${household_id}:${key}`
  household_id: string;
  key: HealthKey;
  label: string;
  value: number;
  unit: "months" | "pct" | "usd" | "score";
  status: HealthStatus;
  explanation: string;
  updated_at: string;
}

export interface ForecastPoint {
  id: string; // `${household_id}:${date}`
  household_id: string;
  date: string;
  balance: number;
  obligations_due: number;
}

export type AlertSeverity = "info" | "warn" | "critical";
export type AlertKind = "data_quality" | "fraud" | "scam" | "obligation" | "advisor";

export interface Alert {
  id: string;
  household_id: string;
  severity: AlertSeverity;
  kind: AlertKind;
  title: string;
  detail: string;
  related_ids: string[];
  created_at: string;
  /** "" when still open. */
  acknowledged_by: string;
}

export type GoalPriority = "high" | "medium" | "low";
export type Feasibility = "" | "on_track" | "stretch" | "off_track";

export interface Goal {
  id: string;
  household_id: string;
  title: string;
  target_amount?: number;
  target_date?: string;
  priority: GoalPriority;
  feasibility: Feasibility;
  evidence_quote?: string;
  source: "huddle" | "manual" | "coach";
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------- multiplayer

export type PresenceRole = "family" | "advisor" | "guest";

export interface Presence {
  identity: string;
  /** "" = lobby */
  household_id: string;
  display_name: string;
  role: PresenceRole;
  last_seen: string;
}

export type HuddleStatus = "live" | "analyzing" | "done";

export interface Huddle {
  id: string;
  household_id: string;
  started_by_name: string;
  status: HuddleStatus;
  started_at: string;
  ended_at?: string;
  consent_names: string[];
}

export interface TranscriptLine {
  id: number;
  huddle_id: string;
  household_id: string;
  speaker: string;
  text: string;
  ts: string;
}

/**
 * What the what_if worker writes into `scenario.result_json`. The contract leaves the shape open, so this is the
 * shape the UI renders; every field is optional and the UI degrades to `summary` (or a raw key/value dump).
 */
export interface ScenarioResult {
  summary?: string;
  verdict?: "fine" | "tight" | "risky";
  metrics?: { label: string; before?: number; after: number; unit: "usd" | "months" | "pct" }[];
  /** Baseline vs scenario daily balance, for the overlay chart. */
  series?: { date: string; baseline: number; scenario: number; obligations_due?: number }[];
  low_point?: { date: string; balance: number };
  suggestion?: string;
}

export interface Scenario {
  id: string;
  household_id: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error";
  result?: ScenarioResult;
  requested_by_name: string;
  created_at: string;
}

export interface CoachMessage {
  id: number;
  household_id: string;
  role: "user" | "assistant";
  author_name: string;
  text: string;
  /** Set on assistant messages: the agent run (trace) that produced it. */
  run_id: string;
  created_at: string;
}

export interface AdvisorNote {
  id: number;
  household_id: string;
  author_name: string;
  text: string;
  created_at: string;
}

/** `bank_connection`: what the UI shows about a Plaid item (the access token is private and never reaches clients). */
export interface BankConnection {
  item_id: string;
  household_id: string;
  institution_name: string;
  status: "linking" | "syncing" | "ok" | "error";
  accounts_count: number;
  txns_count: number;
  last_synced_at?: string;
  error?: string;
}

// ---------------------------------------------------------------- agent runs + trace (NVIDIA story)

export type Workflow = "huddle" | "what_if" | "coach" | "scam_check" | "data_quality" | "plaid_sync";
export type TraceType =
  | "run_started"
  | "plan"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "handoff"
  | "message"
  | "final"
  | "error";
export type Provider = "nvidia" | "brev" | "tenvor_nemotron" | "tenvor_qwen" | "cache" | "local";

export interface TraceEvent {
  id: number;
  run_id: string;
  household_id: string;
  seq: number;
  ts: string;
  workflow: Workflow;
  agent: string;
  type: TraceType;
  title: string;
  data?: unknown;
  model?: string;
  provider?: Provider;
  latency_ms?: number;
  tokens?: { in: number; out: number };
}

export interface AgentRun {
  run_id: string;
  job_id: string | number;
  workflow: Workflow;
  household_id: string;
  status: "running" | "done" | "error";
  started_at: string;
  finished_at?: string;
  providers: string[];
  result?: unknown;
}

export const WORKFLOWS: Workflow[] = ["huddle", "what_if", "coach", "scam_check", "data_quality", "plaid_sync"];

export const WORKFLOW_LABEL: Record<Workflow, string> = {
  huddle: "Huddle",
  what_if: "What-if",
  coach: "Coach",
  scam_check: "Scam check",
  data_quality: "Data quality",
  plaid_sync: "Bank sync",
};
