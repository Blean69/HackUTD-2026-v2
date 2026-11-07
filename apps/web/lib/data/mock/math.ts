/**
 * Client-side stand-in for the deterministic `recompute_household` reducer (which runs inside SpacetimeDB).
 * Same inputs, same outputs shape: health indicators + 90-day forecast. Used only by the mock engine.
 */
import { LIABILITY_TYPES } from "@/lib/format";
import type { Account, ForecastPoint, HealthIndicator, HealthStatus, Member, Obligation } from "@/lib/types";

export interface MathCtx {
  accounts: readonly Account[];
  members: readonly Member[];
  obligations: readonly Obligation[];
  /** Everyday spending not captured as obligations (groceries, gas, kids). Per month. */
  varSpend: number;
  /** Net-worth change over 12 months, percent. */
  nwTrend: number;
}

export const NET_FACTOR = 0.78;
const COLLEGE = /college|529|education|school/i;

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function monthlyNetIncome(members: readonly Member[]): number {
  return (members.reduce((s, m) => s + m.income_annual, 0) * NET_FACTOR) / 12;
}

export function fixedMonthly(obligations: readonly Obligation[]): number {
  return obligations.reduce((s, o) => s + (o.kind === "tax" ? o.amount / 12 : o.amount), 0);
}

export function liquidCash(accounts: readonly Account[]): number {
  return accounts.filter((a) => a.type === "checking" || a.type === "savings").reduce((s, a) => s + a.balance, 0);
}

function status(v: number, goodAt: number, watchAt: number, higherIsBetter = true): HealthStatus {
  if (higherIsBetter) return v >= goodAt ? "good" : v >= watchAt ? "watch" : "risk";
  return v <= goodAt ? "good" : v <= watchAt ? "watch" : "risk";
}

export function computeHealth(householdId: string, c: MathCtx, nowIso: string): HealthIndicator[] {
  const net = monthlyNetIncome(c.members);
  const gross = c.members.reduce((s, m) => s + m.income_annual, 0) / 12;
  const fixed = fixedMonthly(c.obligations);
  const outflow = fixed + c.varSpend;
  const liquid = liquidCash(c.accounts);
  const emergencySavings = c.accounts.filter((a) => a.type === "savings" && !COLLEGE.test(a.nickname)).reduce((s, a) => s + a.balance, 0);
  const debtPay = c.accounts.filter((a) => LIABILITY_TYPES.has(a.type)).reduce((s, a) => s + (a.monthly_payment ?? 0), 0);
  const cards = c.accounts.filter((a) => a.type === "credit_card");
  const limits = cards.reduce((s, a) => s + (a.credit_limit ?? 0), 0);
  const util = limits ? (cards.reduce((s, a) => s + a.balance, 0) / limits) * 100 : 0;

  const runway = outflow ? liquid / outflow : 0;
  const ef = fixed + c.varSpend * 0.6 ? emergencySavings / (fixed + c.varSpend * 0.6) : 0;
  const dti = gross ? (debtPay / gross) * 100 : 0;
  const sr = net ? ((net - outflow) / net) * 100 : 0;

  const mk = (key: HealthIndicator["key"], label: string, value: number, unit: HealthIndicator["unit"], st: HealthStatus, explanation: string): HealthIndicator => ({
    id: `${householdId}:${key}`, household_id: householdId, key, label, value: Math.round(value * 10) / 10, unit, status: st, explanation, updated_at: nowIso,
  });

  return [
    mk("liquidity_runway", "Cash runway", runway, "months", status(runway, 4, 2),
      `Checking and savings cover ${runway.toFixed(1)} months of spending. Four or more is comfortable.`),
    mk("emergency_fund", "Emergency fund", ef, "months", status(ef, 3, 1.5),
      `Rainy-day savings cover ${ef.toFixed(1)} months of essentials. The usual target is 3 to 6.`),
    mk("debt_to_income", "Debt-to-income", dti, "pct", status(dti, 36, 43, false),
      `Loan and card payments take ${dti.toFixed(0)}% of gross income. Lenders like to see under 36%.`),
    mk("credit_utilization", "Card utilization", util, "pct", status(util, 30, 50, false),
      util > 30 ? `You're using ${util.toFixed(0)}% of your card limits. Under 30% protects your credit score.` : `You're using ${util.toFixed(0)}% of your card limits, which is healthy.`),
    mk("savings_rate", "Savings rate", sr, "pct", status(sr, 15, 5),
      `You keep about ${sr.toFixed(0)}% of take-home pay after bills and spending. 15% is a strong habit.`),
    mk("net_worth_trend", "Net worth trend", c.nwTrend, "pct", status(c.nwTrend, 0, -2),
      c.nwTrend >= 0 ? `Net worth is up ${c.nwTrend.toFixed(1)}% over the last 12 months.` : `Net worth is down ${Math.abs(c.nwTrend).toFixed(1)}% over the last 12 months.`),
  ];
}

export function computeForecast(householdId: string, c: MathCtx, today: Date, days = 90): ForecastPoint[] {
  const net = monthlyNetIncome(c.members);
  const checking = c.accounts.filter((a) => a.type === "checking").reduce((s, a) => s + a.balance, 0);
  const daily = c.varSpend / 30;
  const pts: ForecastPoint[] = [];
  let bal = checking;
  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    const dom = d.getDate();
    const lastDom = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    let due = 0;
    if (i > 0) {
      if (dom === 1 || dom === 15) bal += net / 2;
      for (const o of c.obligations) {
        if (o.kind === "tax" && d.getMonth() !== 0) continue;
        if (Math.min(o.due_day, lastDom) === dom) {
          due += o.amount;
          bal -= o.amount;
        }
      }
      bal -= daily;
    }
    const date = isoDate(d);
    pts.push({ id: `${householdId}:${date}`, household_id: householdId, date, balance: Math.round(bal * 100) / 100, obligations_due: Math.round(due * 100) / 100 });
  }
  return pts;
}

/** Standard amortised monthly payment. */
export function pmt(principal: number, aprPct: number, nMonths: number): number {
  const r = aprPct / 100 / 12;
  return r === 0 ? principal / nMonths : (principal * r) / (1 - Math.pow(1 + r, -nMonths));
}
