import type { Goal, PresenceRole, ProposalDetails, VoteChoice } from "@/lib/types";

/** What a page needs from the database. Live backends subscribe to just that; the mock ignores it. */
export type DataScope =
  | { kind: "lobby" }
  | { kind: "room"; householdId: string }
  | { kind: "agents" };

/** Room tables a page can ask for on top of the base set (`useRoomTables` in hooks.ts). All are filtered by household_id. */
export type RoomTable =
  | "txn" | "obligation" | "forecast_point" | "goal" | "credit_profile" | "bank_connection"
  | "conversation" | "transcript_line" | "scenario" | "coach_message" | "trace_event" | "proposal" | "vote"
  /** Synthetic credit monitoring (contracts.md section 9); skipped quietly when the published module predates it. */
  | "credit_score" | "credit_score_history"
  /** Kids and teens (contracts.md section 12). */
  | "kid_task" | "kid_jar"
  /** Shared cash numbers (cash_flow, cash_month): same rules as the savings-rate indicator. */
  | "cash_flow" | "cash_month"
  /** The steps of one agent run only: `trace_event@<run_id>`. Cheaper than the whole household's trace. */
  | `trace_event@${string}`;

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
  /** `create_proposal` — also enqueues the affordability `what_if` job. Resolves to the proposal id when known. */
  createProposal(input: { householdId: string; title: string; amount: number; details: ProposalDetails; closesInDays: number; authorName: string }): Promise<string>;
  /** `cast_vote` — one vote per identity; can be changed until the proposal closes. */
  castVote(proposalId: string, choice: VoteChoice, voterName: string): Promise<void>;
  /** `close_proposal` */
  closeProposal(proposalId: string): Promise<void>;
  /** `add_kid_task` — a chore for one kid. */
  addKidTask(input: { householdId: string; memberId: string; title: string; reward: number; authorName: string }): Promise<void>;
  /** `complete_kid_task` — the kid says it is done (open -> done). */
  completeKidTask(taskId: string): Promise<void>;
  /** `approve_kid_task` — a parent confirms (done -> approved) and the reward lands in the jar, once. */
  approveKidTask(taskId: string): Promise<void>;
  /** `reopen_kid_task` — not done yet (done -> open). */
  reopenKidTask(taskId: string): Promise<void>;
  /** `delete_kid_task` */
  deleteKidTask(taskId: string): Promise<void>;
  /** `set_kid_goal` — target 0 clears the goal. */
  setKidGoal(householdId: string, memberId: string, title: string, target: number): Promise<void>;
  /** `redeem_kid_goal` — spend the jar on the goal once it is covered. */
  redeemKidGoal(memberId: string): Promise<void>;
}

export interface Backend {
  kind: "mock" | "spacetime";
  /** The caller's stable identity (Presence.identity of "me"). */
  identity: string;
  actions: Actions;
  /** Switch the active subscription set. Resolves the connection's `synced` flag when the first rows arrive. */
  setScope?(scope: DataScope): void;
  /**
   * Subscribe to extra room tables for one household. Returns the release function; `onApplied` fires once the rows
   * have landed (also when the module lacks a table, so a page never waits forever). Ref-counting lives in runtime.ts.
   */
  subscribeRoomTables?(householdId: string, tables: readonly RoomTable[], onApplied: () => void): () => void;
  dispose(): void;
}
