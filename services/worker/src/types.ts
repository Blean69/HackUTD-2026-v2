// Plain-data domain types the tools and workflows work with. They are filled from the SpacetimeDB client cache
// (see db/household.ts) or from fixtures in tests. `anomaly_truth` is deliberately NOT part of Txn: the loader drops it,
// so no detector can read ground truth.

export interface Member {
  id: string;
  household_id: string;
  name: string;
  age: number;
  role: string;
  income_annual: number;
}

export interface Account {
  id: string;
  household_id: string;
  type: string; // checking | savings | cd | ira | auto_loan | personal_loan | credit_card | mortgage
  institution: string;
  nickname: string;
  balance: number; // deposits: money held; debts: amount owed (positive)
  rate_pct?: number;
  credit_limit?: number;
  monthly_payment?: number;
  maturity_date?: string;
  opened_date: string;
  owner_member_ids: string[];
}

export interface Txn {
  id: string;
  household_id: string;
  account_id: string;
  date: string;
  amount: number; // negative = outflow
  merchant: string;
  category: string;
  description: string;
  is_recurring: boolean;
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
  kind: string;
}

export interface HealthIndicator {
  key: string;
  label: string;
  value: number;
  unit: string;
  status: string;
  explanation: string;
}

export interface ForecastPoint {
  date: string;
  balance: number;
  obligations_due: number;
}

export interface GoalRow {
  id: string;
  title: string;
  target_amount: number;
  target_date: string;
  priority: number;
  feasibility: string;
  /** Kept so an edit through `agent_upsert_goal` does not blank them. Optional: absent in fixtures. */
  evidence_quote?: string;
  source?: string;
}

/** An alert as Brian reads it (`alert` table). `acknowledged_by` is "" while it is open. */
export interface AlertItem {
  id: string;
  severity: string; // info | warn | critical
  kind: string;
  title: string;
  detail: string;
  acknowledged_by: string;
  created_at: string;
}

/** A Family-voting proposal and its tally (`proposal` + `vote` tables). */
export interface ProposalItem {
  id: string;
  title: string;
  amount: number;
  status: string; // open | closed
  verdict: string; // "" | fine | tight | risky
  closes_at: string;
  created_by_name: string;
  created_at: string;
  /** The proposal's details_json (loan terms such as rate_pct, term_months, down_pct). Optional: absent in fixtures. */
  details?: Record<string, unknown>;
}

/**
 * The household's monthly cash flow as the recompute stores it (`cash_flow`, docs/contracts.md section 14): the same figures the
 * dashboard's Cash flow tile and the savings-rate indicator show. Every agent-facing "monthly surplus / cash flow" reads this.
 */
export interface CashFlowRow {
  as_of: string;
  window_days: number;
  income_monthly: number;
  expense_monthly: number;
  net_monthly: number;
  savings_rate: number;
  /** Spending per category over the whole window (not per month). */
  categories: { category: string; total: number }[];
}
export interface VoteItem {
  proposal_id: string;
  choice: string; // yes | no | abstain
}

/** One line of a member's simulated credit score breakdown (the module's `credit_score.factors_json`). */
export interface CreditFactorRow {
  key: string;
  label: string;
  /** 0..1, higher is better. */
  value: number;
  weight: number;
  /** Points this factor adds on the 300..850 scale. */
  points: number;
  max_points: number;
  /** One plain-English line. */
  explanation: string;
}

/** A member's simulated credit score (docs/contracts.md section 9). Only members with a score appear. */
export interface CreditScoreRow {
  member_id: string;
  score: number;
  band: string;
  factors: CreditFactorRow[];
}

/** One dated point of a member's score history (daily recompute plus the monthly backfill). */
export interface KidTaskRow {
  id: string;
  member_id: string;
  title: string;
  reward: number;
  status: string; // open | done | approved
}
export interface KidJarRow {
  member_id: string;
  balance: number;
  earned_total: number;
  goal_title: string;
  goal_target: number;
}

export interface CreditHistoryRow {
  member_id: string;
  date: string;
  score: number;
}

export interface HouseholdInfo {
  id: string;
  name: string;
  city: string;
  state: string;
  persona: string;
  template_id: string;
  /** Estimated property values, when the household record has them. */
  home_value?: number;
  vehicle_value?: number;
}

export interface HouseholdData {
  household: HouseholdInfo;
  members: Member[];
  accounts: Account[];
  txns: Txn[];
  credit: CreditProfile[];
  obligations: Obligation[];
  health: HealthIndicator[];
  forecast: ForecastPoint[];
  goals: GoalRow[];
  /** The last Ask chat turns (coach_message), oldest first. Optional: absent in fixtures. Untrusted text: only ever shown to a model inside <data>. */
  chat?: { role: string; author: string; text: string; created_at: string }[];
  /** Simulated credit scores per member and their history. Optional: absent in fixtures and before the module computed any. */
  credit_scores?: CreditScoreRow[];
  credit_history?: CreditHistoryRow[];
  /** Kids and teens (contracts.md section 12): chores and allowance jars. Optional like the credit rows. */
  kid_tasks?: KidTaskRow[];
  kid_jars?: KidJarRow[];
  /** Alerts and Family-voting proposals with their votes, for Brian's read tools. Optional like the rows above. */
  alerts?: AlertItem[];
  proposals?: ProposalItem[];
  votes?: VoteItem[];
  /** The recompute's cash-flow row. Optional: absent in fixtures and before the module computed one; tools then derive it from the ledger. */
  cash_flow?: CashFlowRow;
  /** "Today" for this household's data (YYYY-MM-DD). */
  asOf: string;
}

export interface TranscriptLine {
  speaker: string;
  text: string;
}
