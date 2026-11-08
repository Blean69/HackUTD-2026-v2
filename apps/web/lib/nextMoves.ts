import { healthModel } from "./finance";
import { usd } from "./format";
import type { Account, HealthIndicator, Obligation } from "./types";

/**
 * "Your next move": turns the module's health indicators into concrete, dollar-sized actions, ranked by how many points
 * each adds to the overall health score. Pure ranking over SpacetimeDB numbers; it adds no money math of its own beyond
 * "how far is this from its Good threshold".
 * ponytail: web-only for now, so Brian doesn't say the same sentence; move into a module view if he should.
 */
export interface NextMove {
  key: string;
  title: string;
  detail: string;
  /** Which indicators it fixes, as "Label: now → target". */
  why: string;
  lift: number;
  scoreAfter: number;
  /** Prefill for What-If Studio. */
  simulate: string;
  /** Prefill for a call with Brian. */
  ask: string;
}

export interface NextMoveInput {
  health: readonly HealthIndicator[];
  accounts: readonly Account[];
  obligations: readonly Obligation[];
  incomeMonthly: number;
  spendMonthly: number;
}

/** The Good threshold of each indicator (spacetime/src/finance.ts); shared by "Show the math". */
export const GOOD_AT: Record<string, { value: number; text: string }> = {
  liquidity_runway: { value: 6, text: "6+ months good · 3–6 watch · under 3 risk" },
  emergency_fund: { value: 100, text: "100% of a 3-month cushion good · 50–99% watch · under 50% risk" },
  debt_to_income: { value: 36, text: "36% or less good · up to 43% watch · above risk" },
  credit_utilization: { value: 30, text: "30% or less good · up to 50% watch · above risk" },
  savings_rate: { value: 15, text: "15%+ good · 5–15% watch · under 5% risk" },
  net_worth_trend: { value: 0, text: "Rising good · down under 5% watch · down 5%+ risk" },
  forecast_low_point: { value: 0, text: "Above half a month of spending good · above $0 watch · below $0 risk" },
  credit_score: { value: 740, text: "740+ good · 670–739 watch · under 670 risk" },
};

const round = (n: number, to = 10) => Math.ceil(n / to) * to;
const sum = (xs: readonly Account[]) => xs.reduce((s, a) => s + Math.abs(a.balance), 0);

export function nextMoves({ health, accounts, obligations, incomeMonthly, spendMonthly }: NextMoveInput): NextMove[] {
  const by = new Map(health.map((h) => [h.key, h]));
  const weak = (k: string) => {
    const h = by.get(k as HealthIndicator["key"]);
    return h && h.status !== "good" ? h : undefined;
  };
  const before = healthModel(health).score ?? 0;
  const lift = (targets: Record<string, number>) => {
    const after = healthModel(health.map((h) => (h.key in targets ? { ...h, value: targets[h.key], status: "good" as const } : h))).score ?? before;
    return { lift: after - before, scoreAfter: after };
  };
  const ofType = (...t: string[]) => accounts.filter((a) => t.includes(a.type));
  const moves: NextMove[] = [];

  // 1. Cash cushion (runway and emergency fund move together: both are fixed by more money in savings).
  const runway = weak("liquidity_runway");
  const ef = weak("emergency_fund");
  if (runway || ef) {
    const liquid = sum(ofType("checking", "savings"));
    const spend = runway && runway.value > 0 ? liquid / runway.value : spendMonthly; // the module's own spending figure
    const need = Math.max(runway ? 6 * spend - liquid : 0, ef ? 3 * spend - sum(ofType("savings")) : 0);
    if (need > 0) {
      const monthly = round(need / 12, 50);
      const targets: Record<string, number> = {};
      if (runway) targets.liquidity_runway = 6;
      if (ef) targets.emergency_fund = ef.unit === "months" ? 3 : 100;
      moves.push({
        key: "cushion",
        title: "Build a 6-month cash cushion",
        detail: `Move ${usd(monthly)} a month into savings for 12 months (${usd(round(need, 100))} in all).`,
        why: [runway && `Runway ${runway.value.toFixed(1)} → 6 months`, ef && `Emergency fund ${Math.round(ef.value)}% → 100%`].filter(Boolean).join(" · "),
        ...lift(targets),
        simulate: `What if we move ${usd(monthly)} a month into savings for the next 12 months?`,
        ask: "How do we build a six-month cash cushion?",
      });
    }
  }

  // 2. Savings rate: start with the subscriptions, the easiest money to free.
  const sr = weak("savings_rate");
  if (sr && incomeMonthly > 0) {
    const extra = round(((GOOD_AT.savings_rate.value - sr.value) / 100) * incomeMonthly);
    const subs = obligations.filter((o) => o.kind === "subscription" && o.amount > 0);
    const subTotal = subs.reduce((s, o) => s + o.amount, 0);
    moves.push({
      key: "savings_rate",
      title: `Keep ${usd(extra)} more each month`,
      detail: subs.length
        ? `Start with the ${subs.length} subscriptions (${usd(subTotal)}/mo): cancel what nobody uses, then trim dining and shopping.`
        : "Trim dining, shopping and other flexible spending first; leave loan payments alone.",
      why: `Savings rate ${sr.value.toFixed(1)}% → 15%`,
      ...lift({ savings_rate: GOOD_AT.savings_rate.value }),
      simulate: `What if we cut our spending by ${usd(extra)} a month?`,
      ask: "Which bills should we cut to save more each month?",
    });
  }

  // 3. Card utilization: pay the fullest card first.
  const cu = weak("credit_utilization");
  const cards = ofType("credit_card").filter((c) => (c.credit_limit ?? 0) > 0);
  if (cu && cards.length) {
    const pay = round(sum(cards) - 0.3 * cards.reduce((s, c) => s + (c.credit_limit ?? 0), 0), 50);
    const worst = [...cards].sort((a, b) => Math.abs(b.balance) / b.credit_limit! - Math.abs(a.balance) / a.credit_limit!)[0];
    if (pay > 0) moves.push({
      key: "credit_utilization",
      title: `Pay ${usd(pay)} toward your cards`,
      detail: `Start with ${worst.nickname} (${Math.round((Math.abs(worst.balance) / worst.credit_limit!) * 100)}% used). Under 30% helps the credit score too.`,
      why: `Card use ${Math.round(cu.value)}% → 30%`,
      ...lift({ credit_utilization: 30 }),
      simulate: `What if we pay ${usd(pay)} toward our credit cards this month?`,
      ask: "Which credit card should we pay down first?",
    });
  }

  // 4. Debt-to-income: free monthly payments on the priciest debt.
  const dti = weak("debt_to_income");
  if (dti && incomeMonthly > 0) {
    const cut = round(((dti.value - GOOD_AT.debt_to_income.value) / 100) * incomeMonthly);
    const priciest = [...ofType("credit_card", "personal_loan", "auto_loan")].sort((a, b) => (b.rate_pct ?? 0) - (a.rate_pct ?? 0))[0];
    moves.push({
      key: "debt_to_income",
      title: `Free up ${usd(cut)} a month of debt payments`,
      detail: priciest ? `Pay down or refinance ${priciest.nickname}${priciest.rate_pct ? ` (${priciest.rate_pct}% APR)` : ""} first.` : "Pay down or refinance the highest-rate debt first.",
      why: `Debt-to-income ${Math.round(dti.value)}% → 36%`,
      ...lift({ debt_to_income: 36 }),
      simulate: `What if we refinance to lower our debt payments by ${usd(cut)} a month?`,
      ask: "How can we lower our monthly debt payments?",
    });
  }

  // 5. The forecast dips too low.
  const low = weak("forecast_low_point");
  if (low) {
    const need = round(spendMonthly / 2 - low.value, 100);
    if (need > 0) moves.push({
      key: "forecast_low_point",
      title: `Keep ${usd(need)} more in checking`,
      detail: "Bills bunch up in the next 90 days; move it from savings ahead of the low point so nothing bounces.",
      why: `Lowest balance ${usd(low.value)} → ${usd(round(spendMonthly / 2, 100))}`,
      ...lift({ forecast_low_point: spendMonthly / 2 }),
      simulate: `What if we move ${usd(need)} from savings to checking now?`,
      ask: "When is our cash tightest in the next three months?",
    });
  }

  // 6. Credit score: no dollar amount, just the habits that move it.
  const cs = weak("credit_score");
  if (cs) moves.push({
    key: "credit_score",
    title: "Lift the family credit score",
    detail: "Pay every bill on time for six months and keep each card under 30% of its limit.",
    why: `Credit ${Math.round(cs.value)} → 740`,
    ...lift({ credit_score: 740 }),
    simulate: "What if we raise our credit score to 740 before refinancing?",
    ask: "How do we raise our credit score?",
  });

  return moves.filter((m) => m.lift > 0).sort((a, b) => b.lift - a.lift);
}
