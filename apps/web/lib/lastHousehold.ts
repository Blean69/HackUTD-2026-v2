"use client";
import { useSyncExternalStore } from "react";
import { DEMO_HOUSEHOLD_ID } from "@/lib/constants";

const KEY = "app.lastHousehold";
let cache: string | null = null;
const listeners = new Set<() => void>();

function read(): string {
  if (cache) return cache;
  try {
    cache = localStorage.getItem(KEY) || DEMO_HOUSEHOLD_ID;
  } catch {
    cache = DEMO_HOUSEHOLD_ID;
  }
  return cache;
}

/** Remember the last room someone was in, so global pages (Agent Trail, Advisor) can keep the sidebar pointing home. */
export function rememberHousehold(id: string) {
  if (!id || id === cache) return;
  cache = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode */
  }
  for (const l of listeners) l();
}

export function useLastHousehold(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    read,
    () => DEMO_HOUSEHOLD_ID,
  );
}
