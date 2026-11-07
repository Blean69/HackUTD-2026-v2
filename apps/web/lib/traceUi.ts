"use client";
import { useSyncExternalStore } from "react";

/** Tiny global for the trace drawer so any component can open it ("Open full trace", a tool-call chip, ...). */
interface TraceUi {
  open: boolean;
  /** null = follow the latest run for the page. */
  runId: string | null;
}
let state: TraceUi = { open: false, runId: null };
const listeners = new Set<() => void>();
const SERVER = state;

function set(next: TraceUi) {
  state = next;
  for (const l of listeners) l();
}
export function openTrace(runId?: string | null) {
  set({ open: true, runId: runId ?? null });
}
export function closeTrace() {
  set({ ...state, open: false });
}
export function useTraceUi(): TraceUi {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => state,
    () => SERVER,
  );
}
