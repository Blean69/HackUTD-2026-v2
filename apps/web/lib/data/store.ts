import type {
  Account, AdvisorNote, AgentRun, Alert, BankConnection, CoachMessage, Conversation, CreditProfile, CreditScore, CreditScoreHistory, ForecastPoint, Goal,
  HealthIndicator, Household, Huddle, Member, Obligation, Presence, Proposal, Scenario, TraceEvent, Transaction,
  TranscriptLine, Vote, KidTask, KidJar, CashFlow, CashMonthRow,
} from "@/lib/types";

/** One entry per SpacetimeDB table the UI reads. Rows are UI-shaped (see lib/types.ts). */
export interface TableRows {
  household: Household;
  member: Member;
  account: Account;
  txn: Transaction;
  credit_profile: CreditProfile;
  obligation: Obligation;
  conversation: Conversation;
  health_indicator: HealthIndicator;
  forecast_point: ForecastPoint;
  alert: Alert;
  goal: Goal;
  presence: Presence;
  huddle: Huddle;
  transcript_line: TranscriptLine;
  scenario: Scenario;
  coach_message: CoachMessage;
  advisor_note: AdvisorNote;
  agent_run: AgentRun;
  trace_event: TraceEvent;
  bank_connection: BankConnection;
  proposal: Proposal;
  vote: Vote;
  kid_task: KidTask;
  kid_jar: KidJar;
  credit_score: CreditScore;
  credit_score_history: CreditScoreHistory;
  cash_flow: CashFlow;
  cash_month: CashMonthRow;
}
export type TableName = keyof TableRows;

export const TABLES: TableName[] = [
  "household", "member", "account", "txn", "credit_profile", "obligation", "conversation", "health_indicator",
  "forecast_point", "alert", "goal", "presence", "huddle", "transcript_line", "scenario", "coach_message",
  "advisor_note", "agent_run", "trace_event", "bank_connection", "proposal", "vote", "credit_score", "credit_score_history", "kid_task", "kid_jar", "cash_flow", "cash_month",
];

/** Primary key of each table, as a string. */
const PK: { [K in TableName]: (r: TableRows[K]) => string } = {
  household: (r) => r.id,
  member: (r) => r.id,
  account: (r) => r.id,
  txn: (r) => r.id,
  credit_profile: (r) => r.member_id,
  obligation: (r) => r.id,
  conversation: (r) => r.id,
  health_indicator: (r) => r.id,
  forecast_point: (r) => r.id,
  alert: (r) => r.id,
  goal: (r) => r.id,
  presence: (r) => r.identity,
  huddle: (r) => r.id,
  transcript_line: (r) => String(r.id),
  scenario: (r) => r.id,
  coach_message: (r) => String(r.id),
  advisor_note: (r) => String(r.id),
  agent_run: (r) => r.run_id,
  trace_event: (r) => String(r.id),
  bank_connection: (r) => r.item_id,
  proposal: (r) => r.id,
  vote: (r) => r.id,
  kid_task: (r) => r.id,
  kid_jar: (r) => r.member_id,
  credit_score: (r) => r.id,
  credit_score_history: (r) => r.id,
  cash_flow: (r) => r.household_id,
  cash_month: (r) => r.id,
};

export function keyOf<K extends TableName>(t: K, row: TableRows[K]): string {
  return PK[t](row);
}

const EMPTY: readonly never[] = Object.freeze([]);

/**
 * Normalised in-memory mirror of the SpacetimeDB tables the UI cares about.
 *
 * Backends (mock engine today, the SpacetimeDB adapter next) write into it; React reads from it through
 * useSyncExternalStore. Snapshots are cached arrays that only change identity when the table changes, and change
 * notifications are coalesced into one microtask so a burst of inserts re-renders once.
 */
export class DataStore {
  private maps = {} as { [K in TableName]: Map<string, TableRows[K]> };
  private snaps = {} as { [K in TableName]: readonly TableRows[K][] | null };
  private listeners = {} as Record<TableName, Set<() => void>>;
  private queued = new Set<TableName>();

  constructor() {
    for (const t of TABLES) {
      (this.maps as Record<string, Map<string, unknown>>)[t] = new Map();
      (this.snaps as Record<string, unknown>)[t] = null;
      this.listeners[t] = new Set();
    }
  }

  rows<K extends TableName>(t: K): readonly TableRows[K][] {
    const cached = this.snaps[t] as readonly TableRows[K][] | null;
    if (cached) return cached;
    const fresh: readonly TableRows[K][] = Array.from(this.maps[t].values()) as TableRows[K][];
    (this.snaps as Record<TableName, unknown>)[t] = fresh;
    return fresh;
  }

  get<K extends TableName>(t: K, key: string): TableRows[K] | undefined {
    return this.maps[t].get(key);
  }

  upsert<K extends TableName>(t: K, row: TableRows[K]): void {
    this.maps[t].set(PK[t](row), row);
    this.touch(t);
  }

  upsertMany<K extends TableName>(t: K, rows: readonly TableRows[K][]): void {
    for (const r of rows) this.maps[t].set(PK[t](r), r);
    this.touch(t);
  }

  patch<K extends TableName>(t: K, key: string, partial: Partial<TableRows[K]>): void {
    const cur = this.maps[t].get(key);
    if (cur) this.upsert(t, { ...cur, ...partial });
  }

  remove<K extends TableName>(t: K, key: string): void {
    if (this.maps[t].delete(key)) this.touch(t);
  }

  removeWhere<K extends TableName>(t: K, pred: (r: TableRows[K]) => boolean): void {
    let changed = false;
    for (const [k, v] of this.maps[t]) {
      if (pred(v)) {
        this.maps[t].delete(k);
        changed = true;
      }
    }
    if (changed) this.touch(t);
  }

  clearAll(): void {
    for (const t of TABLES) {
      if (this.maps[t].size) {
        this.maps[t].clear();
        this.touch(t);
      }
    }
  }

  subscribe(t: TableName, cb: () => void): () => void {
    this.listeners[t].add(cb);
    return () => {
      this.listeners[t].delete(cb);
    };
  }

  private touch(t: TableName): void {
    (this.snaps as Record<TableName, unknown>)[t] = null;
    if (this.queued.has(t)) return;
    this.queued.add(t);
    queueMicrotask(() => {
      this.queued.delete(t);
      for (const cb of this.listeners[t]) cb();
    });
  }
}

export const store = new DataStore();
export function emptyRows<T>(): readonly T[] {
  return EMPTY as readonly T[];
}
