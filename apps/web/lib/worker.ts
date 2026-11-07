"use client";
import { useSyncExternalStore } from "react";
import { WORKER_URL } from "@/lib/constants";

export type WorkerStatus = "checking" | "up" | "down";

let status: WorkerStatus = "checking";
let started = false;
let checkedAt = 0;
const listeners = new Set<() => void>();

function set(s: WorkerStatus) {
  status = s;
  checkedAt = Date.now();
  for (const l of listeners) l();
}

/** Pings the agent worker's /health. Cached; re-checks at most every 20 s. */
export function checkWorker(force = false): void {
  if (started && !force && Date.now() - checkedAt < 20000) return;
  started = true;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  fetch(`${WORKER_URL}/health`, { signal: ctl.signal })
    .then((r) => set(r.ok ? "up" : "down"))
    .catch(() => set("down"))
    .finally(() => clearTimeout(t));
}

export function useWorkerStatus(): WorkerStatus {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => status,
    () => "checking" as const,
  );
}

export async function workerPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; detail?: string };
      msg = j.error ?? j.detail ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}
