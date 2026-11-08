"use client";
import { useMemo } from "react";
import { healthModel, isoDay } from "@/lib/finance";
import { creditViews, derivedCreditAlerts, pastHealth, type CreditView, type DerivedCreditAlert } from "@/lib/finance-credit";
import type { Alert } from "@/lib/types";
import type { RoomTable } from "./backend";
import { useConnection } from "./connection";
import { useToday } from "./finance-hooks";
import { useAccounts, useAlerts, useHealth, useMembers, useObligations, useRoomTables, useRows, useTxns } from "./hooks";
import { liveCreditTables } from "./spacetime";

/** The credit rows (a handful per member). The derived fallback also reads the ledger for its trend. */
const LIVE: readonly RoomTable[] = ["credit_profile", "credit_score", "credit_score_history"];
const DERIVED: readonly RoomTable[] = ["credit_profile", "txn", "obligation"];
const NONE: readonly RoomTable[] = [];

export interface CreditModel {
  ready: boolean;
  views: CreditView[];
  /** Open and recent `credit` alerts from the module, newest first. */
  alerts: Alert[];
  /** Score moves found in the derived history (only when the module has no credit rows for this household). */
  derivedAlerts: DerivedCreditAlert[];
  /** True when every view comes from the module's tables. */
  live: boolean;
  healthScore: number | null;
}

/**
 * Per-member synthetic credit scores (contracts.md section 9). Reads the module's `credit_score` and
 * `credit_score_history` when it has them; otherwise derives the same formula from the credit profile, household health
 * and the last six months of cash flow, and marks the views `derived`.
 */
export function useCredit(householdId: string, opts?: { withHistory?: boolean }): CreditModel {
  // Decide which tables to ask for once the backend is known, so a live room never downloads the ledger by mistake.
  const decided = useConnection().status === "ready";
  const live = decided && liveCreditTables();
  const tables = !decided ? NONE : live ? (opts?.withHistory === false ? LIVE.slice(0, 2) : LIVE) : opts?.withHistory === false ? DERIVED.slice(0, 1) : DERIVED;
  const ready = useRoomTables(householdId, tables);
  const members = useMembers(householdId);
  const accounts = useAccounts(householdId);
  const health = useHealth(householdId);
  const allProfiles = useRows("credit_profile");
  const allScores = useRows("credit_score");
  const allHistory = useRows("credit_score_history");
  const txns = useTxns(householdId);
  const obligations = useObligations(householdId);
  const alerts = useAlerts(householdId);
  const today = useToday();

  const profiles = useMemo(() => allProfiles.filter((p) => p.household_id === householdId), [allProfiles, householdId]);
  const scores = useMemo(() => allScores.filter((p) => p.household_id === householdId), [allScores, householdId]);
  const history = useMemo(() => allHistory.filter((p) => p.household_id === householdId), [allHistory, householdId]);
  const healthScore = useMemo(() => healthModel(health).score, [health]);
  const past = useMemo(
    () => (healthScore === null || scores.length ? [] : pastHealth(healthScore, txns, accounts, obligations, members, today)),
    [healthScore, scores.length, txns, accounts, obligations, members, today],
  );
  const views = useMemo(
    () => creditViews({ members, profiles, scores, history, accounts, healthScore, pastHealth: past, today: isoDay(today) }),
    [members, profiles, scores, history, accounts, healthScore, past, today],
  );
  const creditAlerts = useMemo(() => alerts.filter((a) => a.kind === "credit"), [alerts]);
  const derived = useMemo(() => (views.some((v) => v.source === "derived") ? derivedCreditAlerts(views.filter((v) => v.source === "derived")) : []), [views]);

  return useMemo(
    () => ({ ready, views, alerts: creditAlerts, derivedAlerts: derived, live: views.length > 0 && views.every((v) => v.source === "live"), healthScore }),
    [ready, views, creditAlerts, derived, healthScore],
  );
}
