"use client";
import { USE_MOCKS } from "@/lib/constants";
import type { Backend, DataScope, RoomTable } from "./backend";
import { getConnection, setConnection } from "./connection";
import { connectSpacetime } from "./spacetime";
import { store } from "./store";

let pending: Promise<Backend> | null = null;
let backend: Backend | null = null;
let desired: DataScope = { kind: "lobby" };

/**
 * Idempotent. Picks the backend once per page load: SpacetimeDB if configured and reachable (and seeded),
 * otherwise the in-browser mock engine. Client-only; kicked off by <DataProvider> and awaited by every action.
 */
export function ensureBackend(): Promise<Backend> {
  if (pending) return pending;
  setConnection({ status: "connecting", synced: false });
  pending = (async () => {
    let detail = "";
    if (USE_MOCKS) {
      detail = "NEXT_PUBLIC_USE_MOCKS=1";
    } else {
      try {
        const res = await connectSpacetime(store);
        if (res.backend) {
          backend = res.backend;
          setConnection({ status: "ready", kind: "spacetime", detail: "", identity: res.backend.identity, online: true });
          res.backend.setScope?.(desired);
          return res.backend;
        }
        detail = res.detail;
      } catch (e) {
        detail = e instanceof Error ? e.message : "SpacetimeDB connection failed";
      }
    }
    // The mock engine and its seed are only needed when SpacetimeDB is not: load them on demand, not with every page.
    const { startMockBackend } = await import("./mock/engine");
    const mock = startMockBackend(store);
    backend = mock;
    setConnection({ status: "ready", kind: "mock", detail, identity: mock.identity, synced: true, online: true });
    return mock;
  })();
  return pending;
}

/** Declare which slice of the database the current page needs. Safe to call before the backend is up. */
export function setDataScope(scope: DataScope): void {
  desired = scope;
  if (backend) backend.setScope?.(scope);
}

export function currentBackend(): Backend | null {
  return backend;
}
export function currentIdentity(): string {
  return getConnection().identity;
}

// ------------------------------------------------------------------------------------------------ on-demand room tables

/**
 * Pages and panels ask for the room tables they read (`useRoomTables` in hooks.ts). Each (household, table) pair is
 * ref-counted: the first reader subscribes, the last one lets go after a short linger so hopping between pages does
 * not re-download. The mock backend already holds everything, so those pairs are "loaded" at once.
 */
const LINGER_MS = 20_000;
interface Hold {
  count: number;
  loaded: boolean;
  release?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}
const holds = new Map<string, Hold>();
const loadedListeners = new Set<() => void>();
const holdKey = (householdId: string, table: string) => `${householdId}|${table}`;
const notifyLoaded = () => {
  for (const l of loadedListeners) l();
};

function start(householdId: string, table: RoomTable, key: string): void {
  void ensureBackend().then((b) => {
    const h = holds.get(key);
    if (!h || h.count === 0 || h.release) return;
    if (!b.subscribeRoomTables) {
      h.loaded = true;
      notifyLoaded();
      return;
    }
    h.release = b.subscribeRoomTables(householdId, [table], () => {
      const cur = holds.get(key);
      if (cur === h) {
        h.loaded = true;
        notifyLoaded();
      }
    });
  });
}

/** Returns the release function. Safe to call before the connection is up. */
export function acquireRoomTables(householdId: string, tables: readonly RoomTable[]): () => void {
  for (const t of tables) {
    const key = holdKey(householdId, t);
    let h = holds.get(key);
    if (!h) {
      h = { count: 0, loaded: false };
      holds.set(key, h);
    }
    if (h.timer) {
      clearTimeout(h.timer);
      h.timer = undefined;
    }
    h.count += 1;
    if (!h.release && !h.loaded) start(householdId, t, key);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const t of tables) {
      const key = holdKey(householdId, t);
      const h = holds.get(key);
      if (!h) continue;
      h.count -= 1;
      if (h.count > 0) continue;
      h.timer = setTimeout(() => {
        if (h.count > 0) return;
        h.release?.();
        holds.delete(key);
        notifyLoaded();
      }, LINGER_MS);
    }
  };
}

export function roomTablesLoaded(householdId: string, tables: readonly string[]): boolean {
  return tables.every((t) => holds.get(holdKey(householdId, t))?.loaded === true);
}
export function subscribeLoaded(cb: () => void): () => void {
  loadedListeners.add(cb);
  return () => {
    loadedListeners.delete(cb);
  };
}
