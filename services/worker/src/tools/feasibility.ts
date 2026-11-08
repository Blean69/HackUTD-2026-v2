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
  monthly_contribution: z.number().min(0).optional().describe('Monthly amount the family can dedicate to this goal (default: the monthly surplus, the same figure as the dashboard\'s Cash flow tile)'),
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

/**
 * The household's monthly surplus: the dashboard's Cash flow figure (`cash_flow.net_monthly`, see tools/finance.ts cashFlow),
 * floored at 0 for "what can go toward goals". `net` keeps the sign, so a household losing money is never shown a surplus.
 */
export function monthlyCapacity(data: HouseholdData): { surplus: number; net: number; window_days: number } {
  const flow = cashFlow(data);
  return { surplus: Math.max(0, round2(flow.monthly_net)), net: flow.monthly_net, window_days: flow.window_days };
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
  const supplied = a.monthly_contribution !== undefined;
  // a supplied amount is what is set aside for THIS goal (e.g. what is left after earlier goals), never "the surplus"
  const have = supplied ? `${usd(available)}/mo is available for it` : `the monthly surplus is ${usd(available)}/mo`;
  const basis = supplied ? 'monthly amount available for this goal' : `monthly surplus ${usd(cap.net)}/mo over the last ${Math.round(cap.window_days)} days (the dashboard's Cash flow figure)`;
  const explanation =
    feasibility === 'on_track'
      ? stillNeeded <= 0
        ? `Already covered: ${usd(saved)} saved against ${usd(a.target_amount)}.`
        : `Needs ${usd(required)}/mo for ${Math.round(months)} months; ${have}.`
      : feasibility === 'stretch'
        ? `Needs ${usd(required)}/mo but ${have} (${Math.round(ratio * 100)}%); a bigger contribution or a later date would close the gap.`
        : `Needs ${usd(required)}/mo but ${have} (${Math.round(ratio * 100)}%); at this pace the family would have about ${usd(projected)} by the deadline.`;
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
  summarize: (r: FeasibilityResult, a) => `${r.feasibility.replace('_', ' ')}: needs ${usd(r.required_monthly)}/mo, ${a.monthly_contribution !== undefined ? `${usd(r.available_monthly)}/mo available for it` : `monthly surplus ${usd(r.available_monthly)}/mo`}`,
});
