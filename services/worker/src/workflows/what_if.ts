// what_if: natural-language question -> structured Scenario -> simulate against real cash flow -> narrative + chart data.
// A what_if job whose input carries a `proposal_id` is a Family-voting affordability check (proposal_check.ts) instead.
import { emitPlan } from '../agent/loop.js';
import type { RunContext } from '../agent/run.js';
import { structured } from '../llm/structured.js';
import { DEBT_TYPES } from '../tools/finance.js';
import { ScenarioSchema, type Scenario, type SimResult } from '../tools/simulate.js';
import { truncate, usd } from '../util.js';
import { householdBrief, textCacheKey } from './common.js';
import { NarrativeSchema, buildScenarioResult, fallbackNarrative } from './scenario_result.js';
import { proposalCacheKey, proposalOnError, readProposal, runProposalCheck } from './proposal_check.js';
import type { WorkflowDef } from './types.js';

export const whatIfWorkflow: WorkflowDef = {
  name: 'what_if',

  async cacheKey(run, job) {
    const proposal = readProposal(job);
    if (proposal) return proposalCacheKey(run, proposal);
    const prompt = String(job.input.prompt ?? '');
    return prompt ? textCacheKey(run, 'what_if', prompt) : null;
  },

  onError(run, job, err) {
    if (readProposal(job)) return proposalOnError(run, err);
    run.scenario('error', JSON.stringify({ summary: `The simulation could not finish: ${truncate(err.message, 200)}`, verdict: 'tight' }));
  },

  async run(run, job) {
    const proposal = readProposal(job);
    if (proposal) return runProposalCheck(run, proposal);
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
