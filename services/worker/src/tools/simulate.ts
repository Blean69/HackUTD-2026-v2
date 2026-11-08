// simulate_scenario: project the household's liquid cash over 12-24 months for a what-if, against its monthly cash flow (the
// dashboard's Cash flow figure, tools/finance.ts cashFlow). The what-if workflow and the family-vote check (proposal_check.ts) both
// run this one function, with the same loan math and the same default terms.
import { z } from 'zod';
import type { Account, HouseholdData } from '../types.js';
import { addMonthsIso, clamp, listWords, monthYear, plural, round2, usd } from '../util.js';
import { DEBT_TYPES, cashFlow, interestOverWindow, liquidBalance, pmt } from './finance.js';
import { defineTool } from './registry.js';
import { riskyGoal } from './risky.js';

/** Terms used when the family did not state them. proposal_check.ts uses the same ones, so a vote and a what-if agree. */
export const LOAN_DEFAULTS = { apr_pct: 8, term_months: 60 } as const;
export const FINANCED_PURCHASE_DEFAULTS = { apr_pct: 7.5, term_months: 60, down_pct: 10 } as const;

export const ScenarioSchema = z.object({
  kind: z
    .enum(['purchase', 'income_change', 'spending_change', 'payoff', 'new_loan', 'rate_change'])
    .describe(
      'purchase = buy or invest in something (cash or financed); income_change = income goes up/down; spending_change = monthly spending goes up/down ' +
        '(cancelling or cutting bills to save $X a month is a cut); payoff = pay off one debt or several; new_loan = borrow money, which is spent on what it is for; ' +
        'rate_change = variable interest rates move',
    ),
  label: z.string().max(100).optional().describe('Short human label, e.g. "Buy a $32,000 car"'),
  months: z.number().int().min(1).max(60).optional().describe('Horizon in months; clamped to 12-24'),
  amount: z.number().min(0).optional().describe('Purchase price, loan principal, or payoff amount in USD'),
  down_payment: z.number().min(0).optional().describe('purchase: cash paid up front when financing'),
  financed: z.boolean().optional().describe('purchase: true if bought with a loan'),
  apr_pct: z.number().min(0).max(60).optional().describe('Loan APR in percent, only when the family stated it'),
  term_months: z.number().int().min(1).max(480).optional().describe('Loan term in months, only when the family stated it'),
  income_change_pct: z.number().min(-100).max(500).optional().describe('income_change: percent change in monthly income, negative for a drop'),
  income_change_monthly: z.number().optional().describe('income_change: absolute change in monthly income in USD'),
  spending_change_monthly: z.number().optional().describe('spending_change: change in monthly spending in USD; negative = spending less (cancelling $150 a month of bills = -150)'),
  start_month: z
    .number()
    .int()
    .min(0)
    .max(24)
    .optional()
    .describe('Months from now when it happens or starts, only when the family names a month (2 for "in January" when today is in November). Default: now for a purchase, payoff or loan; next month for a change in income or spending'),
  duration_months: z.number().int().min(1).max(24).optional().describe('income_change / spending_change: how many months the change lasts (default: until the end of the horizon)'),
  account_hint: z.string().optional().describe('payoff/rate_change: account id, nickname or type (e.g. auto_loan, credit_card); "all" for every debt, "all loans" for every loan, "all cards" for every card'),
  rate_delta_pct: z.number().min(-10).max(20).optional().describe('rate_change: change in percentage points'),
  proceeds_to_cash: z.boolean().optional().describe('new_loan: true only if the borrowed money stays in the bank unspent; default false (it pays for what it was borrowed for)'),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export interface SimPoint {
  month: number;
  baseline: number;
  scenario: number;
}

export type SimVerdict = 'comfortable' | 'tight' | 'shortfall' | 'not_advised' | 'unclear';

export interface SimResult {
  scenario: Scenario;
  months: number;
  assumptions: string[];
  baseline: { start_liquid: number; monthly_in: number; monthly_out: number; monthly_net: number; window_days: number };
  effect: {
    /** All one-time cash changes together (negative = spent). */
    upfront_cash: number;
    /** Month the one-time change happens (0 = now). */
    upfront_month: number;
    monthly_change: number;
    monthly_payment?: number;
    total_interest?: number;
    interest_in_window?: number;
    interest_saved?: number;
  };
  /** Sampled months (what the model sees). */
  path: SimPoint[];
  /** Every month 0..N with its calendar date, for charts. */
  series: { month: number; date: string; baseline: number; scenario: number }[];
  lowest: { month: number; balance: number };
  ending: { baseline: number; scenario: number; difference: number };
  /** Never negative: 0 means cash runs out (see runs_out). */
  months_of_spending_covered_at_low: number;
  /** First month cash goes below zero, if it does. */
  runs_out: { month: number; date: string } | null;
  /** Monthly cash flow after the change is negative, so the balance is still falling when the projection ends. */
  keeps_falling: boolean;
  verdict: SimVerdict;
  /** not_advised: why (gambling, speculation). */
  caution?: string;
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
    if (/card|visa|amex|discover/i.test(hint)) return debts.filter((a) => a.type === 'credit_card').sort((x, y) => y.balance - x.balance)[0];
    if (/house|home|mortgage/i.test(hint)) return debts.find((a) => a.type === 'mortgage');
    if (/student|personal/i.test(hint)) return debts.find((a) => a.type === 'personal_loan');
  }
  return debts.filter((a) => a.type !== 'mortgage').sort((x, y) => (y.rate_pct ?? 0) - (x.rate_pct ?? 0))[0];
}

/**
 * The debts a payoff is about. "all" / "all debt" / "everything" = every debt; "all loans" = every loan (mortgage included);
 * "all cards" = every card; "all of our loans and the credit card" = every debt. With no hint, a payoff amount that covers
 * (nearly) the whole debt also means all of it. Otherwise one debt, as before.
 */
export function debtsFor(data: HouseholdData, hint?: string, amount?: number): Account[] {
  const owed = data.accounts.filter((a) => DEBT_TYPES.has(a.type) && a.balance > 0);
  const h = (hint ?? '').toLowerCase();
  if (/\b(?:all|every(?:thing|one)?|each|entire|total|whole)\b/.test(h) || /^debts?$/.test(h.trim())) {
    const cards = /card/.test(h);
    const loans = /loan|mortgage/.test(h);
    if (cards && !loans) return owed.filter((a) => a.type === 'credit_card');
    if (loans && !cards) return owed.filter((a) => a.type !== 'credit_card');
    return owed;
  }
  const total = owed.reduce((s, a) => s + a.balance, 0);
  if (!hint && amount !== undefined && owed.length > 1 && amount >= total * 0.98) return owed;
  const one = findDebt(data, hint);
  return one ? [one] : [];
}

const cardMinimum = (d: Account): number => d.monthly_payment ?? (d.type === 'credit_card' ? Math.max(25, round2(d.balance * 0.02)) : 0);
const nameOf = (d: Account): string => d.nickname || d.type.replace('_', ' ');

export function simulate(raw: Scenario, data: HouseholdData, opts: { text?: string } = {}): SimResult {
  const scn = ScenarioSchema.parse(raw);
  const months = clamp(scn.months ?? 12, 12, 24);
  const flow = cashFlow(data);
  const start = liquidBalance(data);
  const at = clamp(scn.start_month ?? 0, 0, months); // a purchase, payoff or loan happens now unless a month was named
  const changeStart = clamp(scn.start_month ?? 1, 0, months); // an income or spending change starts next month by default
  const when = (m: number): string => (m <= 0 ? 'now' : `in ${monthYear(addMonthsIso(data.asOf, m))}`);
  const assumptions: string[] = [
    `Baseline is your household's monthly cash flow over the last ${Math.round(flow.window_days)} days (the dashboard's Cash flow figure): ${usd(flow.monthly_in)} in, ${usd(flow.monthly_out)} out, ${usd(flow.monthly_net)} a month.`,
  ];

  const oneTime = new Array<number>(months + 1).fill(0); // oneTime[m] = one-time cash change in month m (negative = spent)
  const monthly = new Array<number>(months + 1).fill(0); // monthly[m] = recurring cash change in month m
  const effect: SimResult['effect'] = { upfront_cash: 0, upfront_month: 0, monthly_change: 0 };
  let unclear = '';

  switch (scn.kind) {
    case 'purchase': {
      const price = scn.amount ?? 0;
      if (price <= 0) {
        unclear = 'no price';
        break;
      }
      const financed = scn.financed ?? (scn.down_payment !== undefined || scn.apr_pct !== undefined || scn.term_months !== undefined);
      effect.upfront_month = at;
      if (financed) {
        // proceeds in, price out: the loan pays the rest of the price, so only the down payment leaves cash
        const down = Math.min(price, scn.down_payment ?? round2((price * FINANCED_PURCHASE_DEFAULTS.down_pct) / 100));
        const apr = scn.apr_pct ?? FINANCED_PURCHASE_DEFAULTS.apr_pct;
        const term = scn.term_months ?? FINANCED_PURCHASE_DEFAULTS.term_months;
        const principal = Math.max(0, price - down);
        const pay = pmt(principal, apr, term);
        oneTime[at] = -down;
        for (let m = at + 1; m <= months; m++) if (m - at <= term) monthly[m] = -pay;
        effect.monthly_payment = pay;
        effect.total_interest = round2(pay * term - principal);
        effect.interest_in_window = interestOverWindow(principal, apr, pay, months);
        assumptions.push(`Financed ${when(at)}: a ${usd(principal)} loan pays the rest of the ${usd(price)} price, so only the ${usd(down)} down payment leaves cash; then ${usd(pay)} a month at ${apr}% APR over ${term} months.`);
      } else {
        oneTime[at] = -price;
        assumptions.push(`Paid in cash: ${usd(price)} leaves checking/savings ${at ? when(at) : 'immediately'}.`);
      }
      break;
    }
    case 'income_change': {
      const delta = scn.income_change_monthly ?? round2((flow.monthly_in * (scn.income_change_pct ?? 0)) / 100);
      if (!delta) {
        unclear = 'no income change';
        break;
      }
      const endMonth = scn.duration_months ? Math.min(months, changeStart + scn.duration_months - 1) : months;
      for (let m = changeStart; m <= endMonth; m++) monthly[m] = delta;
      assumptions.push(`Monthly income ${delta < 0 ? 'drops' : 'rises'} by ${usd(Math.abs(delta))} starting in month ${changeStart}${scn.duration_months ? ` for ${plural(scn.duration_months, 'month')}` : ''}; spending stays the same.`);
      break;
    }
    case 'spending_change': {
      const delta = -(scn.spending_change_monthly ?? 0); // spending less = more cash
      if (!delta) {
        unclear = 'no spending change';
        break;
      }
      const endMonth = scn.duration_months ? Math.min(months, changeStart + scn.duration_months - 1) : months;
      for (let m = changeStart; m <= endMonth; m++) monthly[m] = delta;
      assumptions.push(`Monthly spending ${delta > 0 ? 'drops' : 'rises'} by ${usd(Math.abs(delta))} starting in month ${changeStart}${scn.duration_months ? ` for ${plural(scn.duration_months, 'month')}` : ''}; income stays the same.`);
      break;
    }
    case 'payoff': {
      const targets = debtsFor(data, scn.account_hint, scn.amount);
      effect.upfront_month = at;
      if (!targets.length) {
        if (!scn.amount) {
          unclear = 'no debt';
          break;
        }
        assumptions.push('No matching debt account was found; treating the payoff amount as a one-time cash payment.');
        oneTime[at] = -scn.amount;
        break;
      }
      const total = round2(targets.reduce((s, d) => s + d.balance, 0));
      const lump = round2(Math.min(total, scn.amount ?? total));
      // highest rate first when the money does not cover everything
      let left = lump;
      const full: Account[] = [];
      let partial: { debt: Account; paid: number } | null = null;
      for (const d of [...targets].sort((x, y) => (y.rate_pct ?? 0) - (x.rate_pct ?? 0))) {
        if (left >= d.balance - 0.01) {
          full.push(d);
          left -= d.balance;
        } else if (left > 0.01 && !partial) {
          partial = { debt: d, paid: round2(left) };
          left = 0;
        }
      }
      const freed = round2(full.reduce((s, d) => s + cardMinimum(d), 0));
      oneTime[at] = -lump;
      for (let m = at + 1; m <= months; m++) monthly[m] = freed;
      let saved = 0;
      for (const d of targets) {
        const apr = d.rate_pct ?? 0;
        const pay = cardMinimum(d);
        const without = interestOverWindow(d.balance, apr, pay, months);
        const withPay = full.includes(d) ? 0 : partial?.debt === d ? interestOverWindow(d.balance - partial.paid, apr, pay, months) : without;
        saved += without - withPay;
      }
      effect.interest_saved = round2(saved);
      if (targets.length === 1) {
        const d = targets[0]!;
        assumptions.push(
          full.length
            ? `Pay off "${nameOf(d)}" (${usd(d.balance)} at ${d.rate_pct ?? 0}%) in full ${when(at)}; its ${usd(freed)} monthly payment goes away.`
            : `Pay ${usd(lump)} toward "${nameOf(d)}" ${when(at)}; the regular payment continues.`,
        );
      } else {
        assumptions.push(
          full.length === targets.length
            ? `Pay off ${plural(targets.length, 'debt')} in full ${when(at)} (${listWords(targets.map(nameOf))}: ${usd(total)} in total); their ${usd(freed)} of monthly payments go away.`
            : `Pay ${usd(lump)} of the ${usd(total)} owed on ${listWords(targets.map(nameOf))} ${when(at)}, highest rate first${full.length ? `: ${listWords(full.map(nameOf))} paid off, freeing ${usd(freed)} a month` : ''}.`,
        );
      }
      break;
    }
    case 'new_loan': {
      const principal = scn.amount ?? 0;
      if (principal <= 0) {
        unclear = 'no loan amount';
        break;
      }
      const apr = scn.apr_pct ?? LOAN_DEFAULTS.apr_pct;
      const term = scn.term_months ?? LOAN_DEFAULTS.term_months;
      const pay = pmt(principal, apr, term);
      effect.upfront_month = at;
      if (scn.proceeds_to_cash === true) oneTime[at] = principal;
      for (let m = at + 1; m <= months; m++) if (m - at <= term) monthly[m] = -pay;
      effect.monthly_payment = pay;
      effect.total_interest = round2(pay * term - principal);
      effect.interest_in_window = interestOverWindow(principal, apr, pay, months);
      assumptions.push(
        scn.proceeds_to_cash === true
          ? `New ${usd(principal)} loan ${when(at)} at ${apr}% APR over ${term} months; the money stays in checking/savings.`
          : `New ${usd(principal)} loan ${when(at)} at ${apr}% APR over ${term} months, spent on what it is for (it comes in and goes straight out), so cash only feels the ${usd(pay)} monthly payment.`,
      );
      break;
    }
    case 'rate_change': {
      const delta = scn.rate_delta_pct ?? 1;
      const hint = scn.account_hint?.toLowerCase() ?? '';
      const affected = data.accounts.filter((a) => (a.type === 'credit_card' || a.type === 'personal_loan' || (hint.includes('mortgage') && a.type === 'mortgage')) && a.balance > 0);
      const extra = round2(affected.reduce((s, a) => s + (a.balance * delta) / 100 / 12, 0));
      for (let m = changeStart; m <= months; m++) monthly[m] = -extra;
      effect.total_interest = round2(extra * months);
      assumptions.push(`Rates on ${plural(affected.length, 'variable-rate account')} (credit cards and personal loans${hint.includes('mortgage') ? ', mortgage' : ''}) move by ${delta} points, adding ${usd(extra)} of interest a month.`);
      break;
    }
  }

  effect.upfront_cash = round2(oneTime.reduce((s, x) => s + x, 0));
  let running = 0;
  const path: SimPoint[] = [];
  let lowest = { month: 0, balance: Infinity };
  let runsOut: SimResult['runs_out'] = null;
  for (let m = 0; m <= months; m++) {
    running += oneTime[m]! + monthly[m]!;
    const baseline = start + flow.monthly_net * m;
    const scenario = baseline + running;
    if (scenario < lowest.balance) lowest = { month: m, balance: scenario };
    if (scenario < 0 && !runsOut) runsOut = { month: m, date: addMonthsIso(data.asOf, m) };
    path.push({ month: m, baseline: round2(baseline), scenario: round2(scenario) });
  }
  effect.monthly_change = round2(monthly[months]!);
  const last = path[path.length - 1]!;
  const coverage = flow.monthly_out > 0 ? Math.max(0, round2(lowest.balance / flow.monthly_out)) : 0;
  // Positive cash at the low point is not enough: if the plan leaves under 3 months of spending AND the household is still
  // losing money every month at the end (the balance keeps falling after the horizon), that is not "manageable".
  const finalMonthlyNet = round2(flow.monthly_net + effect.monthly_change);
  const keepsFalling = finalMonthlyNet < 0;
  const draining = keepsFalling && coverage < 3;
  const risky = riskyGoal(`${opts.text ?? ''} ${scn.label ?? ''}`);
  const verdict: SimVerdict = risky ? 'not_advised' : unclear ? 'unclear' : lowest.balance < 0 ? 'shortfall' : coverage < 1 || draining ? 'tight' : 'comfortable';

  const label = scn.label ?? scn.kind.replace('_', ' ');
  const upfrontNeed = -Math.min(0, oneTime[effect.upfront_month] ?? 0);
  const shortRightAway = runsOut !== null && runsOut.month === effect.upfront_month && upfrontNeed > 0;
  const availableThen = round2(path[effect.upfront_month]!.scenario + upfrontNeed); // cash just before the one-time payment
  const headline =
    verdict === 'not_advised'
      ? `${label}: not advised. ${risky!.why}`
      : verdict === 'unclear'
        ? `I could not tell what change "${label}" would make to your money, so there is nothing to simulate yet. Please rephrase it with an amount, for example "Buy a $30,000 car in January", "Cancel $150 a month of subscriptions" or "Pay off the car loan".`
        : verdict === 'shortfall'
          ? shortRightAway
            ? `${label}: needs ${usd(upfrontNeed)} ${when(effect.upfront_month)} but checking and savings would hold about ${usd(Math.max(0, availableThen))}, so you would be ${usd(-path[effect.upfront_month]!.scenario)} short ${effect.upfront_month ? 'then' : 'right away'}.`
            : `${label}: cash would run out around ${monthYear(runsOut!.date)} (month ${runsOut!.month})${keepsFalling ? ` and keep falling by about ${usd(-finalMonthlyNet)} a month after that` : `, with the lowest point ${usd(lowest.balance)} in month ${lowest.month}`}.`
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
    runs_out: runsOut,
    keeps_falling: keepsFalling,
    verdict,
    ...(risky ? { caution: risky.why } : {}),
    headline,
  };
}

export const simulateScenario = defineTool({
  name: 'simulate_scenario',
  description:
    'Run a what-if over 12-24 months against the household cash flow: a purchase (cash or financed), an income change, a change in monthly spending, paying off one debt or all of them, a new loan, or an interest-rate change. Returns the cash path vs baseline, the low point and a verdict.',
  schema: ScenarioSchema,
  describe: (a) => `Simulating: ${a.label ?? a.kind.replace('_', ' ')}${a.amount ? ` (${usd(a.amount)})` : ''}`,
  run: (a, { data }) => simulate(a, data),
  summarize: (r: SimResult) => r.headline,
});
