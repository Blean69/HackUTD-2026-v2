"use client";
/**
 * "Call Brian by phone" data layer (docs/contracts.md section 8): whether a household has set its 5-digit phone code, and the two
 * reducers that change it (`set_phone_pin`, `clear_phone_pin`).
 *
 * `phone_access_status` (household_id, has_pin, updated_at) is not in the shared store; like the onboarding tables it lives in a small
 * table here, fed by the live connection. The code itself is never kept: it goes from the input boxes straight into the reducer call,
 * and the database stores only a salted hash. There is no mock: without a live SpacetimeDB the phone line has nothing to talk to.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { friendlyPhoneError } from "@/lib/phone";
import { ensureBackend } from "./runtime";
import { liveConnection } from "./spacetime";

export interface PhoneStatus {
  household_id: string;
  has_pin: boolean;
  updated_at: string;
}

/**
 * - `loading`      connecting, or the first rows have not arrived
 * - `ready`        live and subscribed (`hasPin` says whether a code exists)
 * - `offline`      running on the in-browser demo data: nothing to save a code into
 * - `unsupported`  the connected database was published before the phone feature
 */
export type PhoneAccessPhase = "loading" | "ready" | "offline" | "unsupported";
export interface PhoneAccess {
  phase: PhoneAccessPhase;
  hasPin: boolean;
  /** ISO time the code last changed, when one is set. */
  updatedAt?: string;
}

// ------------------------------------------------------------------------------------------------ tiny store

type Rec = Record<string, unknown>;
const status = new Map<string, PhoneStatus>();
/** Households whose row set has arrived, counted per mounted subscriber so one unmount does not hide the others' data. */
const applied = new Map<string, number>();
let support: "unknown" | "live" | "mock" | "unsupported" = "unknown";
let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const getVersion = () => version;

const stamp = (v: unknown): string => (v && typeof v === "object" && "toDate" in v ? (v as { toDate(): Date }).toDate().toISOString() : new Date().toISOString());
function mapStatus(r: Rec): PhoneStatus {
  return { household_id: String(r.householdId ?? ""), has_pin: r.hasPin === true, updated_at: stamp(r.updatedAt) };
}

interface Tbl {
  onInsert(cb: (ctx: unknown, row: Rec) => void): void;
  onUpdate(cb: (ctx: unknown, oldRow: Rec, newRow: Rec) => void): void;
  onDelete(cb: (ctx: unknown, row: Rec) => void): void;
}
type Conn = NonNullable<ReturnType<typeof liveConnection>>;
type ReducerFn = (args: Rec) => Promise<unknown>;

const supportsPhone = (conn: Conn): boolean =>
  !!(conn.db as unknown as Rec).phoneAccessStatus && typeof (conn.reducers as unknown as Rec).setPhonePin === "function";

const wired = new WeakSet<object>();
function wire(conn: Conn): void {
  if (wired.has(conn)) return;
  wired.add(conn);
  const t = (conn.db as unknown as Record<string, Tbl>).phoneAccessStatus;
  const put = (r: Rec) => {
    const s = mapStatus(r);
    status.set(s.household_id, s);
    bump();
  };
  t.onInsert((_c, r) => put(r));
  t.onUpdate((_c, _o, r) => put(r));
  t.onDelete((_c, r) => {
    status.delete(mapStatus(r).household_id);
    bump();
  });
}

const safeId = (s: string) => s.replace(/[^\w:.-]/g, "");

// ------------------------------------------------------------------------------------------------ hook

/** The household's phone-code status. Subscribes to just that household's row while the component is mounted. */
export function usePhoneAccess(householdId: string | undefined): PhoneAccess {
  useEffect(() => {
    if (!householdId) return;
    let cancelled = false;
    let counted = false;
    let handle: { unsubscribe(): void } | undefined;
    void ensureBackend().then((backend) => {
      if (cancelled) return;
      const conn = backend.kind === "spacetime" ? liveConnection() : null;
      if (!conn) {
        support = "mock";
        bump();
        return;
      }
      if (!supportsPhone(conn)) {
        support = "unsupported";
        bump();
        return;
      }
      wire(conn);
      support = "live";
      bump();
      const done = () => {
        if (cancelled || counted) return;
        counted = true;
        applied.set(householdId, (applied.get(householdId) ?? 0) + 1);
        bump();
      };
      try {
        handle = conn
          .subscriptionBuilder()
          .onApplied(done)
          .onError(() => {
            // The module is live but has no such table (published before this feature): say so instead of spinning.
            support = "unsupported";
            bump();
          })
          .subscribe([`SELECT * FROM phone_access_status WHERE household_id = '${safeId(householdId)}'`]);
      } catch {
        support = "unsupported";
        bump();
      }
    });
    return () => {
      cancelled = true;
      try {
        handle?.unsubscribe();
      } catch {
        /* already ended */
      }
      if (counted) {
        const left = (applied.get(householdId) ?? 1) - 1;
        if (left > 0) applied.set(householdId, left);
        else applied.delete(householdId);
      }
    };
  }, [householdId]);

  const v = useSyncExternalStore(subscribe, getVersion, () => 0);
  return useMemo(() => {
    void v; // re-derive whenever the store changes
    if (support === "mock") return { phase: "offline", hasPin: false };
    if (support === "unsupported") return { phase: "unsupported", hasPin: false };
    if (!householdId || support !== "live" || !applied.has(householdId)) return { phase: "loading", hasPin: false };
    const s = status.get(householdId);
    return { phase: "ready", hasPin: !!s?.has_pin, updatedAt: s?.has_pin ? s.updated_at : undefined };
  }, [v, householdId]);
}

// ------------------------------------------------------------------------------------------------ actions

async function call(name: "setPhonePin" | "clearPhonePin", args: Rec): Promise<void> {
  await ensureBackend();
  const conn = liveConnection();
  const fn = (conn?.reducers as unknown as Record<string, ReducerFn | undefined> | undefined)?.[name];
  if (!conn || !fn) throw new Error("not ready");
  await fn.call(conn.reducers, args);
}

/** `set_phone_pin`. Rejects with a sentence fit to show the user. The digits are not kept anywhere. */
export async function setPhoneCode(householdId: string, pin: string): Promise<void> {
  try {
    await call("setPhonePin", { householdId, pin });
  } catch (e) {
    throw new Error(friendlyPhoneError(e));
  }
  status.set(householdId, { household_id: householdId, has_pin: true, updated_at: new Date().toISOString() });
  bump();
}

/** `clear_phone_pin`: switch the household's phone code off. */
export async function clearPhoneCode(householdId: string): Promise<void> {
  try {
    await call("clearPhonePin", { householdId });
  } catch (e) {
    throw new Error(friendlyPhoneError(e));
  }
  status.set(householdId, { household_id: householdId, has_pin: false, updated_at: new Date().toISOString() });
  bump();
}
