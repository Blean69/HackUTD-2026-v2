import type { Goal, PresenceRole } from "@/lib/types";

/**
 * Everything the UI can do. 1:1 with the client-callable reducers in docs/contracts.md section 3.
 * The mock engine and the SpacetimeDB adapter both implement this; components never talk to either directly.
 */
export interface Actions {
  /** `join_room` — upserts the caller's presence row. household_id "" = lobby. */
  joinRoom(householdId: string, displayName: string, role: PresenceRole): Promise<void>;
  /** `create_sandbox` — copies a seed household; resolves to the new household id (hh_sbx_...). */
  createSandbox(templateHouseholdId: string, displayName: string): Promise<string>;
  /** `start_huddle` — resolves to the new huddle id. */
  startHuddle(householdId: string, consentNames: string[]): Promise<string>;
  /** `append_transcript` — one final phrase. */
  appendTranscript(huddleId: string, speaker: string, text: string): Promise<void>;
  /** `end_huddle` — status -> analyzing and enqueues the huddle agent job. */
  endHuddle(huddleId: string): Promise<void>;
  /** `request_simulation` — resolves to the scenario id (best effort). */
  requestSimulation(householdId: string, prompt: string): Promise<string>;
  /** `ask_coach` */
  askCoach(householdId: string, text: string, authorName: string): Promise<void>;
  /** `ack_alert` */
  ackAlert(alertId: string, displayName: string): Promise<void>;
  /** `post_advisor_note` */
  postAdvisorNote(householdId: string, authorName: string, text: string): Promise<void>;
  /** `upsert_goal` */
  upsertGoal(goal: Partial<Goal> & { household_id: string; title: string }): Promise<void>;
  /** `delete_goal` */
  deleteGoal(goalId: string): Promise<void>;
  /** `request_bank_sync` — enqueues a plaid_sync job for the household. */
  requestBankSync(householdId: string): Promise<void>;
}

export interface Backend {
  kind: "mock" | "spacetime";
  /** The caller's stable identity (Presence.identity of "me"). */
  identity: string;
  actions: Actions;
  dispose(): void;
}
