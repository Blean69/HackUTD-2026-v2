"use client";
import { useSyncExternalStore } from "react";

/**
 * Tiny global for the two right-hand slide-over panels: "Agent activity" (trace) and "Ask Brianotron" (coach).
 * Only one is open at a time. Any component can open them ("Agent analysis" badge, a tool-call chip, ...).
 */
type Panel = "none" | "trace" | "coach";
interface PanelUi {
  panel: Panel;
  /** null = follow the latest run for the page. */
  runId: string | null;
}
let state: PanelUi = { panel: "none", runId: null };
const listeners = new Set<() => void>();
const SERVER = state;

function set(next: PanelUi) {
  state = next;
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function openTrace(runId?: string | null) {
  set({ panel: "trace", runId: runId ?? null });
}
export function closeTrace() {
  if (state.panel === "trace") set({ ...state, panel: "none" });
}
export function openCoach() {
  set({ panel: "coach", runId: state.runId });
}
export function closeCoach() {
  if (state.panel === "coach") set({ ...state, panel: "none" });
}
export function closePanels() {
  if (state.panel !== "none") set({ ...state, panel: "none" });
}

export function useTraceUi(): { open: boolean; runId: string | null } {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER);
  return { open: s.panel === "trace", runId: s.runId };
}
export function useCoachOpen(): boolean {
  return useSyncExternalStore(subscribe, () => state.panel === "coach", () => false);
}
