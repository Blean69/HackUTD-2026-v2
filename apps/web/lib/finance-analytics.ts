/**
 * Spending and cash-flow derivations for the Analytics page and the My Picture ledger. Pure functions over rows the
 * hooks already deliver; nothing is stored.
 */
import { cleanTxns, isoDay, type CashMonth } from "@/lib/finance";
import type { Account, Transaction } from "@/lib/types";

const DAY = 86_400_000;
/** Money moving between the household's own accounts is not spending. */
export const NOT_SPENDING = new Set(["transfer", "savings", "credit_card_payment", "loan_payment", "mortgage"]);
const NOT_A_CHARGE = new Set(["transfer", "savings", "credit_card_payment"]);

export const categoryLabel = (c: string) => {
  const s = c.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Other";
};

export interface SpendCategory {
  category: string;
  value: number;
  /** Share of total spending, 0-100. */
  share: number;
}
export interface SpendMerchant {
  merchant: string;
  total: number;
  count: number;
  category: string;
}
export interface SpendingBreakdown {
  days: number;
  total: number;
  categories: SpendCategory[];
  merchants: SpendMerchant[];
  recurringCount: number;
  recurringMonthly: number;
}

/**
 * The breakdown with its total and categories taken from SpacetimeDB's cash_flow (same rules as the savings-rate indicator:
 * card purchases counted once, own transfers skipped, refunds netted), so the donut adds up to the monthly spending shown
 * everywhere else. Merchants and recurring charges stay as derived here. Without the row (mock mode) it is returned unchanged.
 */
export function withSharedSpending(
  spend: SpendingBreakdown, flow: { window_days: number; categories: { category: string; total: number }[] } | null, top = 8,
): SpendingBreakdown {
  if (!flow || !flow.categories.length) return spend;
  const total = flow.categories.reduce((s, c) => s + c.total, 0);
  return {
    ...spend,
    days: flow.window_days,
    total,
    categories: flow.categories.slice(0, top).map((c) => ({ category: c.category, value: c.total, share: total ? (c.total / total) * 100 : 0 })),
  };
}

/** Outflows over the last `days` by category and merchant, plus the recurring charges among them. */
export function spendingBreakdown(txns: readonly Transaction[], today: Date, days = 90, top = 8): SpendingBreakdown {
  const from = isoDay(new Date(today.getTime() - days * DAY));
  const byCat = new Map<string, number>();
  const byMerchant = new Map<string, { total: number; count: number; cats: Map<string, number> }>();
  const recurring = new Map<string, number>();
  let total = 0;
  for (const t of cleanTxns(txns, today)) {
    if (t.date <= from || t.amount >= 0) continue;
    const amt = -t.amount;
    if (t.is_recurring && !NOT_A_CHARGE.has(t.category)) recurring.set(t.merchant, (recurring.get(t.merchant) ?? 0) + amt);
    if (NOT_SPENDING.has(t.category)) continue;
    total += amt;
    byCat.set(t.category, (byCat.get(t.category) ?? 0) + amt);
    const m = byMerchant.get(t.merchant) ?? { total: 0, count: 0, cats: new Map<string, number>() };
    m.total += amt;
    m.count += 1;
    m.cats.set(t.category, (m.cats.get(t.category) ?? 0) + amt);
    byMerchant.set(t.merchant, m);
  }
  const months = days / 30;
  return {
    days,
    total,
    categories: [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([category, value]) => ({ category, value, share: total ? (value / total) * 100 : 0 })),
    merchants: [...byMerchant.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, top).map(([merchant, m]) => ({
      merchant, total: m.total, count: m.count, category: [...m.cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
    })),
    recurringCount: recurring.size,
    recurringMonthly: [...recurring.values()].reduce((s, v) => s + v, 0) / months,
  };
}

export interface CashSummary {
  months: number;
  avgNet: number | null;
  avgIncome: number | null;
  avgExpenses: number | null;
  /** Net cash flow as a share of income over the completed months, 0-100. */
  savingsRate: number | null;
}
export function cashSummary(cash: readonly CashMonth[]): CashSummary {
  const done = cash.filter((m) => !m.forecast);
  if (!done.length) return { months: 0, avgNet: null, avgIncome: null, avgExpenses: null, savingsRate: null };
  const income = done.reduce((s, m) => s + m.income, 0);
  const expenses = done.reduce((s, m) => s + m.expenses, 0);
  const net = income - expenses;
  return { months: done.length, avgNet: net / done.length, avgIncome: income / done.length, avgExpenses: expenses / done.length, savingsRate: income > 0 ? (net / income) * 100 : null };
}

export interface LedgerRow {
  id: string;
  date: string;
  merchant: string;
  category: string;
  amount: number;
  account: string;
  recurring: boolean;
}
/** Newest transactions first, with the account nickname. Impossible amounts (import errors) stay out. */
export function recentLedger(txns: readonly Transaction[], accounts: readonly Account[], today: Date, limit: number, accountId?: string): { rows: LedgerRow[]; total: number } {
  const nick = new Map(accounts.map((a) => [a.id, a.nickname]));
  const all = cleanTxns(txns, today)
    .filter((t) => !accountId || t.account_id === accountId)
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return {
    total: all.length,
    rows: all.slice(0, limit).map((t) => ({
      id: t.id, date: t.date, merchant: t.merchant || t.description || "Transaction", category: t.category, amount: t.amount,
      account: nick.get(t.account_id) ?? "", recurring: t.is_recurring,
    })),
  };
}
