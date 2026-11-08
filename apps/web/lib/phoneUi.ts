"use client";
import { useSyncExternalStore } from "react";

/** Tiny global for the "Call Brian" slide-over, so the header buttons (desktop and phone) can open the one panel the shell mounts. */
let open = false;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
function set(next: boolean) {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}

export const openCallBrian = () => set(true);
export const closeCallBrian = () => set(false);
export function useCallBrianOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}
