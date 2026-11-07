// simulate_scenario: project the household's liquid cash over 12-24 months for a what-if, against its measured cash flow.
import { z } from 'zod';
import type { Account, HouseholdData } from '../types.js';
import { addMonthsIso, clamp, round2, usd } from '../util.js';
import { DEBT_TYPES, cashFlow, interestOverWindow, liquidBalance, pmt } from './finance.js';
import { defineTool } from './registry.js';

export const ScenarioSchema = z.object({
  kind: z
    .enum(['purchase', 'income_change', 'payoff', 'new_loan', 'rate_change'])
    .describe('purchase = buy something (cash or financed); income_change = income goes up/down; payoff = pay off a debt; new_loan = take a loan; rate_change = variable interest rates move'),
  label: z.string().max(100).optional().describe('Short human label, e.g. "Buy a $32,000 car"'),
  months: z.number().int().min(1).max(60).optional().describe('Horizon in months; clamped to 12-24'),
  amount: z.number().min(0).optional().describe('Purchase price, loan principal, or payoff amount in USD'),
  down_payment: z.number().min(0).optional().describe('purchase: cash paid up front when financing'),
  financed: z.boolean().optional().describe('purchase: true if bought with a loan'),
  apr_pct: z.number().min(0).max(60).optional().describe('Loan APR in percent'),
  term_months: z.number().int().min(1).max(480).optional().describe('Loan term in months'),
  income_change_pct: z.number().min(-100).max(500).optional().describe('income_change: percent change in monthly income, negative for a drop'),
  income_change_monthly: z.number().optional().describe('income_change: absolute change in monthly income in USD'),
  start_month: z.number().int().min(0).max(24).optional().describe('Month the change starts (default 1)'),
  duration_months: z.number().int().min(1).max(24).optional().describe('income_change: how many months the change lasts (default: until the end of the horizon)'),
  account_hint: z.string().optional().describe('payoff/rate_change: account id, nickname or type (e.g. auto_loan, credit_card)'),
  rate_delta_pct: z.number().min(-10).max(20).optional().describe('rate_change: change in percentage points'),
  proceeds_to_cash: z.boolean().optional().describe('new_loan: loan proceeds land in checking (default true)'),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export interface SimPoint {
  month: number;
  baseline: number;
  scenario: number;
}

export interface SimResult {
  scenario: Scenario;
  months: number;
  assumptions: string[];
  baseline: { start_liquid: number; monthly_in: number; monthly_out: number; monthly_net: number; window_days: number };
  effect: { upfront_cash: number; monthly_change: number; monthly_payment?: number; total_interest?: number; interest_in_window?: number; interest_saved?: number };
  /** Sampled months (what the model sees). */
  path: SimPoint[];
  /** Every month 0..N with its calendar date, for charts. */
  series: { month: number; date: string; baseline: number; scenario: number }[];
  lowest: { month: number; balance: number };
  ending: { baseline: number; scenario: number; difference: number };
  months_of_spending_covered_at_low: number;
  verdict: 'comfortable' | 'tight' | 'shortfall';
  headline: string;
}

function findDebt(data: HouseholdData, hint?: string): Account | undefined {
  const debts = data.accounts.filter((a) => DEBT_TYPES.has(a.type));
  if (hint) {
    const h = hint.toLowerCase().replace(/\s+/g, '_');
    const byId = debts.find((a) => a.id.toLowerCase() === hint.toLowerCase());
    if (byId) return byId;
    const byType = debts.find((a) => a.type === h || a.type.replace('_', ' ') === hint.toLowerCase());
    const byNick = debts.find((a) => a.nickname.toLowerCase().includes(hint.toLowerCase()));
    if (byNick) return byNick;
    if (byType) return byType;
    if (/car|auto|truck|vehicle/i.test(hint)) return debts.find((a) => a.type === 'auto_loan');
    if (/card/i.test(hint)) return debts.filter((a) => a.type === 'credit_card').sort((x, y) => y.balance - x.balance)[0];
    if (/house|home|mortgage/i.test(hint)) return debts.find((a) => a.type === 'mortgage');
  }
  return debts.filter((a) => a.type !== 'mortgage').sort((x, y) => (y.rate_pct ?? 0) - (x.rate_pct ?? 0))[0];
}

export function simulate(raw: Scenario, data: HouseholdData): SimResult {
  const scn = ScenarioSchema.parse(raw);
  const months = clamp(scn.months ?? 12, 12, 24);
  const flow = cashFlow(data);
  const start = liquidBalance(data);
  const startMonth = scn.start_month ?? 1;
  const assumptions: string[] = [`Baseline is the last ${Math.round(flow.window_days)} days of cash flow on checking and savings: ${usd(flow.monthly_in)} in, ${usd(flow.monthly_out)} out per month.`];

  let upfront = 0; // cash change at month 0 (negative = spent)
  const monthly = new Array<number>(months + 1).fill(0); // monthly[m] = scenario cash change in month m
  const effect: SimResult['effect'] = { upfront_cash: 0, monthly_change: 0 };

  switch (scn.kind) {
    case 'purchase': {
      const price = scn.amount ?? 0;
      const financed = scn.financed ?? (scn.down_payment !== undefined || scn.apr_pct !== undefined || scn.term_months !== undefined);
      if (financed) {
        const down = Math.min(price, scn.down_payment ?? round2(price * 0.1));
        const apr = scn.apr_pct ?? 7.5;
        const term = scn.term_months ?? 60;
        const principal = Math.max(0, price - down);
        const pay = pmt(principal, apr, term);
        upfront = -down;
        for (let m = 1; m <= months; m++) if (m <= term) monthly[m] = -pay;
        effect.monthly_payment = pay;
        effect.total_interest = round2(pay * term - principal);
        effect.interest_in_window = interestOverWindow(principal, apr, pay, months);
        assumptions.push(`Financed ${usd(principal)} after ${usd(down)} down at ${apr}% APR over ${term} months.`);
      } else {
        upfront = -price;
        assumptions.push(`Paid in cash: ${usd(price)} leaves checking/savings immediately.`);
      }
      break;
    }
    case 'income_change': {
      const delta = scn.income_change_monthly ?? round2((flow.monthly_in * (scn.income_change_pct ?? 0)) / 100);
      const endMonth = scn.duration_months ? Math.min(months, startMonth + scn.duration_months - 1) : months;
      for (let m = startMonth; m <= endMonth; m++) monthly[m] = delta;
      assumptions.push(`Monthly income changes by ${usd(delta)} starting in month ${startMonth}${scn.duration_months ? ` for ${scn.duration_months} months` : ''}; spending stays the same.`);
      break;
    }
    case 'payoff': {
      const debt = findDebt(data, scn.account_hint);
      if (!debt) {
        assumptions.push('No matching debt account was found; treating the payoff amount as a one-time cash payment.');
        upfront = -(scn.amount ?? 0);
        break;
      }
      const lump = Math.min(debt.balance, scn.amount ?? debt.balance);
      const full = lump >= debt.balance - 0.01;
      const apr = debt.rate_pct ?? 0;
      const pay = debt.monthly_payment ?? (debt.type === 'credit_card' ? Math.max(25, round2(debt.balance * 0.02)) : 0);
      upfront = -lump;
      if (full) for (let m = 1; m <= months; m++) monthly[m] = pay;
      const without = interestOverWindow(debt.balance, apr, pay, months);
      const withPay = full ? 0 : interestOverWindow(debt.balance - lump, apr, pay, months);
      effect.interest_saved = round2(without - withPay);
      effect.monthly_change = 0;
      assumptions.push(
        full
          ? `Pay off "${debt.nickname || debt.type}" (${usd(debt.balance)} at ${apr}%) in full now; its ${usd(pay)} monthly payment goes away.`
          : `Pay ${usd(lump)} toward "${debt.nickname || debt.type}" now; the regular payment continues.`,
      );
      break;
    }
    case 'new_loan': {
      const principal = scn.amount ?? 0;
      const apr = scn.apr_pct ?? 8;
      const term = scn.term_months ?? 60;
      const pay = pmt(principal, apr, term);
      if (scn.proceeds_to_cash !== false) upfront = principal;
      for (let m = 1; m <= months; m++) if (m <= term) monthly[m] = -pay;
      effect.monthly_payment = pay;
      effect.total_interest = round2(pay * term - principal);
      effect.interest_in_window = interestOverWindow(principal, apr, pay, months);
      assumptions.push(`New ${usd(principal)} loan at ${apr}% APR over ${term} months${scn.proceeds_to_cash !== false ? '; proceeds land in cash' : ''}.`);
      break;
    }
    case 'rate_change': {
      const delta = scn.rate_delta_pct ?? 1;
      const hint = scn.account_hint?.toLowerCase() ?? '';
      const affected = data.accounts.filter((a) => (a.type === 'credit_card' || a.type === 'personal_loan' || (hint.includes('mortgage') && a.type === 'mortgage')) && a.balance > 0);
      const extra = round2(affected.reduce((s, a) => s + (a.balance * delta) / 100 / 12, 0));
      for (let m = startMonth; m <= months; m++) monthly[m] = -extra;
      effect.total_interest = round2(extra * months);
      assumptions.push(`Rates on ${affected.length} variable-rate account(s) (credit cards and personal loans${hint.includes('mortgage') ? ', mortgage' : ''}) move by ${delta} points, adding ${usd(extra)} of interest per month.`);
      break;
    }
  }

  effect.upfront_cash = round2(upfront);
  let running = 0;
  const path: SimPoint[] = [];
  let lowest = { month: 0, balance: start + upfront };
  for (let m = 0; m <= months; m++) {
    if (m === 0) running = upfront;
    else running += monthly[m]!;
    const baseline = start + flow.monthly_net * m;
    const scenario = baseline + running;
    if (scenario < lowest.balance) lowest = { month: m, balance: scenario };
    path.push({ month: m, baseline: round2(baseline), scenario: round2(scenario) });
  }
  effect.monthly_change = round2(monthly[months]!);
  const last = path[path.length - 1]!;
  const coverage = flow.monthly_out > 0 ? round2(lowest.balance / flow.monthly_out) : 0;
  // Positive cash at the low point is not enough: if the plan leaves under 3 months of spending AND the household is still
  // losing money every month at the end (the balance keeps falling after the horizon), that is not "manageable".
  const finalMonthlyNet = round2(flow.monthly_net + effect.monthly_change);
  const draining = finalMonthlyNet < 0 && coverage < 3;
  const verdict: SimResult['verdict'] = lowest.balance < 0 ? 'shortfall' : coverage < 1 || draining ? 'tight' : 'comfortable';

  const label = scn.label ?? scn.kind.replace('_', ' ');
  const headline =
    verdict === 'shortfall'
      ? `${label}: cash would run out around month ${lowest.month} (low point ${usd(lowest.balance)}).`
      : verdict === 'tight'
        ? `${label}: stays positive but only ${coverage} months of spending would be covered at the low point (${usd(lowest.balance)})${draining ? `, and cash flow turns negative (${usd(finalMonthlyNet)} a month), so the balance keeps falling` : ''}.`
        : `${label}: manageable. Lowest cash ${usd(lowest.balance)} covers ${coverage} months of spending; month ${months} balance ${usd(last.scenario)}.`;

  const sample = new Set([0, 3, 6, 9, 12, 18, 24, months, lowest.month]);
  return {
    scenario: scn,
    months,
    assumptions,
    baseline: { start_liquid: start, monthly_in: flow.monthly_in, monthly_out: flow.monthly_out, monthly_net: flow.monthly_net, window_days: flow.window_days },
    effect,
    path: path.filter((p) => sample.has(p.month)),
    series: path.map((p) => ({ month: p.month, date: addMonthsIso(data.asOf, p.month), baseline: p.baseline, scenario: p.scenario })),
    lowest: { month: lowest.month, balance: round2(lowest.balance) },
    ending: { baseline: last.baseline, scenario: last.scenario, difference: round2(last.scenario - last.baseline) },
    months_of_spending_covered_at_low: coverage,
    verdict,
    headline,
  };
}

export const simulateScenario = defineTool({
  name: 'simulate_scenario',
  description:
    'Run a what-if over 12-24 months against the household cash flow: a purchase (cash or financed), an income change, paying off a debt, a new loan, or an interest-rate change. Returns the cash path vs baseline, the low point and a verdict.',
  schema: ScenarioSchema,
  describe: (a) => `Simulating: ${a.label ?? a.kind.replace('_', ' ')}${a.amount ? ` (${usd(a.amount)})` : ''}`,
  run: (a, { data }) => simulate(a, data),
  summarize: (r: SimResult) => r.headline,
});
