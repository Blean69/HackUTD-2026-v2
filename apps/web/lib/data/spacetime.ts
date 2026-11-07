/**
 * SpacetimeDB adapter — STUB.
 *
 * Another agent generates the TypeScript bindings into lib/module_bindings/ (never edit those) and replaces the body
 * of `connectSpacetime` below. Until then this reports "not wired" and the app runs on the mock engine
 * (lib/data/mock/), which implements the same `Backend` interface and writes into the same `store`.
 *
 * What `connectSpacetime(store)` must do when it is real:
 *   1. Connect with DbConnection.builder().withUri(SPACETIME_URI).withDatabaseName(SPACETIME_DB) (+ saved token).
 *   2. Subscribe to the tables listed in TABLES (lib/data/store.ts) and, in onInsert / onUpdate / onDelete,
 *      map each binding row to the UI row type in lib/types.ts (camelCase -> snake_case, parse the `*_json`
 *      columns, Timestamp -> ISO string) and call store.upsert / store.remove.
 *   3. Resolve to a Backend whose `actions` call the reducers (see Actions in ./backend.ts for the 1:1 mapping),
 *      `identity` is the connection's Identity hex string (so `usePresence` can mark "me"), and
 *      `dispose()` disconnects.
 *   4. Resolve to null (never throw) if the database is unreachable, so the runtime falls back to mocks.
 *
 * Env: NEXT_PUBLIC_SPACETIME_URI (default ws://localhost:3000), NEXT_PUBLIC_SPACETIME_DB (default "keystone"),
 *      NEXT_PUBLIC_USE_MOCKS=1 forces mocks.
 */
import { SPACETIME_DB, SPACETIME_URI } from "@/lib/constants";
import type { Backend } from "./backend";
import type { DataStore } from "./store";

export { SPACETIME_DB, SPACETIME_URI };

export interface SpacetimeProbe {
  reachable: boolean;
  detail: string;
}

/** Cheap reachability check: can we open a WebSocket to the database endpoint within `timeoutMs`? */
export function probeSpacetime(timeoutMs = 2000): Promise<SpacetimeProbe> {
  return new Promise((resolve) => {
    if (typeof WebSocket === "undefined") return resolve({ reachable: false, detail: "no WebSocket in this runtime" });
    let done = false;
    let ws: WebSocket | null = null;
    const finish = (p: SpacetimeProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(p);
    };
    const timer = setTimeout(() => finish({ reachable: false, detail: `timed out connecting to ${SPACETIME_URI}` }), timeoutMs);
    try {
      ws = new WebSocket(`${SPACETIME_URI.replace(/\/$/, "")}/v1/database/${SPACETIME_DB}/subscribe`, "v1.bsatn.spacetimedb");
      ws.onopen = () => finish({ reachable: true, detail: `${SPACETIME_URI} is reachable` });
      ws.onerror = () => finish({ reachable: false, detail: `${SPACETIME_URI} refused the connection` });
    } catch (e) {
      finish({ reachable: false, detail: e instanceof Error ? e.message : "bad SpacetimeDB URI" });
    }
  });
}

/** TODO(spacetime agent): replace with the real connection. Must resolve to null when it cannot connect. */
export async function connectSpacetime(store: DataStore): Promise<{ backend: Backend | null; detail: string }> {
  void store;
  const probe = await probeSpacetime();
  return {
    backend: null,
    detail: probe.reachable
      ? `${probe.detail}, but the SpacetimeDB adapter in lib/data/spacetime.ts is not wired yet — using mock data`
      : `${probe.detail} — using mock data`,
  };
}
