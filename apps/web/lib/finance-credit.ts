/**
 * Synthetic credit score (docs/contracts.md section 9). A transparent 300-850 score per member, driven mostly by the
 * household's overall financial health, so the product can show "monitoring" without pulling real credit.
 *
 * The module computes and stores it (`credit_score`, `credit_score_history`). Until those tables are live, or for a
 * member they do not cover yet, the UI derives the same formula here from rows it already has, and says so.
 *
 *   raw   = 0.45 * household_health / 100 + 0.20 * payment + 0.15 * utilization + 0.08 * history + 0.06 * new_credit + 0.06 * mix
 *   score = round(300 + 550 * raw), clamped to 300-850
 */
import { HISTORY_MONTHS, monthlyCashFlow } from "@/lib/finance";
import { FACTOR_META } from "@/lib/credit-factors";
import type { Account, CreditFactor, CreditProfile, CreditScore, CreditScoreHistory, Member, Obligation, Transaction } from "@/lib/types";

export { FACTOR_META, parseFactors } from "@/lib/credit-factors";
export const CREDIT_MIN = 300;
export const CREDIT_MAX = 850;
const SPAN = CREDIT_MAX - CREDIT_MIN;

export type CreditBand = "poor" | "fair" | "good" | "very_good" | "exceptional";
export const BANDS: { key: CreditBand; label: string; min: number; max: number; tone: "risk" | "watch" | "good" }[] = [
  { key: "poor", label: "Poor", min: 300, max: 579, tone: "risk" },
  { key: "fair", label: "Fair", min: 580, max: 669, tone: "watch" },
  { key: "good", label: "Good", min: 670, max: 739, tone: "good" },
  { key: "very_good", label: "Very good", min: 740, max: 799, tone: "good" },
  { key: "exceptional", label: "Exceptional", min: 800, max: 850, tone: "good" },
];
export function bandOf(score: number) {
  return BANDS.find((b) => score <= b.max) ?? BANDS[BANDS.length - 1];
}
/** "very good", "Very Good", "very_good" -> the band. Falls back to the score when the module sends something else. */
export function parseBand(band: string, score: number) {
  const k = band.toLowerCase().replace(/[\s-]+/g, "_");
  return BANDS.find((b) => b.key === k) ?? bandOf(score);
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
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const DEBT_TYPES = new Set(["auto_loan", "personal_loan", "credit_card", "mortgage"]);
export function creditMixCount(accounts: readonly Account[]): number {
  return new Set(accounts.filter((a) => DEBT_TYPES.has(a.type)).map((a) => a.type)).size;
}

/**
 * The curves the module uses (spacetime/src/credit.ts), so a derived score matches the live one. A 1.0 means top-tier
 * behaviour, and the household factor is the health score scaled by 0.8: a perfect dashboard is not a perfect borrower.
 */
const HEALTH_CREDIT_SCALE = 0.8;
const CURVES = {
  payment: [[0, 1], [1, 0.7], [2, 0.45], [3, 0.3], [4, 0.12], [6, 0]],
  utilization: [[0, 0.85], [3, 1], [5, 1], [10, 0.7], [20, 0.46], [30, 0.32], [50, 0.17], [75, 0.06], [100, 0]],
  history: [[0, 0.05], [2, 0.25], [5, 0.45], [10, 0.62], [20, 0.8], [30, 0.95], [40, 1]],
  inquiries: [[0, 1], [1, 0.72], [2, 0.5], [3, 0.35], [4, 0.2], [6, 0.08], [8, 0]],
  mix: [[0, 0.2], [1, 0.4], [2, 0.55], [3, 0.7], [4, 1]],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;
const healthWord = (h: number) => (h >= 85 ? "excellent" : h >= 70 ? "good" : h >= 55 ? "fair" : h >= 40 ? "needs attention" : "at risk");

/** The six factors for one member, each 0-1 with its weight, points and a one-line reason. */
export function creditFactors(profile: CreditProfile, householdHealth: number, mixCount: number): CreditFactor[] {
  const h = Math.max(0, Math.min(100, householdHealth));
  const late = Math.max(0, Math.round(profile.late_payments_24m));
  const util = Math.max(0, profile.utilization_pct);
  const years = Math.max(0, profile.oldest_account_years);
  const inq = Math.max(0, Math.round(profile.hard_inquiries_12m));
  const values: Record<string, { value: number; explanation: string }> = {
    household_health: {
      value: (h / 100) * HEALTH_CREDIT_SCALE,
      explanation: `Household finances score ${Math.round(h)} out of 100 (${healthWord(h)}): cash runway, debt load, savings and the forecast all feed it.`,
    },
    payment_history: {
      value: interp(late, CURVES.payment),
      explanation: late ? `${plural(late, "late payment")} in the last 2 years; on-time payments rebuild this.` : "No late payments in the last 2 years, the biggest single plus.",
    },
    utilization: {
      value: interp(util, CURVES.utilization),
      explanation: `Cards are at ${Math.round(util)}% of their limits${util <= 10 ? "; under 10% is ideal." : util <= 30 ? "; under 30% helps, under 10% helps more." : "; under 30% helps."}`,
    },
    history_length: {
      value: interp(years, CURVES.history),
      explanation: years >= 20 ? `The oldest account is ${Math.round(years)} years old; a long history is a strong plus.` : `The oldest account is ${Math.round(years * 10) / 10} years old; a longer history scores higher.`,
    },
    new_credit: {
      value: interp(inq, CURVES.inquiries),
      explanation: inq ? `${plural(inq, "hard credit check")} in the last year; each one dips the score for a while.` : "No new credit applications in the last year.",
    },
    credit_mix: {
      value: interp(mixCount, CURVES.mix),
      explanation: mixCount ? `${plural(mixCount, "kind")} of debt; a mix of cards and installment loans helps.` : "No loans or cards on record; a mix of card and installment loans helps.",
    },
  };
  return FACTOR_META.map((m) => {
    const v = clamp01(values[m.key].value);
    return { key: m.key, label: m.label, weight: m.weight, value: v, points: SPAN * m.weight * v, max_points: SPAN * m.weight, explanation: values[m.key].explanation };
  });
}

export function scoreFromFactors(factors: readonly CreditFactor[]): number {
  const raw = factors.reduce((s, f) => s + f.weight * f.value, 0);
  return Math.max(CREDIT_MIN, Math.min(CREDIT_MAX, Math.round(CREDIT_MIN + SPAN * raw)));
}

// ------------------------------------------------------------------------------------------------ the per-member view

export interface CreditHistoryPoint {
  date: string;
  score: number;
}
export interface CreditView {
  member_id: string;
  name: string;
  role: Member["role"];
  score: number;
  band: (typeof BANDS)[number];
  factors: CreditFactor[];
  history: CreditHistoryPoint[];
  /** Change over the history window (first point to now). */
  change: number | null;
  updated_at?: string;
  /** "live": from the module's credit_score table. "derived": the same formula computed in the browser. */
  source: "live" | "derived";
}

/** A change between two consecutive points of at least this much is an alert (same rule as the module). */
export const ALERT_DELTA = 15;

export interface DerivedCreditAlert {
  id: string;
  member_id: string;
  severity: "warn" | "info";
  title: string;
  detail: string;
  date: string;
}

const monthEnd = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m, 0, 12);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Household health for each of the last months, for a derived trend: today's score moved by how that month's
 * savings rate compares with the household's usual one. The module recomputes the real indicators per month; this is
 * the browser's stand-in until its history rows are there.
 */
export function pastHealth(
  healthNow: number, txns: readonly Transaction[], accounts: readonly Account[], obligations: readonly Obligation[], members: readonly Member[], today: Date,
): { date: string; health: number }[] {
  const months = monthlyCashFlow(txns, accounts, obligations, members, today, HISTORY_MONTHS, 0).filter((m) => !m.forecast && m.income > 0);
  if (!months.length) return [];
  const rate = (m: (typeof months)[number]) => Math.max(-0.5, Math.min(0.6, m.net / m.income));
  const avg = months.reduce((s, m) => s + rate(m), 0) / months.length;
  // Smoothed over two months and capped at 10 health points either way: a lumpy month (a tax payment, a partial first
  // month of data) should nudge the trend, not swing it.
  return months.map((m, i) => {
    const r = i ? (rate(m) + rate(months[i - 1])) / 2 : rate(m);
    const delta = Math.max(-10, Math.min(10, (r - avg) * 60));
    return { date: monthEnd(m.key), health: Math.max(0, Math.min(100, healthNow + delta)) };
  });
}

export interface CreditInputs {
  members: readonly Member[];
  profiles: readonly CreditProfile[];
  scores: readonly CreditScore[];
  history: readonly CreditScoreHistory[];
  accounts: readonly Account[];
  healthScore: number | null;
  /** Past household health per month (from `pastHealth`), for members without live history. */
  pastHealth: readonly { date: string; health: number }[];
  today: string;
}

/** One view per member who has a score: live rows first, the derived formula for anyone they don't cover. */
export function creditViews(inp: CreditInputs): CreditView[] {
  const mix = creditMixCount(inp.accounts);
  const out: CreditView[] = [];
  for (const m of inp.members) {
    const live = inp.scores.find((s) => s.member_id === m.id);
    const profile = inp.profiles.find((p) => p.member_id === m.id);
    const liveHist = inp.history.filter((h) => h.member_id === m.id).sort((a, b) => a.date.localeCompare(b.date)).map((h) => ({ date: h.date, score: h.score }));
    if (live) {
      const factors = live.factors.length ? live.factors : profile && inp.healthScore !== null ? creditFactors(profile, inp.healthScore, mix) : [];
      const history = liveHist.length ? liveHist : [{ date: inp.today, score: live.score }];
      if (history[history.length - 1].score !== live.score && history[history.length - 1].date < inp.today) history.push({ date: inp.today, score: live.score });
      out.push({
        member_id: m.id, name: m.name, role: m.role, score: live.score, band: parseBand(live.band, live.score), factors, history,
        change: history.length > 1 ? live.score - history[0].score : null, updated_at: live.updated_at, source: "live",
      });
      continue;
    }
    if (!profile || inp.healthScore === null) continue;
    const factors = creditFactors(profile, inp.healthScore, mix);
    const score = scoreFromFactors(factors);
    const history = liveHist.length
      ? liveHist
      : [...inp.pastHealth.filter((p) => p.date < inp.today).map((p) => ({ date: p.date, score: scoreFromFactors(creditFactors(profile, p.health, mix)) })), { date: inp.today, score }];
    out.push({ member_id: m.id, name: m.name, role: m.role, score, band: bandOf(score), factors, history, change: history.length > 1 ? score - history[0].score : null, source: "derived" });
  }
  return out;
}

/** The ≥15-point moves in a member's history, newest first, phrased like the module's `credit` alerts. */
export function derivedCreditAlerts(views: readonly CreditView[]): DerivedCreditAlert[] {
  const out: DerivedCreditAlert[] = [];
  for (const v of views) {
    for (let i = 1; i < v.history.length; i++) {
      const d = v.history[i].score - v.history[i - 1].score;
      if (Math.abs(d) < ALERT_DELTA) continue;
      const first = v.name.split(/\s+/)[0];
      out.push({
        id: `${v.member_id}:${v.history[i].date}`,
        member_id: v.member_id,
        severity: d < 0 ? "warn" : "info",
        title: `${first}'s score ${d < 0 ? "dropped" : "rose"} ${Math.abs(d)} points to ${v.history[i].score}`,
        detail: d < 0 ? "Household health slipped that month: less cash kept after bills." : "Household health improved that month: more cash kept after bills.",
        date: v.history[i].date,
      });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
