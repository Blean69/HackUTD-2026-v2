"use client";
import { useEffect, useMemo, useState } from "react";
import {
  accountMoM, assetAllocation, contributionTracking, debtProfile, healthModel, lastUpdated, monthlyCashFlow, netWorthHistory, netWorthTotals,
  netWorthTrend, recentNetCashFlow, upcomingObligations,
} from "@/lib/finance";
import { useRange } from "@/lib/rangeUi";
import {
  useAccounts, useForecast, useHealth, useHousehold, useMembers, useObligations, useTxns,
} from "./hooks";

/** "Now", refreshed once a minute so relative labels and due dates stay honest without re-rendering constantly. */
export function useNow(everyMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** Every derived number the dashboard and analytics pages need, computed once per data change. */
export function useRoomFinance(householdId: string) {
  const household = useHousehold(householdId);
  const members = useMembers(householdId);
  const accounts = useAccounts(householdId);
  const obligations = useObligations(householdId);
  const txns = useTxns(householdId);
  const health = useHealth(householdId);
  const forecast = useForecast(householdId);
  const { weeks, months } = useRange();
  const now = useNow();
  // Day-granularity key so memoised values don't churn every minute.
  const dayKey = now.toDateString();

  return useMemo(() => {
    const today = new Date(dayKey);
    const property = (household?.home_value ?? 0) + (household?.vehicle_value ?? 0);
    const nw = netWorthTotals(accounts, property);
    const history = netWorthHistory(txns, nw.net, today, weeks);
    const trend = netWorthTrend(history, forecast.points, nw.net);
    const cash = monthlyCashFlow(txns, accounts, obligations, members, today, months);
    const flow = recentNetCashFlow(cash);
    const hm = healthModel(health);
    return {
      household, members, accounts, obligations, txns, health, forecast, property, nw,
      history, trend,
      allocation: assetAllocation(accounts, household),
      cash, flow,
      debt: debtProfile(accounts, members, obligations, health, household),
      healthModel: hm,
      upcoming: upcomingObligations(obligations, today, 8),
      contributions: contributionTracking(members, accounts, flow.value),
      moM: (a: (typeof accounts)[number]) => accountMoM(a, txns, today),
      updatedAt: lastUpdated(health),
      today,
    };
  }, [household, members, accounts, obligations, txns, health, forecast, weeks, months, dayKey]);
}
export type RoomFinance = ReturnType<typeof useRoomFinance>;
