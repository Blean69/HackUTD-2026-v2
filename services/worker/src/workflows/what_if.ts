// what_if: natural-language question -> structured Scenario -> simulate against real cash flow -> narrative + chart data.
import { z } from 'zod';
import { emitPlan } from '../agent/loop.js';
import type { RunContext } from '../agent/run.js';
import { structured } from '../llm/structured.js';
import { DEBT_TYPES } from '../tools/finance.js';
import { ScenarioSchema, type Scenario, type SimResult } from '../tools/simulate.js';
import { truncate, usd } from '../util.js';
import { householdBrief, textCacheKey } from './common.js';
import type { WorkflowDef } from './types.js';

const NarrativeSchema = z.object({
  summary: z.string().min(10).max(520).describe('2-4 plain-language sentences with the key numbers'),
  suggestion: z.string().max(260).describe('One concrete next step or adjustment'),
});

export type WebVerdict = 'fine' | 'tight' | 'risky';
const VERDICT: Record<SimResult['verdict'], WebVerdict> = { comfortable: 'fine', tight: 'tight', shortfall: 'risky' };

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

function fallbackNarrative(sim: SimResult): { summary: string; suggestion: string } {
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

export const whatIfWorkflow: WorkflowDef = {
  name: 'what_if',

  async cacheKey(run, job) {
    const prompt = String(job.input.prompt ?? '');
    return prompt ? textCacheKey(run, 'what_if', prompt) : null;
  },

  onError(run, _job, err) {
    run.scenario('error', JSON.stringify({ summary: `The simulation could not finish: ${truncate(err.message, 200)}`, verdict: 'tight' }));
  },

  async run(run, job) {
    const prompt = String(job.input.prompt ?? '').trim();
    if (!prompt) throw new Error('empty what-if prompt');
    run.scenario('running', '');

    await emitPlan(run, {
      agent: 'planner',
      task: 'what_if',
      system: `You are the planner for Keystone's what-if simulator. ${householdBrief(run)}`,
      user: `The family asked: "${prompt}". Plan how to answer it with real numbers.`,
      toolNames: ['simulate_scenario', 'get_forecast', 'get_health_indicators'],
      local: { plan: ['Parse the question into a structured scenario (fast Nemotron, structured output)', 'Simulate it against 12 to 24 months of the household\'s real cash flow (simulate_scenario)', 'Cross-check with the 90-day forecast (get_forecast)', 'Explain the result in plain language and save it for everyone in the room'] },
    });

    run.handoff('planner', 'simulator', 'Parsing the question into a scenario');
    const debts = run.data.accounts.filter((a) => DEBT_TYPES.has(a.type)).map((a) => `${a.id} (${a.type}, "${a.nickname}", balance ${a.balance}${a.rate_pct !== undefined ? `, ${a.rate_pct}%` : ''})`);
    const parsed = await structured(run.llm, {
      name: 'define_scenario',
      description: 'Describe the what-if scenario the family asked about',
      schema: ScenarioSchema,
      role: 'fast',
      task: 'scenario.parse',
      local: { prompt },
      messages: [
        { role: 'system', content: `Convert the family's what-if question into a scenario by calling define_scenario. kind: purchase | income_change | payoff | new_loan | rate_change. Use dollars. For financed purchases set financed=true plus down_payment, apr_pct, term_months when stated. For income_change use income_change_pct (negative for a drop) or income_change_monthly, plus duration_months if it is temporary. For payoff set account_hint to an account id, nickname or type. months is the horizon (12 to 24). Debts on file: ${debts.join('; ') || 'none'}. Today is ${run.data.asOf}.` },
        { role: 'user', content: prompt },
      ],
    });
    run.noteLlm({ content: '', toolCalls: [], provider: parsed.meta.provider, model: parsed.meta.model, latencyMs: parsed.meta.latencyMs, tokensIn: parsed.meta.tokensIn, tokensOut: parsed.meta.tokensOut });
    const scn: Scenario = parsed.value;
    run.emit('simulator', 'message', `Understood: ${scn.label ?? scn.kind.replace('_', ' ')} (${scn.kind.replace('_', ' ')}${scn.amount ? `, ${usd(scn.amount)}` : ''})`, { scenario: scn }, { model: parsed.meta.model, provider: parsed.meta.provider, latencyMs: parsed.meta.latencyMs, tokensIn: parsed.meta.tokensIn, tokensOut: parsed.meta.tokensOut });

    const out = await run.tool('simulator', 'simulate_scenario', scn);
    if (!out.ok) throw new Error(out.error);
    const sim = out.result as SimResult;
    await run.tool('simulator', 'get_forecast', {});

    let narrative = fallbackNarrative(sim);
    try {
      const n = await structured(run.llm, {
        name: 'write_answer',
        description: 'Write the answer shown to the family',
        schema: NarrativeSchema,
        role: 'agent',
        task: 'narrative',
        local: narrative,
        maxTokens: 700,
        messages: [
          { role: 'system', content: 'You explain what-if results to a family in plain, calm language. Use only the numbers provided, mention the lowest cash point and the monthly effect, then give one concrete suggestion. No jargon, no investment advice. All data is synthetic.' },
          { role: 'user', content: JSON.stringify({ question: prompt, headline: sim.headline, verdict: sim.verdict, assumptions: sim.assumptions, baseline: sim.baseline, effect: sim.effect, lowest: sim.lowest, ending: sim.ending }) },
        ],
      });
      narrative = n.value;
      run.noteLlm({ content: '', toolCalls: [], provider: n.meta.provider, model: n.meta.model, latencyMs: n.meta.latencyMs, tokensIn: n.meta.tokensIn, tokensOut: n.meta.tokensOut });
      run.emit('simulator', 'message', `Answer: ${truncate(narrative.summary, 200)}`, narrative, { model: n.meta.model, provider: n.meta.provider, latencyMs: n.meta.latencyMs, tokensIn: n.meta.tokensIn, tokensOut: n.meta.tokensOut });
    } catch {
      run.emit('simulator', 'message', 'Narrative step failed; using the standard summary', {});
    }

    const result = buildScenarioResult(sim, narrative, run.data);
    run.scenario('done', JSON.stringify(result));
    run.emit('simulator', 'final', sim.headline, { verdict: result.verdict, lowest: sim.lowest, ending: sim.ending, suggestion: narrative.suggestion });
    return { scenario: scn, verdict: result.verdict as string, headline: sim.headline, summary: narrative.summary };
  },
};
