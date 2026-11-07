"use client";
import { useSyncExternalStore } from "react";
import type { PresenceRole } from "@/lib/types";

const NAME_KEY = "keystone.name";
const ROLE_KEY = "keystone.role";

export interface LocalIdentity {
  /** False during SSR / first paint, so UI can avoid flashing the name prompt. */
  ready: boolean;
  name: string | null;
  /** The role the user picked when they first joined: "family" or "guest". Advisors are set per-page. */
  role: PresenceRole;
}

const SERVER: LocalIdentity = { ready: false, name: null, role: "guest" };
let cache: LocalIdentity = SERVER;
let loaded = false;
const listeners = new Set<() => void>();

function read(): LocalIdentity {
  try {
    const name = localStorage.getItem(NAME_KEY);
    const role = localStorage.getItem(ROLE_KEY) as PresenceRole | null;
    return { ready: true, name: name && name.trim() ? name.trim() : null, role: role === "family" ? "family" : "guest" };
  } catch {
    return cache;
  }
}

function snapshot(): LocalIdentity {
  if (!loaded) {
    cache = read();
    loaded = true;
  }
  return cache;
}

export function setLocalIdentity(name: string, role: PresenceRole): void {
  const clean = name.trim().slice(0, 32);
  cache = { ready: true, name: clean || null, role: role === "family" ? "family" : "guest" };
  loaded = true;
  try {
    localStorage.setItem(NAME_KEY, clean);
    localStorage.setItem(ROLE_KEY, cache.role);
  } catch {
    /* private mode: keep it in memory */
  }
  for (const l of listeners) l();
}

export function useLocalIdentity(): LocalIdentity {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    snapshot,
    () => SERVER,
  );
}

/** Random-ish friendly default, deterministic enough that a refresh does not re-roll it. */
export function suggestName(): string {
  const n = Math.floor(Math.random() * 900 + 100);
  return `Guest ${n}`;
}
