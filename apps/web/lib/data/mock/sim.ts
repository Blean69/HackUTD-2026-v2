/**
 * Pure helpers behind the mock agents: goal extraction + feasibility, what-if simulation, scam screening.
 * In the real system these are the worker's tools; here they just have to return plausible, internally
 * consistent numbers from the household's own data.
 */
import { LIABILITY_TYPES, longDate, shortDate, usd } from "@/lib/format";
import type {
  Account, Alert, Feasibility, ForecastPoint, Goal, GoalPriority, HealthIndicator, Member, Obligation,
  ScenarioResult,
} from "@/lib/types";
import { addDays, computeForecast, fixedMonthly, isoDate, liquidCash, monthlyNetIncome, pmt } from "./math";

export interface SimCtx {
  hid: string;
  accounts: readonly Account[];
  members: readonly Member[];
  obligations: readonly Obligation[];
  health: readonly HealthIndicator[];
  forecast: readonly ForecastPoint[];
  alerts: readonly Alert[];
  goals: readonly Goal[];
  varSpend: number;
  now: Date;
}

export function monthlyOutflow(c: SimCtx): number {
  return fixedMonthly(c.obligations) + c.varSpend;
}
export function monthlySurplus(c: SimCtx): number {
  return monthlyNetIncome(c.members) - monthlyOutflow(c);
}
export function lowPoint(points: readonly { date: string; balance: number }[]): { date: string; balance: number } {
  let low = points[0];
  for (const p of points) if (p.balance < low.balance) low = p;
  return { date: low.date, balance: low.balance };
}

// ------------------------------------------------------------------------------------------ goals

interface GoalRule {
  id: string;
  re: RegExp;
  title: (c: SimCtx) => string;
  amount: (c: SimCtx) => number;
  months: number;
  priority: GoalPriority;
  financeable?: boolean;
}

function topCard(c: SimCtx): Account | undefined {
  return [...c.accounts].filter((a) => a.type === "credit_card").sort((a, b) => b.balance - a.balance)[0];
}

const RULES: GoalRule[] = [
  { id: "second", re: /(second|2nd|another|new)\s+(bakery\s+)?(location|bakery|shop|store)|open(ing)?\s+a\s+second|\bexpand/i, title: () => "Open a second bakery location", amount: () => 85000, months: 8, priority: "high", financeable: true },
  { id: "visa", re: /(pay(ing)?\s+(it\s+)?(off|down)|get rid of|wipe out|gone)[^.]*\b(visa|credit card|card|debt)\b|\b(visa|card)\b[^.]*\b(paid off|gone|off)\b/i, title: (c) => `Pay off the ${/visa/i.test(topCard(c)?.nickname ?? "") ? "Visa" : "credit card"}`, amount: (c) => topCard(c)?.balance ?? 5000, months: 5, priority: "high" },
  { id: "emergency", re: /emergency fund|rainy day|cushion|months of (expenses|savings)/i, title: () => "Build a 6-month emergency fund", amount: (c) => Math.round((fixedMonthly(c.obligations) + c.varSpend * 0.6) * 6), months: 14, priority: "medium" },
  { id: "college", re: /college|tuition fund|529|university/i, title: () => "Start a college fund", amount: () => 20000, months: 21, priority: "medium" },
  { id: "care", re: /care fund|blood pressure|cardiolog|medicine|prescription|caregiv|assisted living/i, title: (c) => { const g = c.members.find((m) => m.role === "grandparent"); return g ? `Care fund for ${g.name.split(" ")[0]}` : "Family care fund"; }, amount: () => 3600, months: 12, priority: "medium" },
  { id: "vehicle", re: /(buy|get|replace|purchase)[^.]{0,40}\b(van|car|truck|vehicle|suv)\b/i, title: () => "Buy a vehicle", amount: () => 28000, months: 5, priority: "medium", financeable: true },
  { id: "down", re: /down payment|first home|buy a (house|home)/i, title: () => "Save a home down payment", amount: () => 40000, months: 24, priority: "high" },
  { id: "loans", re: /student loans?/i, title: () => "Pay off student loans", amount: () => 38400, months: 30, priority: "high" },
  { id: "trip", re: /vacation|\btrip\b|travel/i, title: () => "Family trip fund", amount: () => 4500, months: 9, priority: "low" },
  { id: "home", re: /\broof\b|remodel|renovat|\brepairs?\b/i, title: () => "Home repair fund", amount: () => 14000, months: 10, priority: "medium", financeable: true },
];

export interface ExtractedGoal {
  rule: string;
  title: string;
  amount: number;
  date: string;
  priority: GoalPriority;
  quote: string;
  financeable: boolean;
}

function parseAmount(sentence: string): number | undefined {
  const m = sentence.match(/\$\s?([\d,]+(?:\.\d+)?)\s?(k|K)?/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  return m[2] ? n * 1000 : n;
}

export function extractGoals(lines: { speaker: string; text: string }[], c: SimCtx): ExtractedGoal[] {
  const sentences = lines.flatMap((l) => l.text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean));
  const out: ExtractedGoal[] = [];
  for (const rule of RULES) {
    const hit = sentences.find((s) => rule.re.test(s));
    if (!hit) continue;
    const quote = hit.length > 150 ? `${hit.slice(0, 147)}...` : hit;
    // Only trust a dollar amount from the matched sentence for goals where the amount IS the goal.
    const spoken = ["second", "vehicle", "down", "trip", "home"].includes(rule.id) ? parseAmount(hit) : undefined;
    out.push({
      rule: rule.id, title: rule.title(c), amount: Math.round(spoken ?? rule.amount(c)), date: isoDate(addDays(c.now, rule.months * 30)),
      priority: rule.priority, quote, financeable: !!rule.financeable,
    });
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

export function assessGoal(g: ExtractedGoal, c: SimCtx): { feasibility: Feasibility; reason: string } {
  const liquid = liquidCash(c.accounts);
  const usable = liquid * 0.6;
  const monthsLeft = Math.max(1, Math.round((new Date(g.date).getTime() - c.now.getTime()) / (30 * 86400000)));
  const surplus = monthlySurplus(c);
  const need = g.amount / monthsLeft;
  if (g.amount <= usable) return { feasibility: "on_track", reason: `${usd(g.amount)} fits inside the ${usd(usable)} of cash you could use without dipping below a safe buffer.` };
  if (g.financeable && g.amount - usable <= 150000) {
    return { feasibility: "stretch", reason: `Needs ${usd(g.amount)}; ${usd(usable)} is usable cash, so about ${usd(g.amount - usable)} would have to be financed.` };
  }
  if (need <= Math.max(0, surplus) + 1500) return { feasibility: "stretch", reason: `Saving ${usd(need)}/mo for ${monthsLeft} months is above today's ${usd(Math.max(0, surplus))}/mo surplus, but within reach with trims.` };
  return { feasibility: "off_track", reason: `Needs ${usd(need)}/mo for ${monthsLeft} months vs a ${usd(Math.max(0, surplus))}/mo surplus.` };
}

// ------------------------------------------------------------------------------------------ scam screen

const SCAM_SIGNALS: { re: RegExp; label: string }[] = [
  { re: /gift cards?/i, label: "gift cards as payment" },
  { re: /(don'?t|not to) tell|keep it (a )?secret|no one else|anyone or/i, label: "secrecy demanded" },
  { re: /right away|immediately|today or|before (midnight|tonight)|urgent/i, label: "artificial urgency" },
  { re: /microsoft|irs\b|social security|medicare|tech(nical)? support|your bank/i, label: "impersonates an authority" },
  { re: /install (a )?program|remote access|anydesk|teamviewer|look at the computer/i, label: "remote-access request" },
  { re: /bail|in jail|arrested|car accident/i, label: "family-emergency pretext" },
];

export function screenForScam(text: string): string[] {
  return SCAM_SIGNALS.filter((s) => s.re.test(text)).map((s) => s.label);
}

// ------------------------------------------------------------------------------------------ what-if

export interface ParsedScenario {
  kind: "purchase" | "new_loan" | "payoff" | "income_change";
  label: string;
  upfront: number;
  startIdx: number;
  startDate: string;
  monthly: number;
  relief: number;
  income: number;
  apr?: number;
  principal?: number;
  termMonths?: number;
  note: string;
  interestSavedYear?: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function dateFromPrompt(prompt: string, now: Date, fallbackDays: number): Date {
  const m = prompt.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (m) {
    const mi = MONTHS.indexOf(m[1]);
    let d = new Date(now.getFullYear(), mi, 1, 12);
    if (d <= now) d = new Date(now.getFullYear() + 1, mi, 1, 12);
    return d;
  }
  return addDays(now, fallbackDays);
}

export function parseScenario(prompt: string, c: SimCtx): ParsedScenario {
  const p = prompt.toLowerCase();
  const spoken = parseAmount(prompt);
  const dayIdx = (d: Date) => Math.max(1, Math.round((d.getTime() - c.now.getTime()) / 86400000));

  if (/pay(ing)?\s*(it\s*)?(off|down)|payoff|pay off/.test(p)) {
    const wanted = /visa/.test(p) ? "visa" : /discover/.test(p) ? "discover" : "";
    const cards = c.accounts.filter((a) => a.type === "credit_card");
    const card = cards.find((a) => wanted && a.nickname.toLowerCase().includes(wanted)) ?? [...cards].sort((a, b) => (b.rate_pct ?? 0) - (a.rate_pct ?? 0))[0] ?? c.accounts.find((a) => LIABILITY_TYPES.has(a.type) && a.type !== "mortgage");
    const bal = spoken ?? card?.balance ?? 5000;
    const startDate = addDays(c.now, 2);
    return {
      kind: "payoff", label: `Pay off ${card?.nickname ?? "the balance"} (${usd(bal)})`, upfront: bal, startIdx: 2, startDate: isoDate(startDate),
      monthly: 0, relief: card?.monthly_payment ?? 0, income: 0, apr: card?.rate_pct,
      note: `Paying ${usd(bal)} at ${card?.rate_pct ?? 0}% APR frees ${usd(card?.monthly_payment ?? 0)}/mo.`,
      interestSavedYear: Math.round(bal * ((card?.rate_pct ?? 0) / 100)),
    };
  }
  if (/car|van|truck|vehicle|suv/.test(p)) {
    const price = spoken ?? 28000;
    const d = dateFromPrompt(prompt, c.now, 30);
    const down = Math.round(price * 0.2 + 900);
    const principal = price - Math.round(price * 0.2);
    const monthly = Math.round(pmt(principal, 7.1, 60));
    return { kind: "purchase", label: `Buy a ${usd(price)} vehicle on ${shortDate(isoDate(d))}`, upfront: down, startIdx: dayIdx(d), startDate: isoDate(d), monthly, relief: 0, income: 0, apr: 7.1, principal, termMonths: 60,
      note: `20% down plus fees (${usd(down)}), then ${usd(monthly)}/mo for 60 months at ~7.1%.` };
  }
  if (/second|2nd|another|new location|expand|open(ing)?\b/.test(p)) {
    const total = spoken && spoken > 20000 ? spoken : 85000;
    const principal = Math.round(total * 0.75);
    const monthly = Math.round(pmt(principal, 9.5, 120));
    const d = dateFromPrompt(prompt, c.now, 45);
    return { kind: "new_loan", label: `Open a second location (${usd(total)} build-out)`, upfront: total - principal, startIdx: dayIdx(d), startDate: isoDate(d), monthly, relief: 0, income: 0, apr: 9.5, principal, termMonths: 120,
      note: `${usd(principal)} SBA 7(a)-style loan at ~9.5% over 10 years (${usd(monthly)}/mo) plus ${usd(total - principal)} cash from the family.` };
  }
  if (/raise|bonus|income|salary|lose my job|laid off/.test(p)) {
    const neg = /lose|laid off|cut/.test(p);
    const monthlyDelta = Math.round((spoken ?? 800) > 10000 ? (spoken ?? 800) / 12 : spoken ?? 800) * (neg ? -1 : 1);
    return { kind: "income_change", label: neg ? "Income drops" : "Income rises", upfront: 0, startIdx: 7, startDate: isoDate(addDays(c.now, 7)), monthly: 0, relief: 0, income: monthlyDelta,
      note: `Take-home changes by ${usd(monthlyDelta, { sign: true })}/mo.` };
  }
  const price = spoken ?? 5000;
  const d = dateFromPrompt(prompt, c.now, 14);
  return { kind: "purchase", label: `Spend ${usd(price)} on ${shortDate(isoDate(d))}`, upfront: price, startIdx: dayIdx(d), startDate: isoDate(d), monthly: 0, relief: 0, income: 0, note: `One-time ${usd(price)} from checking.` };
}

export function runScenario(s: ParsedScenario, c: SimCtx): ScenarioResult {
  // Look far enough past the start date to see the effect (e.g. "a car in March" is beyond 90 days).
  const horizon = Math.min(240, Math.max(90, s.startIdx + 75));
  const base = horizon <= c.forecast.length ? c.forecast : computeForecast(c.hid, { accounts: c.accounts, members: c.members, obligations: c.obligations, varSpend: c.varSpend, nwTrend: 0 }, c.now, horizon);
  const series = base.map((pt, i) => {
    let delta = 0;
    if (i >= s.startIdx) delta -= s.upfront;
    if (s.monthly && i > s.startIdx + 30) delta -= s.monthly * Math.floor((i - s.startIdx) / 30);
    if (s.relief && i >= s.startIdx) delta += s.relief * (Math.floor((i - s.startIdx) / 30) + 1);
    if (s.income && i >= s.startIdx) delta += s.income * (Math.floor((i - s.startIdx) / 30) + 1);
    return { date: pt.date, baseline: pt.balance, scenario: Math.round((pt.balance + delta) * 100) / 100, obligations_due: pt.obligations_due };
  });
  const lowBefore = lowPoint(base);
  const lowAfter = lowPoint(series.map((p) => ({ date: p.date, balance: p.scenario })));
  const out = monthlyOutflow(c);
  const liquid = liquidCash(c.accounts);
  const runwayBefore = out ? liquid / out : 0;
  const runwayAfter = (liquid - s.upfront) / Math.max(1, out + s.monthly - s.relief - s.income);
  const payBefore = c.accounts.filter((a) => LIABILITY_TYPES.has(a.type)).reduce((t, a) => t + (a.monthly_payment ?? 0), 0);
  const verdict: ScenarioResult["verdict"] = lowAfter.balance < 0 ? "risky" : lowAfter.balance < 1500 ? "tight" : "fine";
  let suggestion: string | undefined;
  if (s.kind === "new_loan") suggestion = "An SBA 7(a) loan fits this: keep the $20k cash contribution in the Emergency Fund and apply before the January lease deadline. The Table Mode goals can pre-fill the application.";
  else if (s.kind === "purchase" && verdict !== "fine") suggestion = `Move about ${usd(Math.max(1500 - lowAfter.balance, 500), { compact: true })} from savings before ${shortDate(lowAfter.date)} or delay the purchase until after payday.`;
  else if (s.kind === "payoff") suggestion = `Interest saved: about ${usd(s.interestSavedYear ?? 0)} a year. Keep at least ${usd(Math.round(out * 2))} (two months) in savings afterwards.`;
  const verdictWords = verdict === "fine" ? "comfortably" : verdict === "tight" ? "tightly" : "not safely";
  const summary = `${s.label}: this works ${verdictWords}. ${s.note} Cash would bottom out at ${usd(lowAfter.balance)} on ${longDate(lowAfter.date)} (baseline ${usd(lowBefore.balance)}).`;
  return {
    summary, verdict, series, low_point: lowAfter, suggestion,
    metrics: [
      { label: "Lowest cash balance", before: lowBefore.balance, after: lowAfter.balance, unit: "usd" },
      { label: "Cash runway", before: Math.round(runwayBefore * 10) / 10, after: Math.round(runwayAfter * 10) / 10, unit: "months" },
      { label: "Monthly loan + card payments", before: payBefore, after: payBefore + s.monthly - s.relief, unit: "usd" },
    ],
  };
}

export function totalDebtPayments(c: SimCtx): number {
  return c.accounts.filter((a) => LIABILITY_TYPES.has(a.type)).reduce((t, a) => t + (a.monthly_payment ?? 0), 0);
}
