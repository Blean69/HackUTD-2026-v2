/**
 * Kids and teens, client side (contracts.md section 12): the same rules as the module's kid reducers, against the in-memory
 * store. Used by the mock engine, and by the live backend while the published module has no `kid_task` / `kid_jar` tables.
 */
import type { KidJar, KidTask } from "@/lib/types";
import type { Actions } from "../backend";
import type { DataStore } from "../store";

type KidActions = Pick<Actions, "addKidTask" | "completeKidTask" | "approveKidTask" | "reopenKidTask" | "deleteKidTask" | "setKidGoal" | "redeemKidGoal">;

export function createLocalKidActions(store: DataStore): KidActions {
  const now = () => new Date().toISOString();
  const credit = (memberId: string, householdId: string, amount: number) => {
    const jar = store.get("kid_jar", memberId);
    const next: KidJar = jar
      ? { ...jar, balance: jar.balance + amount, earned_total: jar.earned_total + Math.max(0, amount), updated_at: now() }
      : { member_id: memberId, household_id: householdId, balance: amount, earned_total: Math.max(0, amount), goal_title: "", goal_target: 0, updated_at: now() };
    store.upsert("kid_jar", next);
  };
  const move = (id: string, from: KidTask["status"], to: KidTask["status"]) => {
    const k = store.get("kid_task", id);
    if (!k || k.status !== from) return undefined;
    store.upsert("kid_task", { ...k, status: to, updated_at: now() });
    return k;
  };
  return {
    addKidTask: async ({ householdId, memberId, title, reward, authorName }) => {
      const id = `kt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      store.upsert("kid_task", { id, household_id: householdId, member_id: memberId, title: title.trim().slice(0, 80), reward: Math.max(0, Math.min(1000, reward)), status: "open", created_by_name: authorName, created_at: now(), updated_at: now() });
    },
    completeKidTask: async (id) => void move(id, "open", "done"),
    approveKidTask: async (id) => {
      const k = move(id, "done", "approved");
      if (k) credit(k.member_id, k.household_id, k.reward);
    },
    reopenKidTask: async (id) => void move(id, "done", "open"),
    deleteKidTask: async (id) => store.remove("kid_task", id),
    setKidGoal: async (householdId, memberId, title, target) => {
      const jar = store.get("kid_jar", memberId);
      const goal = { goal_title: target === 0 ? "" : title.trim().slice(0, 60), goal_target: target, updated_at: now() };
      store.upsert("kid_jar", jar ? { ...jar, ...goal } : { member_id: memberId, household_id: householdId, balance: 0, earned_total: 0, ...goal });
    },
    redeemKidGoal: async (memberId) => {
      const jar = store.get("kid_jar", memberId);
      if (!jar || jar.goal_target <= 0 || jar.balance < jar.goal_target) throw new Error("Not enough saved yet");
      store.upsert("kid_jar", { ...jar, balance: jar.balance - jar.goal_target, goal_title: "", goal_target: 0, updated_at: now() });
    },
  };
}
