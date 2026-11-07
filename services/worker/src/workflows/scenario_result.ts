// Shared by the what_if workflow and the proposal check: the narrative schema, the verdict mapping and the
// web-shaped result (apps/web/lib/types.ts ScenarioResult).
import { z } from 'zod';
import type { RunContext } from '../agent/run.js';
import type { SimResult } from '../tools/simulate.js';
import { usd } from '../util.js';

export const NarrativeSchema = z.object({
  summary: z.string().min(10).max(520).describe('2-4 plain-language sentences with the key numbers'),
  suggestion: z.string().max(260).describe('One concrete next step or adjustment'),
});

export type WebVerdict = 'fine' | 'tight' | 'risky';
export const VERDICT: Record<SimResult['verdict'], WebVerdict> = { comfortable: 'fine', tight: 'tight', shortfall: 'risky' };

/** The JSON the web app renders from scenario.result_json (apps/web/lib/types.ts ScenarioResult) plus extras. */
export function buildScenarioResult(sim: SimResult, narrative: { summary: string; suggestion: string }, data: RunContext['data']): Record<string, unknown> {
  const e = sim.effect;
  const metrics: { label: string; before?: number; after: number; unit: 'usd' | 'months' | 'pct' }[] = [
    { label: `Cash in month ${sim.months}`, before: sim.ending.baseline, after: sim.ending.scenario, unit: 'usd' },
    { label: 'Lowest cash balance', before: Math.min(...sim.series.map((p) => p.baseline)), after: sim.lowest.balance, unit: 'usd' },
    { label: 'Monthly cash flow', before: sim.baseline.monthly_net, after: Math.round((sim.baseline.monthly_net + e.monthly_change) * 100) / 100, unit: 'usd' },
    { label: 'Months of spending covered at the low point', after: sim.months_of_spending_covered_at_low, unit: 'months' },
  ];
  if (e.monthly_payment) metrics.push({ label: 'New monthly payment', after: e.monthly_payment, unit: 'usd' });
  if (e.total_interest) metrics.push({ label: 'Total interest over the loan', after: e.total_interest, unit: 'usd' });
  if (e.interest_saved) metrics.push({ label: `Interest saved in ${sim.months} months`, after: e.interest_saved, unit: 'usd' });
  const low = sim.series.find((p) => p.month === sim.lowest.month);
  return {
    summary: narrative.summary,
    verdict: VERDICT[sim.verdict],
    metrics,
    series: sim.series.map((p) => ({ date: p.date, baseline: p.baseline, scenario: p.scenario })),
    low_point: { date: low?.date ?? data.asOf, balance: sim.lowest.balance },
    suggestion: narrative.suggestion,
    scenario: sim.scenario,
    assumptions: sim.assumptions,
    headline: sim.headline,
  };
}

export function fallbackNarrative(sim: SimResult): { summary: string; suggestion: string } {
  const s = sim.scenario;
  const suggestion =
    sim.verdict === 'shortfall'
      ? s.kind === 'purchase' || s.kind === 'new_loan'
        ? 'Consider a larger down payment, a smaller amount or waiting until savings are higher.'
        : 'Build a larger cash cushion before this happens, or trim monthly spending.'
      : sim.verdict === 'tight'
        ? 'It works on paper but leaves little room; a bigger buffer would make it safer.'
        : 'This fits comfortably; keep the emergency fund untouched.';
  return { summary: `${sim.headline} Without changes you would have ${usd(sim.ending.baseline)} in month ${sim.months}; with this scenario ${usd(sim.ending.scenario)}.`, suggestion };
}
