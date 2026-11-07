"use client";
import { USE_MOCKS } from "@/lib/constants";
import type { Backend } from "./backend";
import { getConnection, setConnection } from "./connection";
import { startMockBackend } from "./mock/engine";
import { connectSpacetime } from "./spacetime";
import { store } from "./store";

let pending: Promise<Backend> | null = null;
let backend: Backend | null = null;

/**
 * Idempotent. Picks the backend once per page load: SpacetimeDB if configured and reachable, otherwise the mock
 * engine. Client-only; it is kicked off by <DataProvider> and awaited by every action.
 */
export function ensureBackend(): Promise<Backend> {
  if (pending) return pending;
  setConnection({ status: "connecting" });
  pending = (async () => {
    let detail = "";
    if (USE_MOCKS) {
      detail = "NEXT_PUBLIC_USE_MOCKS=1";
    } else {
      try {
        const res = await connectSpacetime(store);
        if (res.backend) {
          backend = res.backend;
          setConnection({ status: "ready", kind: "spacetime", detail: "", identity: res.backend.identity });
          return res.backend;
        }
        detail = res.detail;
      } catch (e) {
        detail = e instanceof Error ? e.message : "SpacetimeDB connection failed";
      }
    }
    const mock = startMockBackend(store);
    backend = mock;
    setConnection({ status: "ready", kind: "mock", detail, identity: mock.identity });
    return mock;
  })();
  return pending;
}

export function currentBackend(): Backend | null {
  return backend;
}
export function currentIdentity(): string {
  return getConnection().identity;
}
