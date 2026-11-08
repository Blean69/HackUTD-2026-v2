/**
 * Row mappers: generated SpacetimeDB binding rows (camelCase, option types, bigint ids, Timestamps, *Json strings)
 * to the UI row types in lib/types.ts. The only place that knows both shapes.
 */
import { parseFactors } from "@/lib/credit-factors";
import type * as B from "@/lib/module_bindings/types";
import type {
  Account, AdvisorNote, AgentRun, Alert, AlertKind, AlertSeverity, BankConnection, CoachMessage, Conversation, CreditProfile, CreditScore, CreditScoreHistory,
  Feasibility, ForecastPoint, Goal, GoalPriority, HealthIndicator, Household, Huddle, Member, Obligation, Presence, PresenceRole,
  Proposal, ProposalAnalysis, ProposalDetails, ProposalVerdict, Provider, Scenario, ScenarioResult, TraceEvent, TraceType,
  Transaction, TranscriptLine, Vote, VoteChoice, Workflow, KidTask, KidJar, CashFlow, CashMonthRow,
} from "@/lib/types";

interface TimestampLike {
  toDate(): Date;
}
const iso = (t: TimestampLike): string => t.toDate().toISOString();
const isoOpt = (t: TimestampLike | undefined | null): string | undefined => (t ? iso(t) : undefined);
const opt = <T>(v: T | undefined | null): T | undefined => (v === null ? undefined : v);
const blank = (s: string): string | undefined => (s === "" ? undefined : s);

function json<T>(text: string, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
const jsonOpt = (text: string): unknown => (text ? json<unknown>(text, text) : undefined);

/** `Identity` -> hex string (the same string the connection reports). */
const idHex = (i: { toHexString(): string } | undefined | null): string | undefined => (i ? i.toHexString() : undefined);

export const mapHousehold = (r: B.Household): Household => ({
  id: r.id, name: r.name, city: r.city, state: r.state, persona: r.persona, template_id: r.templateId,
  owner: idHex(r.owner), home_value: r.homeValue, vehicle_value: r.vehicleValue, created_at: iso(r.createdAt),
});

export const mapMember = (r: B.Member): Member => ({
  id: r.id, household_id: r.householdId, name: r.name, age: r.age, role: r.role as Member["role"], income_annual: r.incomeAnnual,
});

export const mapAccount = (r: B.Account): Account => ({
  id: r.id, household_id: r.householdId, type: r.type as Account["type"], institution: r.institution, nickname: r.nickname,
  balance: r.balance, rate_pct: opt(r.ratePct), credit_limit: opt(r.creditLimit), monthly_payment: opt(r.monthlyPayment),
  maturity_date: opt(r.maturityDate), opened_date: r.openedDate, owner_member_ids: json<string[]>(r.ownerMemberIdsJson, []),
  source: r.source === "plaid" ? "plaid" : "seed",
});

export const mapObligation = (r: B.Obligation): Obligation => ({
  id: r.id, household_id: r.householdId, name: r.name, amount: r.amount, due_day: r.dueDay, account_id: r.accountId, kind: r.kind as Obligation["kind"],
});

export const mapCreditProfile = (r: B.CreditProfile): CreditProfile => ({
  member_id: r.memberId, household_id: r.householdId, score: r.score, utilization_pct: r.utilizationPct,
  hard_inquiries_12m: r.hardInquiries12M, oldest_account_years: r.oldestAccountYears, late_payments_24m: r.latePayments24M,
});

export const mapTxn = (r: B.Txn): Transaction => ({
  id: r.id, household_id: r.householdId, account_id: r.accountId, date: r.date, amount: r.amount, merchant: r.merchant,
  category: r.category, description: r.description, is_recurring: r.isRecurring, source: r.source === "plaid" ? "plaid" : "seed",
  anomaly_truth: (r.anomalyTruth || "") as Transaction["anomaly_truth"],
});

export const mapConversation = (r: B.Conversation): Conversation => ({
  id: r.id, household_id: r.householdId, title: r.title,
  turns: json<{ speaker: string; text: string }[]>(r.turnsJson, []),
  expected_goals: json<Partial<Goal>[]>(r.expectedGoalsJson, []),
  scam_signals: json<string[]>(r.scamSignalsJson, []),
});

const UNIT: Record<string, HealthIndicator["unit"]> = { months: "months", "%": "pct", pct: "pct", USD: "usd", usd: "usd", score: "score" };
export const mapHealth = (r: B.HealthIndicator): HealthIndicator => ({
  id: r.id, household_id: r.householdId, key: r.key as HealthIndicator["key"], label: r.label, value: r.value,
  unit: UNIT[r.unit] ?? "pct", status: r.status as HealthIndicator["status"], explanation: r.explanation, updated_at: iso(r.updatedAt),
});

export const mapForecast = (r: B.ForecastPoint): ForecastPoint => ({
  id: r.id, household_id: r.householdId, date: r.date, balance: r.balance, obligations_due: r.obligationsDue,
});

export const mapAlert = (r: B.Alert): Alert => ({
  id: r.id, household_id: r.householdId, severity: r.severity as AlertSeverity, kind: r.kind as AlertKind, title: r.title,
  detail: r.detail, related_ids: json<string[]>(r.relatedIdsJson, []), created_at: iso(r.createdAt), acknowledged_by: r.acknowledgedBy,
});

/** goal.priority is an i32 where 1 = most important. */
export const priorityFromDb = (n: number): GoalPriority => (n <= 1 ? "high" : n === 2 ? "medium" : "low");
export const priorityToDb = (p: GoalPriority | undefined): number => (p === "high" ? 1 : p === "low" ? 3 : 2);

export const mapGoal = (r: B.Goal): Goal => ({
  id: r.id, household_id: r.householdId, title: r.title, target_amount: r.targetAmount > 0 ? r.targetAmount : undefined,
  target_date: blank(r.targetDate), priority: priorityFromDb(r.priority), feasibility: r.feasibility as Feasibility,
  evidence_quote: blank(r.evidenceQuote), source: r.source as Goal["source"], created_at: iso(r.createdAt), updated_at: iso(r.updatedAt),
});

export const mapPresence = (r: B.Presence): Presence => ({
  identity: r.identity.toHexString(), household_id: r.householdId, display_name: r.displayName, role: r.role as PresenceRole, last_seen: iso(r.lastSeen),
});

export const mapHuddle = (r: B.Huddle): Huddle => ({
  id: r.id, household_id: r.householdId, started_by_name: r.startedByName, status: r.status as Huddle["status"],
  started_at: iso(r.startedAt), ended_at: isoOpt(r.endedAt), consent_names: json<string[]>(r.consentNamesJson, []),
});

export const mapTranscriptLine = (r: B.TranscriptLine): TranscriptLine => ({
  id: Number(r.id), huddle_id: r.huddleId, household_id: r.householdId, speaker: r.speaker, text: r.text, ts: iso(r.ts),
});

export const mapScenario = (r: B.Scenario): Scenario => ({
  id: r.id, household_id: r.householdId, prompt: r.prompt, status: r.status as Scenario["status"],
  result: r.resultJson ? json<ScenarioResult | undefined>(r.resultJson, undefined) : undefined,
  requested_by_name: r.requestedByName, created_at: iso(r.createdAt),
});

export const mapCoachMessage = (r: B.CoachMessage): CoachMessage => ({
  id: Number(r.id), household_id: r.householdId, role: r.role as CoachMessage["role"], author_name: r.authorName, text: r.text,
  run_id: r.runId, created_at: iso(r.createdAt),
});

export const mapAdvisorNote = (r: B.AdvisorNote): AdvisorNote => ({
  id: Number(r.id), household_id: r.householdId, author_name: r.authorName, text: r.text, created_at: iso(r.createdAt),
});

export const mapRun = (r: B.AgentRun): AgentRun => ({
  run_id: r.runId, job_id: Number(r.jobId), workflow: r.workflow as Workflow, household_id: r.householdId,
  status: r.status as AgentRun["status"], started_at: iso(r.startedAt), finished_at: isoOpt(r.finishedAt),
  providers: json<string[]>(r.providersJson, []), result: jsonOpt(r.resultJson),
});

export const mapTrace = (r: B.TraceEvent): TraceEvent => ({
  id: Number(r.id), run_id: r.runId, household_id: r.householdId, seq: r.seq, ts: iso(r.ts), workflow: r.workflow as Workflow,
  agent: r.agent, type: r.type as TraceType, title: r.title, data: jsonOpt(r.dataJson), model: blank(r.model),
  provider: blank(r.provider) as Provider | undefined, latency_ms: r.latencyMs || undefined,
  tokens: r.tokensIn || r.tokensOut ? { in: r.tokensIn, out: r.tokensOut } : undefined,
});

export const mapBank = (r: B.BankConnection): BankConnection => ({
  item_id: r.itemId, household_id: r.householdId, institution_name: r.institutionName, status: r.status as BankConnection["status"],
  accounts_count: r.accountsCount, txns_count: r.txnsCount, last_synced_at: isoOpt(r.lastSyncedAt), error: blank(r.error),
});

// ---------------------------------------------------------------- family voting (contracts.md section 6)

export const mapProposal = (r: B.Proposal): Proposal => ({
  id: r.id, household_id: r.householdId, title: r.title, amount: Number(r.amount), details: json<ProposalDetails>(r.detailsJson, {}),
  created_by_name: r.createdByName, created_at: iso(r.createdAt), closes_at: iso(r.closesAt), status: r.status === "closed" ? "closed" : "open",
  verdict: (["fine", "tight", "risky"].includes(r.verdict) ? r.verdict : "") as ProposalVerdict,
  analysis: r.analysisJson ? json<ProposalAnalysis | undefined>(r.analysisJson, undefined) : undefined, run_id: r.runId,
});

export const mapVote = (r: B.Vote): Vote => ({
  id: r.id, proposal_id: r.proposalId, household_id: r.householdId, voter_key: r.voterKey, voter_name: r.voterName,
  choice: (["yes", "no", "abstain"].includes(r.choice) ? r.choice : "abstain") as VoteChoice, updated_at: iso(r.updatedAt),
});

// ---------------------------------------------------------------- kids and teens (contracts.md section 12)

export const mapKidTask = (r: B.KidTask): KidTask => ({
  id: r.id, household_id: r.householdId, member_id: r.memberId, title: r.title, reward: Number(r.reward),
  status: (["open", "done", "approved"].includes(r.status) ? r.status : "open") as KidTask["status"],
  created_by_name: r.createdByName, created_at: iso(r.createdAt), updated_at: iso(r.updatedAt),
});

export const mapKidJar = (r: B.KidJar): KidJar => ({
  member_id: r.memberId, household_id: r.householdId, balance: Number(r.balance), earned_total: Number(r.earnedTotal),
  goal_title: r.goalTitle, goal_target: Number(r.goalTarget), updated_at: iso(r.updatedAt),
});

// ---------------------------------------------------------------- credit monitoring (contracts.md section 9)
// Typed by hand from the contract so this compiles before and after the bindings are regenerated with these tables.

export interface CreditScoreRow {
  id: string; householdId: string; memberId: string; score: number; band: string; factorsJson: string; updatedAt: TimestampLike;
}
export interface CashFlowTableRow {
  householdId: string; asOf: string; windowDays: number; incomeMonthly: number; expenseMonthly: number; netMonthly: number;
  savingsRate: number; categoriesJson: string; updatedAt?: TimestampLike;
}
export interface CashMonthTableRow {
  id: string; householdId: string; month: string; income: number; expenses: number; net: number; partial: boolean;
}
export const mapCashFlow = (r: CashFlowTableRow): CashFlow => ({
  household_id: r.householdId, as_of: r.asOf, window_days: Number(r.windowDays), income_monthly: r.incomeMonthly,
  expense_monthly: r.expenseMonthly, net_monthly: r.netMonthly, savings_rate: r.savingsRate,
  categories: json<{ category: string; total: number }[]>(r.categoriesJson, []).filter((c) => c && typeof c.total === "number"),
  updated_at: r.updatedAt ? iso(r.updatedAt) : new Date().toISOString(),
});
export const mapCashMonth = (r: CashMonthTableRow): CashMonthRow => ({
  id: r.id, household_id: r.householdId, month: r.month, income: r.income, expenses: r.expenses, net: r.net, partial: !!r.partial,
});

export interface CreditScoreHistoryRow {
  id: string; householdId: string; memberId: string; date: string; score: number;
}

export const mapCreditScore = (r: CreditScoreRow): CreditScore => ({
  id: r.id, household_id: r.householdId, member_id: r.memberId, score: Number(r.score), band: r.band ?? "",
  factors: parseFactors(json<unknown>(r.factorsJson, [])), updated_at: r.updatedAt ? iso(r.updatedAt) : new Date().toISOString(),
});

export const mapCreditScoreHistory = (r: CreditScoreHistoryRow): CreditScoreHistory => ({
  id: r.id, household_id: r.householdId, member_id: r.memberId, date: String(r.date).slice(0, 10), score: Number(r.score),
});
