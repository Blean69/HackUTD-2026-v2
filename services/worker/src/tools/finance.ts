// Pure household finance helpers shared by tools and workflows. No I/O.
import type { Account, HouseholdData, Txn } from '../types.js';
import { DAYS_PER_MONTH, MS_DAY, formatDay, parseDay, round2 } from '../util.js';

export const LIQUID_TYPES = new Set(['checking', 'savings']);
export const SAVINGS_TYPES = new Set(['savings', 'cd']);
export const DEBT_TYPES = new Set(['auto_loan', 'personal_loan', 'credit_card', 'mortgage']);
/** Moves between the household's own accounts; excluded from income/spending math. */
const INTERNAL_CATEGORIES = new Set(['transfer', 'savings']);
export const IMPOSSIBLE_AMOUNT = 1_000_000;

export function accountsOfType(data: HouseholdData, types: Set<string>): Account[] {
  return data.accounts.filter((a) => types.has(a.type));
}
export const liquidBalance = (data: HouseholdData): number => round2(accountsOfType(data, LIQUID_TYPES).reduce((s, a) => s + a.balance, 0));
export const savingsBalance = (data: HouseholdData): number => round2(accountsOfType(data, SAVINGS_TYPES).reduce((s, a) => s + a.balance, 0));
export const totalDebt = (data: HouseholdData): number => round2(accountsOfType(data, DEBT_TYPES).reduce((s, a) => s + a.balance, 0));
export const totalAssets = (data: HouseholdData): number =>
  round2(data.accounts.filter((a) => !DEBT_TYPES.has(a.type)).reduce((s, a) => s + a.balance, 0));

/** Transactions that are safe to do math on: parseable date, not in the future, not an obviously impossible amount. */
export function usableTxns(data: HouseholdData): Txn[] {
  const today = parseDay(data.asOf) ?? Infinity;
  return data.txns.filter((t) => {
    const d = parseDay(t.date);
    return d !== null && d <= today && Number.isFinite(t.amount) && Math.abs(t.amount) < IMPOSSIBLE_AMOUNT;
  });
}

export interface CashFlow {
  window_days: number;
  monthly_in: number;
  monthly_out: number;
  monthly_net: number;
  /** Average monthly outflow for the largest categories (positive numbers). */
  top_outflow_categories: { category: string; monthly: number }[];
}

/**
 * Cash-basis monthly flow over the last `days` days on checking + savings accounts, ignoring transfers between
 * the household's own accounts. Credit-card spending shows up when the card is paid from checking.
 */
export function cashFlow(data: HouseholdData, days = 90): CashFlow {
  const liquidIds = new Set(accountsOfType(data, LIQUID_TYPES).map((a) => a.id));
  const end = parseDay(data.asOf) ?? 0;
  const start = end - days;
  let inflow = 0;
  let outflow = 0;
  let first = end;
  const cats = new Map<string, number>();
  for (const t of usableTxns(data)) {
    if (!liquidIds.has(t.account_id) || INTERNAL_CATEGORIES.has(t.category)) continue;
    const d = parseDay(t.date)!;
    if (d <= start || d > end) continue;
    if (d < first) first = d;
    if (t.amount >= 0) inflow += t.amount;
    else {
      outflow += -t.amount;
      cats.set(t.category, (cats.get(t.category) ?? 0) - t.amount);
    }
  }
  const span = Math.max(30, Math.min(days, end - first + 1));
  const months = span / DAYS_PER_MONTH;
  return {
    window_days: span,
    monthly_in: round2(inflow / months),
    monthly_out: round2(outflow / months),
    monthly_net: round2((inflow - outflow) / months),
    top_outflow_categories: [...cats.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, v]) => ({ category, monthly: round2(v / months) })),
  };
}

/** Standard amortizing payment. apr in percent. */
export function pmt(principal: number, aprPct: number, termMonths: number): number {
  if (principal <= 0 || termMonths <= 0) return 0;
  const r = aprPct / 100 / 12;
  if (r === 0) return round2(principal / termMonths);
  return round2((principal * r) / (1 - (1 + r) ** -termMonths));
}

/** Interest paid over the first `months` payments of an amortizing loan. */
export function interestOverWindow(principal: number, aprPct: number, payment: number, months: number): number {
  let bal = principal;
  let interest = 0;
  const r = aprPct / 100 / 12;
  for (let m = 0; m < months && bal > 0.005; m++) {
    const i = bal * r;
    interest += i;
    bal = Math.max(0, bal + i - payment);
  }
  return round2(interest);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = parseDay(fromIso);
  const b = parseDay(toIso);
  return a === null || b === null ? 0 : b - a;
}

export function isoPlusDays(iso: string, days: number): string {
  const d = parseDay(iso);
  return d === null ? iso : formatDay(d + days);
}

export { MS_DAY };
