"use client";
import { useEffect, useMemo, useState } from "react";
import {
  HISTORY_MONTHS, HISTORY_WEEKS, cashMonthsFromDb, healthModel, monthlyCashFlow, netWorthHistory, netWorthTotals, netWorthTrend, recentNetCashFlow, upcomingObligations,
} from "@/lib/finance";
import type { RoomTable } from "./backend";
import {
  useAccounts, useCashFlow, useCashMonths, useForecast, useHealth, useHousehold, useMembers, useObligations, useRoomTables, useTxns,
} from "./hooks";

/** "Now", refreshed on an interval for relative labels ("3 min ago"). Use `useToday` for anything date-based. */
export function useNow(everyMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** Today at midnight. Changes once a day, so memoised finance values never churn on a timer. */
export function useToday(): Date {
  const [key, setKey] = useState(() => new Date().toDateString());
  useEffect(() => {
    const t = setInterval(() => setKey((k) => {
      const next = new Date().toDateString();
      return next === k ? k : next;
    }), 60_000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => new Date(key), [key]);
}

/** Net worth totals plus the rows behind them. Accounts and household are in the room base set; nothing extra to load. */
export function useNetWorthSummary(householdId: string) {
  const household = useHousehold(householdId);
  const accounts = useAccounts(householdId);
  const property = (household?.home_value ?? 0) + (household?.vehicle_value ?? 0);
  const nw = useMemo(() => netWorthTotals(accounts, property), [accounts, property]);
  return { household, accounts, property, nw };
}

/** Tables the dashboard model reads on top of the room base set. */
export const FINANCE_TABLES: readonly RoomTable[] = ["txn", "obligation", "forecast_point", "cash_flow", "cash_month"];

/**
 * Every derived number the Dashboard needs. Each derivation is its own memo, so a new transaction recomputes the
 * trend and cash flow but not the health model, and a new alert recomputes nothing here. Registers the tables it reads;
 * `ready` is false until they have arrived.
 */
export function useRoomFinance(householdId: string) {
  const ready = useRoomTables(householdId, FINANCE_TABLES);
  const { household, accounts, property, nw } = useNetWorthSummary(householdId);
  const members = useMembers(householdId);
  const obligations = useObligations(householdId);
  const txns = useTxns(householdId);
  const health = useHealth(householdId);
  const forecast = useForecast(householdId);
  const cashFlow = useCashFlow(householdId); // SpacetimeDB: the one source for monthly cash figures (null in mock mode)
  const cashRows = useCashMonths(householdId);
  const today = useToday();

  const history = useMemo(() => netWorthHistory(txns, nw.net, today, HISTORY_WEEKS), [txns, nw.net, today]);
  const trend = useMemo(() => netWorthTrend(history, forecast.points, nw.net), [history, forecast.points, nw.net]);
  const cash = useMemo(
    () => (cashRows.length ? cashMonthsFromDb(cashRows, cashFlow, today, HISTORY_MONTHS) : monthlyCashFlow(txns, accounts, obligations, members, today, HISTORY_MONTHS)),
    [cashRows, cashFlow, txns, accounts, obligations, members, today],
  );
  // The headline is the 90-day figure from SpacetimeDB (same as the savings-rate indicator and Brian); no change badge, since
  // comparing it with calendar months would mix two windows.
  const flow = useMemo(() => (cashFlow ? { value: Math.round(cashFlow.net_monthly), change: null, basis: 3 } : recentNetCashFlow(cash)), [cashFlow, cash]);
  const hm = useMemo(() => healthModel(health), [health]);
  const upcoming = useMemo(() => upcomingObligations(obligations, today, 8), [obligations, today]);

  return useMemo(
    () => ({ ready, household, members, accounts, obligations, txns, health, forecast, property, nw, history, trend, cash, flow, cashFlow, healthModel: hm, upcoming, today }),
    [ready, household, members, accounts, obligations, txns, health, forecast, property, nw, history, trend, cash, flow, cashFlow, hm, upcoming, today],
  );
}
export type RoomFinance = ReturnType<typeof useRoomFinance>;
