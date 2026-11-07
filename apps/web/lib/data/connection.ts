"use client";
import { useSyncExternalStore } from "react";

export interface Connection {
  /** idle -> connecting -> ready. `error` only if even the mock fallback failed. */
  status: "idle" | "connecting" | "ready" | "error";
  kind: "mock" | "spacetime" | null;
  /** Human-readable reason, e.g. why we fell back to mocks. */
  detail: string;
  identity: string;
}

let current: Connection = { status: "idle", kind: null, detail: "", identity: "" };
const listeners = new Set<() => void>();
const SERVER: Connection = current;

export function setConnection(next: Partial<Connection>): void {
  current = { ...current, ...next };
  for (const l of listeners) l();
}
export function getConnection(): Connection {
  return current;
}
export function useConnection(): Connection {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => current,
    () => SERVER,
  );
}
