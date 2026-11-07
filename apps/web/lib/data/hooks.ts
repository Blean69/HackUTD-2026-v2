"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { LIABILITY_TYPES } from "@/lib/format";
import type {
  Account, AgentRun, Alert, HealthIndicator, HealthStatus, Presence, TraceEvent, Workflow,
} from "@/lib/types";
import type { DataScope } from "./backend";
import { useConnection } from "./connection";
import { setDataScope } from "./runtime";
import { store, emptyRows, type TableName, type TableRows } from "./store";

const subscribers = new Map<TableName, (cb: () => void) => () => void>();
function subscriberFor(t: TableName) {
  let s = subscribers.get(t);
  if (!s) {
    s = (cb) => store.subscribe(t, cb);
    subscribers.set(t, s);
  }
  return s;
}

/** Live rows of one table. Re-renders only when that table changes. */
export function useRows<K extends TableName>(t: K): readonly TableRows[K][] {
  return useSyncExternalStore(
    subscriberFor(t),
    () => store.rows(t),
    () => emptyRows<TableRows[K]>(),
  );
}

/** True once a backend (mock or SpacetimeDB) is connected and the first sync has landed. */
export function useDataReady(): boolean {
  const c = useConnection();
  return c.status === "ready" && c.synced;
}

/** Tell the data layer which slice of the database this page needs (live mode subscribes to just that). */
export function useDataScope(kind: DataScope["kind"], householdId = ""): void {
  useEffect(() => {
    setDataScope(kind === "room" ? { kind, householdId } : ({ kind } as DataScope));
  }, [kind, householdId]);
}

// ------------------------------------------------------------------ household

export function useHouseholds() {
  const rows = useRows("household");
  return useMemo(() => [...rows].sort((a, b) => a.name.localeCompare(b.name)), [rows]);
}
export function useHousehold(id: string) {
  const rows = useRows("household");
  return useMemo(() => rows.find((h) => h.id === id), [rows, id]);
}
export function useMembers(householdId: string) {
  const rows = useRows("member");
  return useMemo(() => rows.filter((m) => m.household_id === householdId), [rows, householdId]);
}
export function useAccounts(householdId: string) {
  const rows = useRows("account");
  return useMemo(() => rows.filter((a) => a.household_id === householdId), [rows, householdId]);
}
export function useObligations(householdId: string) {
  const rows = useRows("obligation");
  return useMemo(() => rows.filter((o) => o.household_id === householdId), [rows, householdId]);
}
export function useConversations(householdId: string) {
  const rows = useRows("conversation");
  return useMemo(() => rows.filter((c) => c.household_id === householdId), [rows, householdId]);
}

const HEALTH_ORDER = ["liquidity_runway", "emergency_fund", "debt_to_income", "credit_utilization", "savings_rate", "net_worth_trend", "forecast_low_point", "credit_score"];
export function useHealth(householdId: string): HealthIndicator[] {
  const rows = useRows("health_indicator");
  return useMemo(
    () => rows.filter((h) => h.household_id === householdId).sort((a, b) => HEALTH_ORDER.indexOf(a.key) - HEALTH_ORDER.indexOf(b.key)),
    [rows, householdId],
  );
}
export function useForecast(householdId: string) {
  const rows = useRows("forecast_point");
  return useMemo(() => {
    const points = rows.filter((p) => p.household_id === householdId).sort((a, b) => a.date.localeCompare(b.date));
    let low = points[0];
    for (const p of points) if (p.balance < low.balance) low = p;
    return { points, low_point: points.length ? { date: low.date, balance: low.balance } : null };
  }, [rows, householdId]);
}

const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 } as const;
export function useAlerts(householdId: string): Alert[] {
  const rows = useRows("alert");
  return useMemo(
    () =>
      rows
        .filter((a) => a.household_id === householdId)
        .sort((a, b) => Number(!!a.acknowledged_by) - Number(!!b.acknowledged_by) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.created_at.localeCompare(a.created_at)),
    [rows, householdId],
  );
}
export function useGoals(householdId: string) {
  const rows = useRows("goal");
  return useMemo(
    () => rows.filter((g) => g.household_id === householdId).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.title.localeCompare(b.title)),
    [rows, householdId],
  );
}

export interface NetWorth {
  assets: number;
  liabilities: number;
  net: number;
}
export function useNetWorth(accounts: readonly Account[], propertyValue = 0): NetWorth {
  return useMemo(() => {
    let assets = propertyValue;
    let liabilities = 0;
    for (const a of accounts) {
      if (LIABILITY_TYPES.has(a.type)) liabilities += a.balance;
      else assets += a.balance;
    }
    return { assets, liabilities, net: assets - liabilities };
  }, [accounts, propertyValue]);
}

export function useBankConnections(householdId: string) {
  const rows = useRows("bank_connection");
  return useMemo(() => rows.filter((b) => b.household_id === householdId), [rows, householdId]);
}

// ------------------------------------------------------------------ multiplayer

export type PresenceView = Presence & { isMe: boolean };
export function usePresence(householdId: string): PresenceView[] {
  const rows = useRows("presence");
  const { identity } = useConnection();
  return useMemo(
    () =>
      rows
        .filter((p) => p.household_id === householdId)
        .map((p) => ({ ...p, isMe: p.identity === identity }))
        .sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.display_name.localeCompare(b.display_name)),
    [rows, householdId, identity],
  );
}
/** Everyone connected anywhere (for the advisor console). */
export function usePresenceAll(): PresenceView[] {
  const rows = useRows("presence");
  const { identity } = useConnection();
  return useMemo(() => rows.map((p) => ({ ...p, isMe: p.identity === identity })), [rows, identity]);
}

/** The household's most recent Huddle (live > analyzing > done). */
export function useHuddle(householdId: string) {
  const rows = useRows("huddle");
  return useMemo(() => {
    const mine = rows.filter((h) => h.household_id === householdId).sort((a, b) => b.started_at.localeCompare(a.started_at));
    return mine.find((h) => h.status === "live") ?? mine[0];
  }, [rows, householdId]);
}
export function useTranscript(huddleId: string | undefined) {
  const rows = useRows("transcript_line");
  return useMemo(() => (huddleId ? rows.filter((l) => l.huddle_id === huddleId).sort((a, b) => a.id - b.id) : []), [rows, huddleId]);
}
export function useScenarios(householdId: string) {
  const rows = useRows("scenario");
  return useMemo(() => rows.filter((s) => s.household_id === householdId).sort((a, b) => b.created_at.localeCompare(a.created_at)), [rows, householdId]);
}
export function useCoachMessages(householdId: string) {
  const rows = useRows("coach_message");
  return useMemo(() => rows.filter((m) => m.household_id === householdId).sort((a, b) => a.id - b.id), [rows, householdId]);
}
export function useAdvisorNotes(householdId: string) {
  const rows = useRows("advisor_note");
  return useMemo(() => rows.filter((n) => n.household_id === householdId).sort((a, b) => b.id - a.id), [rows, householdId]);
}

// ------------------------------------------------------------------ agent runs + trace

export function useRuns(filter?: { householdId?: string; workflow?: Workflow | "all" }): AgentRun[] {
  const rows = useRows("agent_run");
  const hid = filter?.householdId;
  const wf = filter?.workflow;
  return useMemo(
    () =>
      rows
        .filter((r) => (!hid || r.household_id === hid) && (!wf || wf === "all" || r.workflow === wf))
        .sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [rows, hid, wf],
  );
}
export function useRun(runId: string | null | undefined) {
  const rows = useRows("agent_run");
  return useMemo(() => (runId ? rows.find((r) => r.run_id === runId) : undefined), [rows, runId]);
}
/** The most recent run (optionally for one household / workflow). */
export function useLatestRun(householdId?: string, workflow?: Workflow) {
  const runs = useRuns({ householdId, workflow });
  return runs[0];
}
export function useTraceEvents(runId: string | null | undefined): TraceEvent[] {
  const rows = useRows("trace_event");
  return useMemo(() => (runId ? rows.filter((e) => e.run_id === runId).sort((a, b) => a.seq - b.seq) : []), [rows, runId]);
}
/** All trace events grouped by run, newest events last. Used by the /agents wall to avoid N filters. */
export function useTraceByRun(): Map<string, TraceEvent[]> {
  const rows = useRows("trace_event");
  return useMemo(() => {
    const m = new Map<string, TraceEvent[]>();
    for (const e of rows) {
      const a = m.get(e.run_id);
      if (a) a.push(e);
      else m.set(e.run_id, [e]);
    }
    for (const a of m.values()) a.sort((x, y) => x.seq - y.seq);
    return m;
  }, [rows]);
}

// ------------------------------------------------------------------ advisor roll-up

export interface HouseholdSummary {
  id: string;
  name: string;
  city: string;
  state: string;
  persona: string;
  isSandbox: boolean;
  status: HealthStatus;
  indicators: HealthIndicator[];
  openAlerts: Alert[];
  openGoals: number;
  netWorth: number;
  online: number;
  lastNote?: string;
}
const STATUS_RANK: Record<HealthStatus, number> = { good: 0, watch: 1, risk: 2 };
export function useHouseholdSummaries(): HouseholdSummary[] {
  const households = useHouseholds();
  const health = useRows("health_indicator");
  const alerts = useRows("alert");
  const goals = useRows("goal");
  const accounts = useRows("account");
  const presence = useRows("presence");
  const notes = useRows("advisor_note");
  return useMemo(
    () =>
      households.map((h) => {
        const indicators = health.filter((i) => i.household_id === h.id);
        let status: HealthStatus = "good";
        for (const i of indicators) if (STATUS_RANK[i.status] > STATUS_RANK[status]) status = i.status;
        let net = (h.home_value ?? 0) + (h.vehicle_value ?? 0);
        for (const a of accounts) if (a.household_id === h.id) net += LIABILITY_TYPES.has(a.type) ? -a.balance : a.balance;
        const lastNote = notes.filter((n) => n.household_id === h.id).sort((a, b) => b.id - a.id)[0];
        return {
          id: h.id,
          name: h.name,
          city: h.city,
          state: h.state,
          persona: h.persona,
          isSandbox: h.id.startsWith("hh_sbx_"),
          status,
          indicators,
          openAlerts: alerts.filter((a) => a.household_id === h.id && !a.acknowledged_by),
          openGoals: goals.filter((g) => g.household_id === h.id).length,
          netWorth: net,
          online: presence.filter((p) => p.household_id === h.id).length,
          lastNote: lastNote?.text,
        };
      }),
    [households, health, alerts, goals, accounts, presence, notes],
  );
}
