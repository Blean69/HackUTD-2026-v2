/**
 * Pure derivations behind the dashboard. Everything here is computed in the browser from rows the hooks already
 * deliver (accounts, txns, obligations, health indicators, forecast points). Nothing is stored. Where a number is an
 * estimate the UI labels it "est."
 */
import { LIABILITY_TYPES } from "@/lib/format";
import type { Account, ForecastPoint, Goal, HealthIndicator, HealthKey, HealthStatus, Member, Obligation, Transaction } from "@/lib/types";

const DAY = 86_400_000;
/** Rows beyond this are import errors (the Patels' -$9,999,623 line). They never enter a total. */
export const TXN_CAP = 500_000;
const NET_FACTOR = 0.78;

/** The dashboard trend shows six months of history (that is all the seed data has) and 90 days of forecast. */
export const HISTORY_WEEKS = 26;
export const HISTORY_MONTHS = 6;

export const isoDay = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const parseDay = (s: string): Date => new Date(`${s.slice(0, 10)}T12:00:00`);
const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);

/** Transactions up to today, without impossible amounts. */
export function cleanTxns(txns: readonly Transaction[], today: Date): Transaction[] {
  const t = isoDay(today);
  return txns.filter((x) => x.date <= t && Math.abs(x.amount) <= TXN_CAP);
}

// ------------------------------------------------------------------------------------------------ net worth

export interface NetWorthTotals {
  assets: number;
  liabilities: number;
  net: number;
}
export function netWorthTotals(accounts: readonly Account[], property = 0): NetWorthTotals {
  let assets = property;
  let liabilities = 0;
  for (const a of accounts) {
    if (LIABILITY_TYPES.has(a.type)) liabilities += a.balance;
    else assets += a.balance;
  }
  return { assets, liabilities, net: assets - liabilities };
}

export interface SeriesPoint {
  date: string;
  value: number;
}

/**
 * Weekly net-worth history, reconstructed backwards from today's balance and the transactions since (the same
 * definition the module uses for its net-worth-trend indicator: asset and debt-account amounts move net worth,
 * transfers and loan payments cancel). Starts at the oldest transaction, never earlier.
 */
export function netWorthHistory(txns: readonly Transaction[], netNow: number, today: Date, weeks: number): SeriesPoint[] {
  const clean = cleanTxns(txns, today);
  const end = startOfDay(today);
  if (!clean.length) return [{ date: isoDay(end), value: netNow }];
  const earliest = clean.reduce((m, t) => (t.date < m ? t.date : m), clean[0].date);
  const maxWeeks = Math.max(1, Math.floor((end.getTime() - parseDay(earliest).getTime()) / (7 * DAY)));
  const n = Math.min(weeks, maxWeeks);
  const out: SeriesPoint[] = [];
  for (let k = n; k >= 0; k--) {
    const d = new Date(end.getTime() - k * 7 * DAY);
    const key = isoDay(d);
    let after = 0;
    for (const t of clean) if (t.date > key) after += t.amount;
    out.push({ date: key, value: Math.round(netNow - after) });
  }
  return out;
}

export interface TrendRow {
  date: string;
  actual?: number;
  forecast?: number;
  best?: number;
  worst?: number;
}
export interface TrendModel {
  rows: TrendRow[];
  today: string;
  bestPct: number;
  worstPct: number;
  forecastEnd?: number;
  change: { abs: number; pct: number };
}

/** History + a forward line from the 90-day cash forecast, with best and worst bands (est.). */
export function netWorthTrend(history: readonly SeriesPoint[], forecast: readonly ForecastPoint[], netNow: number): TrendModel {
  const rows: TrendRow[] = history.map((p) => ({ date: p.date, actual: p.value }));
  const first = history[0]?.value ?? netNow;
  const abs = netNow - first;
  const change = { abs, pct: first !== 0 ? (abs / Math.abs(first)) * 100 : 0 };
  const today = history[history.length - 1]?.date ?? isoDay(new Date());
  const last = rows[rows.length - 1];
  const pts = [...forecast].sort((a, b) => a.date.localeCompare(b.date));
  if (!pts.length || !last) return { rows, today, bestPct: 0, worstPct: 0, change };
  last.forecast = netNow;
  last.best = netNow;
  last.worst = netNow;
  const p0 = pts[0];
  const spread = Math.max(Math.abs(netNow), 25_000) * 0.05;
  const t0 = parseDay(today).getTime();
  const span = Math.max(1, parseDay(pts[pts.length - 1].date).getTime() - t0);
  const picks = pts.filter((_, i) => i > 0 && (i % 7 === 0 || i === pts.length - 1));
  let end = netNow;
  for (const p of picks) {
    if (p.date <= today) continue;
    const base = netNow + (p.balance - p0.balance);
    const f = Math.max(0, Math.min(1, (parseDay(p.date).getTime() - t0) / span));
    rows.push({ date: p.date, forecast: Math.round(base), best: Math.round(base + spread * f), worst: Math.round(base - spread * 1.25 * f) });
    end = base;
  }
  const denom = Math.max(Math.abs(netNow), 25_000);
  return { rows, today, forecastEnd: end, bestPct: ((end + spread - netNow) / denom) * 100, worstPct: ((end - spread * 1.25 - netNow) / denom) * 100, change };
}

// ------------------------------------------------------------------------------------------------ cash flow

export interface CashMonth {
  key: string;
  label: string;
  income: number;
  expenses: number;
  net: number;
  forecast: boolean;
}
const INTERNAL = new Set(["transfer", "savings"]);
const MONTH_FMT = new Intl.DateTimeFormat("en-US", { month: "short" });

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function fixedMonthly(obligations: readonly Obligation[]): number {
  return obligations.reduce((s, o) => s + (o.kind === "tax" ? o.amount / 12 : o.amount), 0);
}

/**
 * Completed months from cash accounts (income in, cash out; transfers between own accounts ignored), then the
 * current month and the next ones projected: income from recent deposits (or stated pay), expenses from the
 * obligation schedule plus the usual non-recurring cash spend.
 */
export function monthlyCashFlow(
  txns: readonly Transaction[], accounts: readonly Account[], obligations: readonly Obligation[], members: readonly Member[],
  today: Date, pastMonths: number, futureMonths = 3,
): CashMonth[] {
  const clean = cleanTxns(txns, today);
  const liquid = new Set(accounts.filter((a) => a.type === "checking" || a.type === "savings").map((a) => a.id));
  const byMonth = new Map<string, { income: number; expenses: number; discretionary: number }>();
  for (const t of clean) {
    if (!liquid.has(t.account_id) || INTERNAL.has(t.category)) continue;
    const k = t.date.slice(0, 7);
    const m = byMonth.get(k) ?? { income: 0, expenses: 0, discretionary: 0 };
    if (t.amount > 0) m.income += t.amount;
    else {
      m.expenses += -t.amount;
      if (!t.is_recurring) m.discretionary += -t.amount;
    }
    byMonth.set(k, m);
  }
  const cur = new Date(today.getFullYear(), today.getMonth(), 1, 12);
  const curKey = monthKey(cur);
  const out: CashMonth[] = [];
  const done: { income: number; expenses: number; discretionary: number }[] = [];
  for (let i = pastMonths; i >= 1; i--) {
    const d = new Date(cur.getFullYear(), cur.getMonth() - i, 1, 12);
    const k = monthKey(d);
    const m = byMonth.get(k);
    if (!m) continue; // before the data starts
    done.push(m);
    out.push({ key: k, label: MONTH_FMT.format(d), income: Math.round(m.income), expenses: Math.round(m.expenses), net: Math.round(m.income - m.expenses), forecast: false });
  }
  const recent = done.slice(-3);
  const avg = (f: (m: (typeof done)[number]) => number) => (recent.length ? recent.reduce((s, m) => s + f(m), 0) / recent.length : 0);
  const stated = (members.reduce((s, m) => s + m.income_annual, 0) * NET_FACTOR) / 12;
  const income = avg((m) => m.income) || stated;
  const spend = fixedMonthly(obligations) + avg((m) => m.discretionary);
  const expenses = obligations.length || recent.length ? spend : 0;
  for (let i = 0; i < futureMonths; i++) {
    const d = new Date(cur.getFullYear(), cur.getMonth() + i, 1, 12);
    out.push({ key: monthKey(d), label: MONTH_FMT.format(d), income: Math.round(income), expenses: Math.round(expenses), net: Math.round(income - expenses), forecast: true });
  }
  void curKey;
  return out;
}

/**
 * The same monthly series from the SpacetimeDB rows (cash_month, same rules as the savings-rate indicator): the completed
 * months before the current one, then the current and next months projected at the household's 90-day run rate (cash_flow).
 */
export function cashMonthsFromDb(
  rows: readonly { month: string; income: number; expenses: number; net: number; partial: boolean }[],
  flow: { income_monthly: number; expense_monthly: number } | null, today: Date, pastMonths: number, futureMonths = 3,
): CashMonth[] {
  const cur = new Date(today.getFullYear(), today.getMonth(), 1, 12);
  const byKey = new Map(rows.map((r) => [r.month, r]));
  const out: CashMonth[] = [];
  for (let i = pastMonths; i >= 1; i--) {
    const d = new Date(cur.getFullYear(), cur.getMonth() - i, 1, 12);
    const r = byKey.get(monthKey(d));
    if (!r || r.partial) continue;
    out.push({ key: r.month, label: MONTH_FMT.format(d), income: Math.round(r.income), expenses: Math.round(r.expenses), net: Math.round(r.income) - Math.round(r.expenses), forecast: false });
  }
  if (flow) {
    for (let i = 0; i < futureMonths; i++) {
      const d = new Date(cur.getFullYear(), cur.getMonth() + i, 1, 12);
      const inc = Math.round(flow.income_monthly);
      const exp = Math.round(flow.expense_monthly);
      out.push({ key: monthKey(d), label: MONTH_FMT.format(d), income: inc, expenses: exp, net: inc - exp, forecast: true });
    }
  }
  return out;
}

/** Average net cash flow over the last up-to-3 completed months (steadier than one lumpy month), and the dollar change vs the 3 before. */
export function recentNetCashFlow(months: readonly CashMonth[]): { value: number; change: number | null; basis: number } {
  const actual = months.filter((m) => !m.forecast);
  if (!actual.length) return { value: months[0]?.net ?? 0, change: null, basis: 0 };
  const avg = (xs: readonly CashMonth[]) => xs.reduce((s, m) => s + m.net, 0) / xs.length;
  const recent = actual.slice(-3);
  const before = actual.slice(-6, -3);
  const value = avg(recent);
  return { value: Math.round(value), change: before.length >= 2 ? Math.round(value - avg(before)) : null, basis: recent.length };
}

// ------------------------------------------------------------------------------------------------ health

export interface HealthRow {
  key: HealthKey;
  label: string;
  score: number;
  status: HealthStatus;
  value: number;
  unit: HealthIndicator["unit"];
  explanation: string;
}
export interface HealthModel {
  score: number | null;
  label: string;
  tone: "good" | "watch" | "risk" | "neutral";
  rows: HealthRow[];
}

function interp(x: number, pts: readonly (readonly [number, number])[]): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

function rawScore(h: HealthIndicator): number {
  switch (h.key) {
    case "liquidity_runway":
      return interp(h.value, [[0, 0], [1, 25], [3, 60], [6, 88], [9, 100]]);
    case "emergency_fund": {
      const pct = h.unit === "months" ? (h.value / 3) * 100 : h.value;
      return interp(pct, [[0, 0], [50, 45], [100, 85], [150, 100]]);
    }
    case "debt_to_income":
      return interp(h.value, [[0, 100], [15, 96], [28, 82], [36, 70], [43, 50], [60, 15], [100, 0]]);
    case "credit_utilization":
      return interp(h.value, [[0, 100], [10, 95], [30, 78], [50, 45], [75, 15], [100, 0]]);
    case "savings_rate":
      return interp(h.value, [[-10, 0], [0, 30], [5, 52], [15, 80], [25, 100]]);
    case "net_worth_trend":
      if (h.unit === "usd") return h.status === "good" ? 84 : h.status === "watch" ? 55 : 28;
      return interp(h.value, [[-10, 10], [-2, 45], [0, 65], [5, 82], [12, 100]]);
    case "forecast_low_point":
      return interp(h.value, [[-2000, 0], [0, 30], [1000, 60], [3000, 85], [8000, 100]]);
    case "credit_score":
      return interp(h.value, [[500, 0], [580, 25], [650, 50], [700, 70], [740, 88], [800, 100]]);
    default:
      return h.status === "good" ? 85 : h.status === "watch" ? 58 : 30;
  }
}

/** Score 0-100 for one indicator, kept consistent with the module's own good / watch / risk status. */
export function indicatorScore(h: HealthIndicator): number {
  const s = rawScore(h);
  const v = h.status === "good" ? Math.max(s, 72) : h.status === "watch" ? Math.min(71, Math.max(45, s)) : Math.min(44, s);
  return Math.round(v);
}

export function scoreLabel(score: number): { label: string; tone: "good" | "watch" | "risk" } {
  if (score >= 85) return { label: "Excellent", tone: "good" };
  if (score >= 70) return { label: "Good", tone: "good" };
  if (score >= 55) return { label: "Fair", tone: "watch" };
  if (score >= 40) return { label: "Needs attention", tone: "watch" };
  return { label: "At risk", tone: "risk" };
}

export function healthModel(indicators: readonly HealthIndicator[]): HealthModel {
  const rows: HealthRow[] = indicators.map((h) => ({
    key: h.key, label: h.label, score: indicatorScore(h), status: h.status, value: h.value, unit: h.unit, explanation: h.explanation,
  }));
  if (!rows.length) return { score: null, label: "Calculating", tone: "neutral", rows: [] };
  const score = Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length);
  const l = scoreLabel(score);
  return { score, label: l.label, tone: l.tone, rows };
}

// ------------------------------------------------------------------------------------------------ obligations

export interface UpcomingObligation {
  id: string;
  name: string;
  amount: number;
  kind: Obligation["kind"];
  due: string;
  days: number;
  when: string;
}

export function whenLabel(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

export function upcomingObligations(obligations: readonly Obligation[], today: Date, limit = 8): UpcomingObligation[] {
  const base = startOfDay(today);
  const rows = obligations.map((o) => {
    const lastThis = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    let due = new Date(base.getFullYear(), base.getMonth(), Math.min(o.due_day, lastThis), 12);
    if (due.getTime() < base.getTime()) {
      const lastNext = new Date(base.getFullYear(), base.getMonth() + 2, 0).getDate();
      due = new Date(base.getFullYear(), base.getMonth() + 1, Math.min(o.due_day, lastNext), 12);
    }
    const days = Math.round((due.getTime() - base.getTime()) / DAY);
    return { id: o.id, name: o.name, amount: o.amount, kind: o.kind, due: isoDay(due), days, when: whenLabel(days) };
  });
  return rows.sort((a, b) => a.days - b.days || b.amount - a.amount).slice(0, limit);
}

// ------------------------------------------------------------------------------------------------ goals

/** Same conversation, same quote: a Table Mode rerun re-extracts the goal with a slightly different title. */
const goalKey = (g: Goal): string => {
  const quote = (g.evidence_quote ?? "").replace(/^[\w .'’-]{1,24}:\s*/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 64);
  return quote.length >= 24 ? `q:${quote}` : `t:${g.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
};
/**
 * Collapses goals the agents extracted twice (reruns of the same Table Mode conversation). Keeps the one that is
 * furthest along (has a target and a feasibility verdict, then newest) and preserves the incoming order.
 */
export function dedupeGoals(goals: readonly Goal[]): Goal[] {
  const rank = (g: Goal) => (g.target_amount ? 2 : 0) + (g.feasibility ? 1 : 0);
  const best = new Map<string, Goal>();
  for (const g of goals) {
    const k = goalKey(g);
    const cur = best.get(k);
    if (!cur || rank(g) > rank(cur) || (rank(g) === rank(cur) && (g.updated_at || g.created_at) > (cur.updated_at || cur.created_at))) best.set(k, g);
  }
  return goals.filter((g) => best.get(goalKey(g)) === g);
}

export interface GoalProgress {
  saved: number;
  pct: number;
  basis: "account" | "pace";
}

const GOAL_MATCH: { re: RegExp; acct: RegExp }[] = [
  { re: /college|529|education|school/i, acct: /college|529|education|school/i },
  { re: /emergency|rainy|cushion/i, acct: /emergency|rainy|savings/i },
  { re: /down\s*payment|house|home\b/i, acct: /down|home|house/i },
  { re: /vacation|trip|travel|hawaii|wedding/i, acct: /vacation|travel|trip|wedding/i },
  { re: /car|vehicle|van|truck/i, acct: /car|vehicle|auto/i },
];
const PACE = { on_track: 1, stretch: 0.6, off_track: 0.3, "": 0.45 } as const;

/** Estimated funded amount: a matching savings account if there is one, otherwise how far along the timeline is. */
export function goalProgress(goal: Goal, accounts: readonly Account[], now: Date): GoalProgress | null {
  const target = goal.target_amount ?? 0;
  if (target <= 0) return null;
  for (const m of GOAL_MATCH) {
    if (!m.re.test(goal.title)) continue;
    const hit = accounts.filter((a) => (a.type === "savings" || a.type === "cd") && m.acct.test(a.nickname));
    const saved = hit.reduce((s, a) => s + a.balance, 0);
    if (hit.length && saved > 0) return { saved: Math.min(saved, target), pct: Math.min(100, (saved / target) * 100), basis: "account" };
  }
  const start = new Date(goal.created_at).getTime();
  const end = goal.target_date ? parseDay(goal.target_date).getTime() : start + 365 * DAY;
  const frac = Math.max(0.04, Math.min(0.97, (now.getTime() - start) / Math.max(DAY, end - start)));
  const pct = Math.min(95, frac * 100 * PACE[goal.feasibility || ""]);
  return { saved: Math.round((target * pct) / 100), pct, basis: "pace" };
}

// ------------------------------------------------------------------------------------------------ votes / proposals helpers

export function daysLeft(closesAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(closesAt).getTime() - now) / DAY));
}
