/**
 * SpacetimeDB backend: the real thing.
 *
 * - Connects with the generated `DbConnection` (lib/module_bindings, never edited). The auth token is kept in
 *   localStorage so a phone keeps its identity (and therefore its sandbox ownership). Append `?as=<label>` to the
 *   first URL you open to get a separate identity in the same browser (handy for testing two people in two tabs).
 * - Table callbacks map binding rows into the UI store (lib/data/spacetime-map.ts); components never see bindings.
 * - Pages declare what they need through a `DataScope`; we subscribe to just that slice (household-scoped queries for
 *   the room, runs and trace events for /agents, summaries for /advisor) and flip `connection.synced` when the first
 *   rows have been applied. A small base subscription (households + presence) lives as long as the connection.
 * - Every `Actions` method calls the matching reducer.
 * - Resolves `{ backend: null }` (never throws) when the database is unreachable or empty, so the runtime falls back
 *   to the mock engine.
 *
 * Env: NEXT_PUBLIC_SPACETIME_URI (default ws://localhost:3000), NEXT_PUBLIC_SPACETIME_DB (default "keystone").
 */
import { SPACETIME_DB, SPACETIME_URI } from "@/lib/constants";
import type { DbConnection, SubscriptionHandle } from "@/lib/module_bindings";
import type { Goal, PresenceRole, ProposalDetails, VoteChoice } from "@/lib/types";
import type { Actions, Backend, DataScope } from "./backend";
import { setConnection } from "./connection";
import * as M from "./spacetime-map";
import { keyOf, type DataStore, type TableName, type TableRows } from "./store";

export { SPACETIME_DB, SPACETIME_URI };

/** The live connection, for feature modules that own tables the shared store does not know (lib/data/onboarding.ts). */
let liveConn: DbConnection | null = null;
export const liveConnection = (): DbConnection | null => liveConn;

const TOKEN_KEY = "keystone.token";
const CONNECT_TIMEOUT_MS = 5000;
const SYNC_TIMEOUT_MS = 10000;

/** Per-browser-tab identity namespace: `?as=alice` -> its own token. */
function tokenKey(): string {
  try {
    const as = new URLSearchParams(window.location.search).get("as");
    return as ? `${TOKEN_KEY}.${as.replace(/[^\w-]/g, "").slice(0, 24)}` : TOKEN_KEY;
  } catch {
    return TOKEN_KEY;
  }
}
const readToken = (k: string): string | undefined => {
  try {
    return localStorage.getItem(k) || undefined;
  } catch {
    return undefined;
  }
};
const saveToken = (k: string, v: string | undefined): void => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* private mode: identity lasts for this page load only */
  }
};

const safeId = (s: string) => s.replace(/[^\w:.-]/g, "");

/**
 * The room tables every room page needs (the shell reads them): people, accounts, health, alerts, the live huddle and
 * the run list. Everything else is subscribed on demand by the page or panel that reads it (`useRoomTables`), so
 * Household does not download 667 transactions and the trace drawer costs nothing until it opens.
 */
const BASE_ROOM_TABLES = ["account", "member", "health_indicator", "alert", "huddle", "agent_run"];
/** Onboarding households are read by the wizard through the plain room scope (goals, bank link, insight trace). */
const ONBOARDING_EXTRA_TABLES = ["goal", "bank_connection", "trace_event"];
/** Tables that only exist when the published module has the voting section of contracts.md. */
const VOTING_TABLES = ["proposal", "vote"];

/** One on-demand room table; `trace_event@<run_id>` narrows the steps to a single run. */
function roomTableQuery(householdId: string, table: string): string {
  const at = table.indexOf("@");
  if (at < 0) return `SELECT * FROM ${table} WHERE household_id = '${householdId}'`;
  return `SELECT * FROM ${table.slice(0, at)} WHERE household_id = '${householdId}' AND run_id = '${safeId(table.slice(at + 1))}'`;
}

export function queriesFor(scope: DataScope): string[] {
  switch (scope.kind) {
    case "room": {
      const id = safeId(scope.householdId);
      const tables = scope.householdId.startsWith("hh_onb_") ? [...BASE_ROOM_TABLES, ...ONBOARDING_EXTRA_TABLES] : BASE_ROOM_TABLES;
      return tables.map((t) => `SELECT * FROM ${t} WHERE household_id = '${id}'`);
    }
    case "advisor":
      // The console lists the latest runs, not their steps: no trace_event here.
      return ["health_indicator", "alert", "goal", "account", "advisor_note", "agent_run"].map((t) => `SELECT * FROM ${t}`);
    case "agents":
      // Runs only; the wall loads the steps of the runs on screen (`useRunTraces`).
      return ["SELECT * FROM agent_run"];
    default:
      return ["SELECT * FROM agent_run"];
  }
}
const scopeKey = (s: DataScope) => (s.kind === "room" ? `room:${s.householdId}` : s.kind);

interface Tbl<R> {
  onInsert(cb: (ctx: unknown, row: R) => void): void;
  onUpdate(cb: (ctx: unknown, oldRow: R, newRow: R) => void): void;
  onDelete(cb: (ctx: unknown, row: R) => void): void;
}

/**
 * True when the module this browser is connected to has the voting tables. The bindings include them, but a database
 * published before section 6 of contracts.md does not, and subscribing to a missing table would fail the whole room.
 */
function supportsVoting(conn: DbConnection): boolean {
  const db = conn.db as unknown as Record<string, unknown>;
  return !!db.proposal && !!db.vote;
}

function wireTables(conn: DbConnection, store: DataStore, onOwnPresenceGone: () => void, me: () => string): void {
  const wire = <R, T extends TableName>(tbl: unknown, name: T, map: (r: R) => TableRows[T], onGone?: (row: TableRows[T]) => void) => {
    const t = tbl as Tbl<R>;
    t.onInsert((_c, r) => store.upsert(name, map(r)));
    t.onUpdate((_c, _o, r) => store.upsert(name, map(r)));
    t.onDelete((_c, r) => {
      const row = map(r);
      store.remove(name, keyOf(name, row));
      onGone?.(row);
    });
  };
  const db = conn.db;
  wire(db.household, "household", M.mapHousehold);
  wire(db.member, "member", M.mapMember);
  wire(db.account, "account", M.mapAccount);
  wire(db.obligation, "obligation", M.mapObligation);
  wire(db.conversation, "conversation", M.mapConversation);
  wire(db.healthIndicator, "health_indicator", M.mapHealth);
  wire(db.forecastPoint, "forecast_point", M.mapForecast);
  wire(db.alert, "alert", M.mapAlert);
  wire(db.goal, "goal", M.mapGoal);
  wire(db.presence, "presence", M.mapPresence, (p) => {
    if (p.identity === me()) onOwnPresenceGone();
  });
  wire(db.huddle, "huddle", M.mapHuddle);
  wire(db.transcriptLine, "transcript_line", M.mapTranscriptLine);
  wire(db.scenario, "scenario", M.mapScenario);
  wire(db.coachMessage, "coach_message", M.mapCoachMessage);
  wire(db.advisorNote, "advisor_note", M.mapAdvisorNote);
  wire(db.agentRun, "agent_run", M.mapRun);
  wire(db.traceEvent, "trace_event", M.mapTrace);
  wire(db.bankConnection, "bank_connection", M.mapBank);
  wire(db.txn, "txn", M.mapTxn);
  wire(db.creditProfile, "credit_profile", M.mapCreditProfile);
  if (supportsVoting(conn)) {
    wire(db.proposal, "proposal", M.mapProposal);
    wire(db.vote, "vote", M.mapVote);
  }
}

function open(DbConnectionCtor: typeof DbConnection, key: string, token: string | undefined, onLive: (up: boolean, detail: string) => void): Promise<{ conn: DbConnection; identity: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let conn: DbConnection | null = null;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn?.disconnect();
      } catch {
        /* ignore */
      }
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error(`timed out connecting to ${SPACETIME_URI}`)), CONNECT_TIMEOUT_MS);
    const b = DbConnectionCtor.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(SPACETIME_DB)
      .withAutomaticReconnect()
      .onConnect((c, identity, tok) => {
        saveToken(key, tok);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ conn: c, identity: identity.toHexString() });
      })
      .onAutomaticReconnect(() => onLive(true, ""))
      .onConnectError((_ctx, err) => {
        if (!settled) fail(err);
        else onLive(false, err instanceof Error ? err.message : "connection error");
      })
      .onDisconnect((_ctx, err) => onLive(false, err ? String(err) : "disconnected"));
    if (token) b.withToken(token);
    conn = b.build();
  });
}

function subscribeApplied(conn: DbConnection, queries: string[], timeoutMs = SYNC_TIMEOUT_MS): Promise<SubscriptionHandle> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("subscription timed out")), timeoutMs);
    const handle: SubscriptionHandle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        clearTimeout(timer);
        resolve(handle);
      })
      .onError((ctx) => {
        clearTimeout(timer);
        const ev = (ctx as { event?: unknown }).event;
        reject(new Error(`subscription failed: ${ev instanceof Error ? ev.message : String(ev ?? "")}`));
      })
      .subscribe(queries);
  });
}

function poll<T>(fn: () => T | undefined, ms = 5000): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined || Date.now() - t0 > ms) return resolve(v);
      setTimeout(tick, 40);
    };
    tick();
  });
}

const unsub = (h: SubscriptionHandle | null | undefined) => {
  try {
    h?.unsubscribe();
  } catch {
    /* already ended */
  }
};

export async function connectSpacetime(store: DataStore): Promise<{ backend: Backend | null; detail: string }> {
  if (typeof window === "undefined") return { backend: null, detail: "no browser" };
  const key = tokenKey();
  let mod: typeof import("@/lib/module_bindings");
  try {
    mod = await import("@/lib/module_bindings");
  } catch (e) {
    return { backend: null, detail: `SpacetimeDB bindings failed to load: ${e instanceof Error ? e.message : String(e)}` };
  }

  let connected: { conn: DbConnection; identity: string } | null = null;
  let me = "";
  let rejoin: (() => void) | null = null;
  const onLive = (up: boolean, detail: string) => {
    setConnection({ online: up, ...(up ? {} : { detail }) });
    if (up) rejoin?.();
  };
  try {
    const token = readToken(key);
    try {
      connected = await open(mod.DbConnection, key, token, onLive);
    } catch (e) {
      if (!token) throw e;
      saveToken(key, undefined); // stale token (e.g. the database was recreated): try again as a new identity
      connected = await open(mod.DbConnection, key, undefined, onLive);
    }
  } catch (e) {
    return { backend: null, detail: `Couldn't reach SpacetimeDB at ${SPACETIME_URI} (${e instanceof Error ? e.message : String(e)})` };
  }
  const { conn } = connected;
  liveConn = conn;
  me = connected.identity;

  let lastJoin: [string, string, PresenceRole] | null = null;
  const callJoin = () => {
    if (lastJoin) void conn.reducers.joinRoom({ householdId: lastJoin[0], displayName: lastJoin[1], role: lastJoin[2] }).catch(() => undefined);
  };
  rejoin = callJoin;
  // Two tabs of one identity share a presence row; if the other tab closes and deletes it, put ours back.
  wireTables(conn, store, () => setTimeout(callJoin, 400), () => me);

  // Base subscription for the life of the connection: who exists, who is online.
  try {
    await subscribeApplied(conn, ["SELECT * FROM household", "SELECT * FROM presence"]);
  } catch (e) {
    conn.disconnect();
    return { backend: null, detail: `SpacetimeDB subscription failed (${e instanceof Error ? e.message : String(e)})` };
  }
  if (store.rows("household").length === 0) {
    conn.disconnect();
    return { backend: null, detail: "SpacetimeDB is up but has no households yet (run `npm run seed` in services/worker)" };
  }

  // ------------------------------------------------------------------ voting
  // Live reducers + tables when the module has them; otherwise an in-browser stand-in (seeded demo proposals, local
  // votes, a deterministic quick check instead of the agent) so the card still works against an older module.
  const voting = supportsVoting(conn);
  // The stand-in is only loaded for a module without the voting tables, so the normal path does not ship it.
  let local: ReturnType<(typeof import("./mock/proposals"))["createLocalProposalActions"]> | null = null;
  if (!voting) {
    const stand = await import("./mock/proposals");
    const sp = stand.seedProposals(new Date(), store.rows("household").map((h) => h.id));
    store.upsertMany("proposal", sp.proposals);
    store.upsertMany("vote", sp.votes);
    local = stand.createLocalProposalActions(store, () => me);
  }

  // ------------------------------------------------------------------ scope
  let active: { key: string; handle: SubscriptionHandle } | null = null;
  let generation = 0;
  const applyScope = (scope: DataScope, force = false) => {
    const k = scopeKey(scope);
    if (!force && active?.key === k) return;
    const mine = ++generation;
    const prev = active;
    setConnection({ synced: false });
    const handle: SubscriptionHandle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        if (mine !== generation) return unsub(handle);
        active = { key: k, handle };
        setConnection({ synced: true });
        if (prev) unsub(prev.handle);
      })
      .onError(() => {
        if (mine === generation) setConnection({ synced: true, detail: "A subscription failed; some data may be missing" });
      })
      .subscribe(queriesFor(scope));
  };

  // ------------------------------------------------------------------ actions
  const r = conn.reducers;
  const actions: Actions = {
    joinRoom: async (householdId, displayName, role) => {
      lastJoin = [householdId, displayName, role];
      await r.joinRoom({ householdId, displayName, role });
    },

    createSandbox: async (templateHouseholdId, displayName) => {
      const before = new Set(store.rows("household").filter((h) => h.owner === me).map((h) => h.id));
      await r.createSandbox({ templateHouseholdId, displayName });
      const made = await poll(() => store.rows("household").filter((h) => h.owner === me && h.template_id === templateHouseholdId && !before.has(h.id)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]);
      if (!made) throw new Error("Your copy was created but hasn't appeared yet. Please try again.");
      return made.id;
    },

    startHuddle: async (householdId, consentNames) => {
      await r.startHuddle({ householdId, consentNamesJson: JSON.stringify(consentNames) });
      const h = await poll(() => store.rows("huddle").filter((x) => x.household_id === householdId && x.status === "live").sort((a, b) => b.started_at.localeCompare(a.started_at))[0]);
      if (!h) throw new Error("Table Mode didn't start. Please try again.");
      return h.id;
    },

    appendTranscript: async (huddleId, speaker, text) => {
      await r.appendTranscript({ huddleId, speaker, text });
    },

    endHuddle: async (huddleId) => {
      await r.endHuddle({ huddleId });
    },

    requestSimulation: async (householdId, prompt) => {
      await r.requestSimulation({ householdId, prompt });
      return "";
    },

    askCoach: async (householdId, text) => {
      // The module takes the author's name from their presence row, so the room must have been joined.
      await r.askCoach({ householdId, text });
    },

    ackAlert: async (alertId, displayName) => {
      await r.ackAlert({ alertId, displayName });
    },

    postAdvisorNote: async (householdId, authorName, text) => {
      await r.postAdvisorNote({ householdId, authorName, text });
    },

    upsertGoal: async (g: Partial<Goal> & { household_id: string; title: string }) => {
      await r.upsertGoal({
        id: g.id ?? "", householdId: g.household_id, title: g.title, targetAmount: g.target_amount ?? 0, targetDate: g.target_date ?? "",
        priority: M.priorityToDb(g.priority),
      });
    },

    deleteGoal: async (id) => {
      await r.deleteGoal({ id });
    },

    requestBankSync: async (householdId) => {
      await r.requestBankSync({ householdId });
    },

    createProposal: async ({ householdId, title, amount, details, closesInDays, authorName }) => {
      if (local) return local.createProposal({ householdId, title, amount, details, closesInDays, authorName });
      const before = new Set(store.rows("proposal").filter((p) => p.household_id === householdId).map((p) => p.id));
      await r.createProposal({ householdId, title, amount, detailsJson: JSON.stringify(details satisfies ProposalDetails), closesInDays, authorName });
      const made = await poll(() => store.rows("proposal").filter((p) => p.household_id === householdId && !before.has(p.id) && p.title === title)[0]);
      return made?.id ?? "";
    },

    castVote: async (proposalId, choice: VoteChoice, voterName) => {
      if (local) return local.castVote(proposalId, choice, voterName);
      await r.castVote({ proposalId, choice, voterName });
    },

    closeProposal: async (proposalId) => {
      if (local) return local.closeProposal(proposalId);
      await r.closeProposal({ proposalId });
    },
  };

  return {
    detail: "",
    backend: {
      kind: "spacetime",
      identity: me,
      actions,
      setScope: (scope) => {
        applyScope(scope);
      },
      subscribeRoomTables: (householdId, tables, onApplied) => {
        const id = safeId(householdId);
        const wanted = tables.filter((t) => voting || !VOTING_TABLES.includes(t));
        if (!wanted.length) {
          queueMicrotask(onApplied);
          return () => undefined;
        }
        let cancelled = false;
        let applied = false;
        const done = () => {
          applied = true;
          if (cancelled) unsub(handle);
          else onApplied();
        };
        const handle: SubscriptionHandle = conn
          .subscriptionBuilder()
          .onApplied(done)
          .onError(done)
          .subscribe(wanted.map((t) => roomTableQuery(id, t)));
        return () => {
          cancelled = true;
          if (applied) unsub(handle);
        };
      },
      dispose: () => {
        try {
          conn.disconnect();
        } catch {
          /* ignore */
        }
      },
    },
  };
}
