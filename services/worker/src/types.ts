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
  /** Simulated credit scores per member and their history. Optional: absent in fixtures and before the module computed any. */
  credit_scores?: CreditScoreRow[];
  credit_history?: CreditHistoryRow[];
  /** "Today" for this household's data (YYYY-MM-DD). */
  asOf: string;
}

export interface TranscriptLine {
  speaker: string;
  text: string;
}
