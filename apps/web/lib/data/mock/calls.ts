/**
 * In-app calls from Brian, client side (contracts.md section 13): the same rules as the module's call reducers, against the in-memory
 * store. Used by the mock engine, and by the live backend while the published module has no `incoming_call` table.
 */
import type { IncomingCall } from "@/lib/types";
import type { Actions } from "../backend";
import type { DataStore } from "../store";

type CallActions = Pick<Actions, "requestBrianCall" | "answerBrianCall" | "declineBrianCall" | "expireBrianCall">;
export const RING_SECS = 45;
const COOLDOWN_MS = 20_000;

export function createLocalCallActions(store: DataStore): CallActions {
  const set = (id: string, patch: Partial<IncomingCall>) => {
    const c = store.get("incoming_call", id);
    if (c) store.upsert("incoming_call", { ...c, ...patch });
    return c;
  };
  return {
    requestBrianCall: async (householdId, alertId, _title, source) => {
      const now = Date.now();
      for (const c of store.rows("incoming_call").filter((x) => x.household_id === householdId)) {
        if ((c.status === "ringing" && Date.parse(c.expires_at) > now) || now - Date.parse(c.created_at) < COOLDOWN_MS) return;
      }
      const id = `call_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const alert = alertId ? store.get("alert", alertId) : undefined; // what the screen says is the alert's own title, never client text
      store.upsert("incoming_call", {
        id, household_id: householdId, alert_id: alertId, title: alert?.title.slice(0, 140) || "Brian has a critical alert for you", source,
        status: "ringing", created_at: new Date(now).toISOString(), expires_at: new Date(now + RING_SECS * 1000).toISOString(), answered_by: "", seen_ms: now,
      });
    },
    answerBrianCall: async (callId, displayName) => {
      const c = store.get("incoming_call", callId);
      if (!c) throw new Error("This call has ended");
      if (c.status !== "ringing") throw new Error("This call was already answered or has ended");
      if (Date.parse(c.expires_at) <= Date.now()) {
        set(callId, { status: "missed" });
        throw new Error("This call has ended");
      }
      set(callId, { status: "answered", answered_by: displayName.trim().slice(0, 40) });
    },
    declineBrianCall: async (callId) => void (store.get("incoming_call", callId)?.status === "ringing" && set(callId, { status: "declined" })),
    expireBrianCall: async (callId) => {
      const c = store.get("incoming_call", callId);
      if (c?.status === "ringing" && Date.parse(c.expires_at) <= Date.now()) set(callId, { status: "missed" });
    },
  };
}
