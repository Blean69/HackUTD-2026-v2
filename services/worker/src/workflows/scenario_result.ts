// Shared by the what_if workflow and the proposal check: the narrative schema, the verdict mapping and the
// web-shaped result (apps/web/lib/types.ts ScenarioResult).
import { z } from 'zod';
import type { RunContext } from '../agent/run.js';
import type { SimResult } from '../tools/simulate.js';
import { monthYear, usd } from '../util.js';

export const NarrativeSchema = z.object({
  summary: z.string().min(10).max(520).describe('2-4 plain-language sentences with the key numbers'),
  suggestion: z.string().max(260).describe('One concrete next step or adjustment'),
});

/** "unclear" = the question could not be turned into a change; the web shows the summary (asking to rephrase) without a verdict banner. */
export type WebVerdict = 'fine' | 'tight' | 'risky' | 'unclear';
export const VERDICT: Record<SimResult['verdict'], WebVerdict> = { comfortable: 'fine', tight: 'tight', shortfall: 'risky', not_advised: 'risky', unclear: 'unclear' };

/** What the narrative model is told about the result: the figures plus plain flags so it never calls a still-falling balance a "low point". */
export function narrativeFacts(sim: SimResult): Record<string, unknown> {
  return {
    headline: sim.headline,
    verdict: sim.verdict,
    assumptions: sim.assumptions,
    household_cash_flow: { ...sim.baseline, note: "These are your household's monthly figures (all income and spending), not the income of any one project or business." },
    effect: sim.effect,
    lowest_in_projection: sim.lowest,
    ending: sim.ending,
    runs_out: sim.runs_out ? { month: sim.runs_out.month, when: monthYear(sim.runs_out.date) } : null,
    keeps_falling: sim.keeps_falling,
    ...(sim.keeps_falling ? { keeps_falling_note: `Cash is still falling every month when the ${sim.months}-month projection ends, so the month-${sim.months} figure is NOT a low point: say the balance keeps falling (and when it runs out), never "the lowest point is in month ${sim.months}".` } : {}),
  };
}

/** The JSON the web app renders from scenario.result_json (apps/web/lib/types.ts ScenarioResult) plus extras. */
export function buildScenarioResult(sim: SimResult, narrative: { summary: string; suggestion: string }, data: RunContext['data']): Record<string, unknown> {
  const e = sim.effect;
  if (sim.verdict === 'unclear') {
    // nothing was simulated: no chart and no metrics that would read as "nothing changes, all fine"
    return { summary: narrative.summary, verdict: VERDICT.unclear, metrics: [], series: [], suggestion: narrative.suggestion, scenario: sim.scenario, assumptions: sim.assumptions, headline: sim.headline };
  }
  const lowLabel = sim.keeps_falling && sim.lowest.month === sim.months ? `Cash in month ${sim.months} (still falling)` : 'Lowest cash balance';
  const metrics: { label: string; before?: number; after: number; unit: 'usd' | 'months' | 'pct' }[] = [
    { label: `Cash in month ${sim.months}`, before: sim.ending.baseline, after: sim.ending.scenario, unit: 'usd' },
    ...(lowLabel === 'Lowest cash balance' ? [{ label: lowLabel, before: Math.min(...sim.series.map((p) => p.baseline)), after: sim.lowest.balance, unit: 'usd' as const }] : []),
    { label: 'Monthly cash flow', before: sim.baseline.monthly_net, after: Math.round((sim.baseline.monthly_net + e.monthly_change) * 100) / 100, unit: 'usd' },
    { label: sim.runs_out ? 'Months of spending covered at the low point (cash runs out)' : 'Months of spending covered at the low point', after: Math.max(0, sim.months_of_spending_covered_at_low), unit: 'months' },
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
    ...(sim.verdict === 'not_advised' ? { advice: 'not_advised', caution: sim.caution } : {}),
    ...(sim.runs_out ? { runs_out: sim.runs_out } : {}),
    ...(sim.keeps_falling ? { keeps_falling: true } : {}),
  };
}

export const NOT_ADVISED_SUGGESTION = 'Keep that money for your bills, savings and goals. If it would hurt to lose it, it is not money to risk.';
export const UNCLEAR_SUGGESTION = 'Say what changes and by how much: a purchase and its price, a monthly bill you would cut, an income change, or a debt to pay off.';

export function fallbackNarrative(sim: SimResult): { summary: string; suggestion: string } {
  const s = sim.scenario;
  if (sim.verdict === 'not_advised') return { summary: sim.headline, suggestion: NOT_ADVISED_SUGGESTION };
  if (sim.verdict === 'unclear') return { summary: sim.headline, suggestion: UNCLEAR_SUGGESTION };
  const suggestion =
    sim.verdict === 'shortfall'
      ? s.kind === 'purchase' || s.kind === 'new_loan'
        ? 'Consider a larger down payment, a smaller amount or waiting until savings are higher.'
        : s.kind === 'payoff'
          ? 'Pay it off in steps you can cover, starting with the highest-rate debt, and keep the emergency fund untouched.'
          : 'Build a larger cash cushion before this happens, or trim monthly spending.'
      : sim.verdict === 'tight'
        ? 'It works on paper but leaves little room; a bigger buffer would make it safer.'
        : 'This fits comfortably; keep the emergency fund untouched.';
  return { summary: `${sim.headline} Without changes you would have ${usd(sim.ending.baseline)} in month ${sim.months}; with this scenario ${usd(sim.ending.scenario)}.`, suggestion };
}
