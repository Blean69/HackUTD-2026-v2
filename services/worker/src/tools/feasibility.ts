// goal_feasibility: target amount + date vs the household's saving capacity and forecast.
import { z } from 'zod';
import type { HouseholdData } from '../types.js';
import { monthsBetween, round2, usd } from '../util.js';
import { cashFlow, savingsBalance } from './finance.js';
import { defineTool } from './registry.js';

export const FeasibilityArgs = z.object({
  title: z.string().optional(),
  target_amount: z.number().min(0).describe('Total amount needed in USD'),
  target_date: z.string().describe('YYYY-MM-DD deadline'),
  current_saved: z.number().min(0).optional().describe('Already set aside for this goal (default: all savings + CDs)'),
  monthly_contribution: z.number().min(0).optional().describe('Monthly amount the family can dedicate (default: measured monthly surplus)'),
});
export type FeasibilityArgs = z.infer<typeof FeasibilityArgs>;

export interface FeasibilityResult {
  feasibility: 'on_track' | 'stretch' | 'off_track';
  target_amount: number;
  target_date: string;
  months_left: number;
  current_saved: number;
  still_needed: number;
  required_monthly: number;
  available_monthly: number;
  coverage_ratio: number;
  projected_at_target_date: number;
  shortfall_at_target_date: number;
  basis: string;
  explanation: string;
}

/** Monthly capacity the household can realistically put toward goals: the lower of history-based surplus and the DB forecast trend. */
export function monthlyCapacity(data: HouseholdData): { surplus: number; history: number; forecast: number | null } {
  const history = cashFlow(data).monthly_net;
  let forecast: number | null = null;
  const pts = [...data.forecast].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (pts.length >= 14) {
    const months = monthsBetween(pts[0]!.date, pts[pts.length - 1]!.date);
    if (months > 0.5) forecast = round2((pts[pts.length - 1]!.balance - pts[0]!.balance) / months);
  }
  const candidates = [history, ...(forecast !== null ? [forecast] : [])];
  return { surplus: Math.max(0, round2(Math.min(...candidates))), history, forecast };
}

export function goalFeasibility(a: FeasibilityArgs, data: HouseholdData): FeasibilityResult {
  const months = Math.max(0.5, monthsBetween(data.asOf, a.target_date));
  const cap = monthlyCapacity(data);
  const saved = a.current_saved ?? savingsBalance(data);
  const available = a.monthly_contribution ?? cap.surplus;
  const stillNeeded = Math.max(0, round2(a.target_amount - saved));
  const required = round2(stillNeeded / months);
  const projected = round2(saved + available * months);
  const ratio = required <= 0 ? 99 : round2(available / required);
  const feasibility = stillNeeded <= 0 || ratio >= 1 ? 'on_track' : ratio >= 0.6 ? 'stretch' : 'off_track';
  const basis =
    a.monthly_contribution !== undefined
      ? 'monthly amount supplied by the caller'
      : `measured surplus ${usd(cap.history)}/mo${cap.forecast !== null ? ` and forecast trend ${usd(cap.forecast)}/mo (the lower is used)` : ''}`;
  const explanation =
    feasibility === 'on_track'
      ? stillNeeded <= 0
        ? `Already covered: ${usd(saved)} saved against ${usd(a.target_amount)}.`
        : `Needs ${usd(required)}/mo for ${Math.round(months)} months; capacity is ${usd(available)}/mo.`
      : feasibility === 'stretch'
        ? `Needs ${usd(required)}/mo but only ${usd(available)}/mo is available (${Math.round(ratio * 100)}%); a bigger contribution or a later date would close the gap.`
        : `Needs ${usd(required)}/mo but only ${usd(available)}/mo is available (${Math.round(ratio * 100)}%); at this pace the family would have about ${usd(projected)} by the deadline.`;
  return {
    feasibility,
    target_amount: a.target_amount,
    target_date: a.target_date,
    months_left: round2(months),
    current_saved: round2(saved),
    still_needed: stillNeeded,
    required_monthly: required,
    available_monthly: round2(available),
    coverage_ratio: ratio,
    projected_at_target_date: projected,
    shortfall_at_target_date: Math.max(0, round2(a.target_amount - projected)),
    basis,
    explanation,
  };
}

export const goalFeasibilityTool = defineTool({
  name: 'goal_feasibility',
  description:
    'Check a savings goal (target amount by a date) against the household savings and cash flow. Returns on_track, stretch or off_track with the monthly amount needed vs available.',
  schema: FeasibilityArgs,
  describe: (a) => `Checking feasibility${a.title ? ` of "${a.title}"` : ''}: ${usd(a.target_amount)} by ${a.target_date}`,
  run: (a, { data }) => goalFeasibility(a, data),
  summarize: (r: FeasibilityResult) => `${r.feasibility.replace('_', ' ')}: needs ${usd(r.required_monthly)}/mo, has ${usd(r.available_monthly)}/mo`,
});
