"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { dedupeGoals } from "@/lib/finance";
import type {
  AgentRun, Alert, HealthIndicator, KidJar, KidTask, Presence, Proposal, TraceEvent, Vote, VoteChoice, Workflow,
} from "@/lib/types";
import type { DataScope, RoomTable } from "./backend";
import { useConnection } from "./connection";
import { acquireRoomTables, roomTablesLoaded, setDataScope, subscribeLoaded } from "./runtime";
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

/**
 * Ask for the room tables this page or panel reads, on top of the base set (members, accounts, health, alerts, huddle,
 * runs). Returns true once the connection is ready and those tables have landed, so a page can show a skeleton instead
 * of a false "nothing here yet". Tables unsubscribe a few seconds after the last reader goes away.
 */
export function useRoomTables(householdId: string, tables: readonly RoomTable[]): boolean {
  const key = tables.join(",");
  const connected = useDataReady();
  useEffect(() => {
    if (!householdId || !key) return;
    return acquireRoomTables(householdId, key.split(",") as RoomTable[]);
  }, [householdId, key]);
  const loaded = useSyncExternalStore(
    subscribeLoaded,
    () => (key ? roomTablesLoaded(householdId, key.split(",")) : true),
    () => false,
  );
  return connected && loaded;
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
        // `advisor` alerts came from the removed Advisor Console (contracts.md section 11); old rows stay hidden.
        .filter((a) => a.household_id === householdId && a.kind !== "advisor")
        .sort((a, b) => Number(!!a.acknowledged_by) - Number(!!b.acknowledged_by) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.created_at.localeCompare(a.created_at)),
    [rows, householdId],
  );
}
/** The household's goals, newest first, with goals the agents extracted twice collapsed into one. Needs the `goal` table. */
export function useGoals(householdId: string) {
  const rows = useRows("goal");
  return useMemo(
    () => dedupeGoals(rows.filter((g) => g.household_id === householdId).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.title.localeCompare(b.title))),
    [rows, householdId],
  );
}

export function useTxns(householdId: string) {
  const rows = useRows("txn");
  return useMemo(() => rows.filter((t) => t.household_id === householdId), [rows, householdId]);
}
export function useCreditProfiles(householdId: string) {
  const rows = useRows("credit_profile");
  return useMemo(() => rows.filter((c) => c.household_id === householdId), [rows, householdId]);
}

export function useBankConnections(householdId: string) {
  const rows = useRows("bank_connection");
  return useMemo(() => rows.filter((b) => b.household_id === householdId), [rows, householdId]);
}

// ------------------------------------------------------------------ family voting

/** The household's proposals: open ones first (soonest to close), then closed ones (newest first). */
export function useProposals(householdId: string): Proposal[] {
  const rows = useRows("proposal");
  return useMemo(
    () =>
      rows
        .filter((p) => p.household_id === householdId)
        .sort((a, b) => Number(a.status === "closed") - Number(b.status === "closed") || (a.status === "open" ? a.closes_at.localeCompare(b.closes_at) : b.closes_at.localeCompare(a.closes_at))),
    [rows, householdId],
  );
}
/** Votes for one household, or for one proposal when `proposalId` is given. */
export function useVotes(householdId: string, proposalId?: string): Vote[] {
  const rows = useRows("vote");
  return useMemo(() => rows.filter((v) => v.household_id === householdId && (!proposalId || v.proposal_id === proposalId)), [rows, householdId, proposalId]);
}

export interface VoteTally {
  yes: number;
  no: number;
  abstain: number;
  total: number;
}
export function tallyVotes(votes: readonly Vote[]): VoteTally {
  const t: VoteTally = { yes: 0, no: 0, abstain: 0, total: 0 };
  for (const v of votes) {
    t[v.choice] += 1;
    t.total += 1;
  }
  return t;
}
/** The caller's current choice on a proposal (identity hex matches `voter_key`). */
export function useMyVote(votes: readonly Vote[]): VoteChoice | undefined {
  const { identity } = useConnection();
  return useMemo(() => votes.find((v) => v.voter_key === identity)?.choice, [votes, identity]);
}

// ------------------------------------------------------------------ kids and teens

/** Chores for the household (register `useRoomTables(id, ["kid_task", "kid_jar"])` on the page), newest first. */
export function useKidTasks(householdId: string): KidTask[] {
  const rows = useRows("kid_task");
  return useMemo(() => rows.filter((k) => k.household_id === householdId).sort((a, b) => b.created_at.localeCompare(a.created_at)), [rows, householdId]);
}
/** Savings jars by member id. */
export function useKidJars(householdId: string): Map<string, KidJar> {
  const rows = useRows("kid_jar");
  return useMemo(() => new Map(rows.filter((j) => j.household_id === householdId).map((j) => [j.member_id, j])), [rows, householdId]);
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
/**
 * Load the steps of specific runs, whatever household they belong to (the rows currently on screen in the Agent Trail).
 * Steps are the heaviest table, so the wall loads them for the runs it shows, not for every run ever made.
 */
export function useRunTraces(runs: readonly { run_id: string; household_id: string }[]): void {
  const key = runs.map((r) => `${r.household_id}|${r.run_id}`).join(",");
  useEffect(() => {
    if (!key) return;
    const releases = key.split(",").map((k) => {
      const [household, runId] = k.split("|");
      return acquireRoomTables(household, [`trace_event@${runId}`]);
    });
    return () => {
      for (const release of releases) release();
    };
  }, [key]);
}

/** Last event of a run -> the sorted array built for it, so an unchanged run keeps the same array between renders. */
const runEventsCache = new WeakMap<TraceEvent, TraceEvent[]>();

/**
 * All trace events grouped by run, oldest first. A run whose events did not change keeps the same array, so memoised
 * rows on the /agents wall only re-render for the run that is actually moving.
 */
export function useTraceByRun(): Map<string, TraceEvent[]> {
  const rows = useRows("trace_event");
  return useMemo(() => {
    const grouped = new Map<string, TraceEvent[]>();
    for (const e of rows) {
      const a = grouped.get(e.run_id);
      if (a) a.push(e);
      else grouped.set(e.run_id, [e]);
    }
    const out = new Map<string, TraceEvent[]>();
    for (const [id, a] of grouped) {
      a.sort((x, y) => x.seq - y.seq);
      const last = a[a.length - 1];
      const hit = runEventsCache.get(last);
      if (hit && hit.length === a.length && hit[0] === a[0]) out.set(id, hit);
      else {
        runEventsCache.set(last, a);
        out.set(id, a);
      }
    }
    return out;
  }, [rows]);
}
