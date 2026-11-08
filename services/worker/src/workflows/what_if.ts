// what_if: natural-language question -> structured Scenario -> simulate against real cash flow -> narrative + chart data.
// A what_if job whose input carries a `proposal_id` is a Family-voting affordability check (proposal_check.ts) instead.
import { guardNarrative } from './advice_guard.js';
import { emitPlan } from '../agent/loop.js';
import { allCashPhrase, debtScopeHint, findMoney, keepsLoanInCash, loanAmount, spendingCutMonthly, statedMonthOffset, statesRate, statesTerm } from '../llm/rules.js';
import { structured } from '../llm/structured.js';
import { DEBT_TYPES, liquidBalance } from '../tools/finance.js';
import { riskyGoal } from '../tools/risky.js';
import { ScenarioSchema, type Scenario, type SimResult } from '../tools/simulate.js';
import type { HouseholdData, ProposalItem } from '../types.js';
import { truncate, usd } from '../util.js';
import { householdBrief, textCacheKey } from './common.js';
import { NarrativeSchema, NOT_ADVISED_SUGGESTION, UNCLEAR_SUGGESTION, buildScenarioResult, fallbackNarrative, narrativeFacts } from './scenario_result.js';
import { proposalCacheKey, proposalOnError, proposalScenario, readProposal, runProposalCheck } from './proposal_check.js';
import type { WorkflowDef } from './types.js';

const STOP = new Set(['with', 'that', 'this', 'from', 'have', 'what', 'would', 'could', 'should', 'take', 'open', 'about', 'afford', 'much', 'into', 'loan', 'loans', 'their', 'there', 'they', 'them', 'make', 'some', 'more', 'buy', 'pay', 'spend']);
const words = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)));

/**
 * The family vote this what-if is about, if any: same amount (within 1%) for a loan or financed purchase, or, when the question
 * gives no amount, at least two shared words with the proposal's title or purpose ("Open a second bakery location" and
 * "Take the SBA loan for the second bakery location"). Its terms then drive the what-if, so the vote and the what-if agree.
 */
export function matchingProposal(data: HouseholdData, prompt: string, scn: Scenario): ProposalItem | null {
  const props = [...(data.proposals ?? [])].sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1));
  const asked = words(prompt);
  for (const p of props) {
    const d = p.details ?? {};
    const hasTerms = d.rate_pct !== undefined || d.term_months !== undefined || d.kind === 'loan' || d.financed === true;
    if (scn.amount && p.amount > 0 && Math.abs(scn.amount - p.amount) <= p.amount * 0.01 && hasTerms && (scn.kind === 'new_loan' || (scn.kind === 'purchase' && scn.financed))) return p;
    if (!scn.amount && (scn.kind === 'purchase' || scn.kind === 'new_loan')) {
      const theirs = words(`${p.title} ${typeof d.purpose === 'string' ? d.purpose : ''}`);
      if ([...asked].filter((w) => theirs.has(w)).length >= 2) return p;
    }
  }
  return null;
}

/**
 * Deterministic corrections on top of the parsed scenario, so the same words always mean the same change whichever model parsed
 * them: "pay off all debt" covers every debt; "cancel ... to save $150 a month" is a spending cut (never lost income); "with a
 * $250,000 loan" is borrowed money spent on the project; loan terms the family did not state come from the matching family vote
 * or the shared defaults (never a model's guess); "in January" moves the change to January; "all of our cash" is the liquid balance.
 */
export function refineScenario(prompt: string, parsed: Scenario, data: HouseholdData): { scn: Scenario; notes: string[] } {
  let scn: Scenario = { ...parsed };
  const notes: string[] = [];
  const label = scn.label ?? truncate(prompt.replace(/\s+/g, ' ').replace(/[?.!]+$/, ''), 90);
  const said = findMoney(prompt);

  const scope = debtScopeHint(prompt);
  const cut = scope ? null : spendingCutMonthly(prompt);
  const borrowed = scope || cut !== null ? null : loanAmount(prompt);
  if (scope) {
    scn = { kind: 'payoff', label, account_hint: scope, months: scn.months ?? 12, ...(said[0] ? { amount: said[0].value } : {}) };
  } else if (cut !== null) {
    scn = { kind: 'spending_change', label, spending_change_monthly: cut, months: scn.months ?? 12, ...(scn.duration_months ? { duration_months: scn.duration_months } : {}) };
  } else if (borrowed !== null) {
    const price = scn.kind === 'purchase' ? scn.amount : undefined;
    scn =
      price && price > borrowed
        ? { ...scn, kind: 'purchase', financed: true, down_payment: price - borrowed } // "a $300k house with a $240k loan"
        : { kind: 'new_loan', label, amount: borrowed, months: 24, ...(scn.apr_pct !== undefined ? { apr_pct: scn.apr_pct } : {}), ...(scn.term_months !== undefined ? { term_months: scn.term_months } : {}) };
  }

  if (scn.kind === 'new_loan' || scn.kind === 'purchase') {
    if (scn.kind === 'new_loan') scn.proceeds_to_cash = keepsLoanInCash(prompt);
    if (!statesRate(prompt)) delete scn.apr_pct;
    if (!statesTerm(prompt)) delete scn.term_months;
    const vote = matchingProposal(data, prompt, scn);
    if (vote) {
      const fromVote = proposalScenario({ id: vote.id, title: vote.title, amount: vote.amount, details: vote.details ?? {}, createdBy: vote.created_by_name });
      const d = vote.details ?? {};
      if (!scn.amount) {
        scn = { ...fromVote, label, ...(scn.start_month !== undefined ? { start_month: scn.start_month } : {}) };
        notes.push(`Amount and terms from the family vote "${truncate(vote.title, 80)}": ${usd(vote.amount)}${d.rate_pct !== undefined ? ` at ${d.rate_pct}%` : ''}${d.term_months !== undefined ? ` over ${d.term_months} months` : ''}.`);
      } else if (fromVote.kind === scn.kind || (fromVote.kind === 'new_loan' && scn.kind === 'purchase')) {
        const before = JSON.stringify(scn);
        if (scn.apr_pct === undefined && fromVote.apr_pct !== undefined) scn.apr_pct = fromVote.apr_pct;
        if (scn.term_months === undefined && fromVote.term_months !== undefined) scn.term_months = fromVote.term_months;
        if (scn.kind === 'purchase' && scn.down_payment === undefined && fromVote.kind === 'purchase' && fromVote.down_payment !== undefined) scn.down_payment = fromVote.down_payment;
        if (JSON.stringify(scn) !== before) notes.push(`Loan terms from the family vote "${truncate(vote.title, 80)}"${scn.apr_pct !== undefined ? `: ${scn.apr_pct}%` : ''}${scn.term_months !== undefined ? ` over ${scn.term_months} months` : ''}.`);
      }
    }
  }

  if (scn.kind === 'purchase' && !scn.amount && allCashPhrase(prompt)) {
    scn = { ...scn, amount: liquidBalance(data), financed: false };
    notes.push(`"All of your cash" is the ${usd(liquidBalance(data))} in checking and savings.`);
  }

  const at = statedMonthOffset(prompt, data.asOf);
  if (at !== null && (scn.kind === 'purchase' || scn.kind === 'payoff' || scn.kind === 'new_loan' || at > 0)) {
    scn.start_month = at;
    scn.months = Math.min(24, Math.max(scn.months ?? 12, at + 12));
  }
  return { scn: ScenarioSchema.parse(scn), notes };
}

/** A gambling or speculation what-if: the verdict says "not advised" with the reason, whatever the cash path looks like. */
export function markNotAdvised(sim: SimResult, why: string): SimResult {
  const label = sim.scenario.label ?? 'This plan';
  return { ...sim, verdict: 'not_advised', caution: why, headline: `${label}: not advised. ${why}` };
}

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
      system: `You are the planner for Brianotron's what-if simulator. ${householdBrief(run)}`,
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
      local: { prompt, asOf: run.data.asOf },
      messages: [
        {
          role: 'system',
          content:
            `Convert the family's what-if question into a scenario by calling define_scenario. kind: purchase | income_change | spending_change | payoff | new_loan | rate_change. Use dollars. ` +
            'For financed purchases set financed=true plus down_payment, apr_pct, term_months ONLY when stated (never guess them). A loan taken to buy or open something is new_loan with the loan amount; its money is spent on that (proceeds_to_cash false). ' +
            'For income_change use income_change_pct (negative for a drop) or income_change_monthly, plus duration_months if it is temporary. Cutting, cancelling or saving on bills ("cancel cable to save $150 a month") is spending_change with spending_change_monthly negative (-150), never an income change. ' +
            'For payoff set account_hint to an account id, nickname or type, or "all" when they mean every debt. If they name a month ("in January"), set start_month to the months from today. months is the horizon (12 to 24). ' +
            `Debts on file: ${debts.join('; ') || 'none'}. Today is ${run.data.asOf}.`,
        },
        { role: 'user', content: prompt },
      ],
    });
    run.noteLlm({ content: '', toolCalls: [], provider: parsed.meta.provider, model: parsed.meta.model, latencyMs: parsed.meta.latencyMs, tokensIn: parsed.meta.tokensIn, tokensOut: parsed.meta.tokensOut });
    const { scn, notes } = refineScenario(prompt, parsed.value, run.data);
    run.emit('simulator', 'message', `Understood: ${scn.label ?? scn.kind.replace('_', ' ')} (${scn.kind.replace('_', ' ')}${scn.amount ? `, ${usd(scn.amount)}` : ''})`, { scenario: scn, ...(notes.length ? { notes } : {}), parsed: parsed.value }, { model: parsed.meta.model, provider: parsed.meta.provider, latencyMs: parsed.meta.latencyMs, tokensIn: parsed.meta.tokensIn, tokensOut: parsed.meta.tokensOut });

    const out = await run.tool('simulator', 'simulate_scenario', scn);
    if (!out.ok) throw new Error(out.error);
    let sim = out.result as SimResult;
    if (notes.length) sim = { ...sim, assumptions: [...sim.assumptions, ...notes] };
    const risky = riskyGoal(prompt);
    if (risky && sim.verdict !== 'not_advised') sim = markNotAdvised(sim, risky.why);
    if (sim.verdict === 'not_advised') run.emit('simulator', 'message', `Not advised: ${sim.caution ?? ''}`, { caution: sim.caution });
    if (sim.verdict === 'unclear') run.emit('simulator', 'message', 'Could not tell what change the question describes; asking the family to rephrase', { scenario: scn });
    await run.tool('simulator', 'get_forecast', {});

    let narrative = fallbackNarrative(sim);
    if (sim.verdict === 'not_advised' || sim.verdict === 'unclear') {
      // deterministic: no model writes around a guardrail or guesses at a question it could not read
      narrative = { summary: sim.headline, suggestion: sim.verdict === 'not_advised' ? NOT_ADVISED_SUGGESTION : UNCLEAR_SUGGESTION };
    } else {
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
            { role: 'system', content: 'You explain what-if results to a family in plain, calm language, speaking to them as "you" and "your household". Use only the numbers provided, mention the lowest cash point (or, when keeps_falling is true, that cash keeps falling and when it runs out) and the monthly effect, then give one concrete suggestion. No jargon, no investment advice, never tell them to move money. All data is synthetic.' },
            { role: 'user', content: JSON.stringify({ question: prompt, ...narrativeFacts(sim) }) },
          ],
        });
        narrative = await guardNarrative(run, { agent: 'simulator', narrative: n.value, fallback: fallbackNarrative(sim), question: prompt, sources: [sim] });
        run.noteLlm({ content: '', toolCalls: [], provider: n.meta.provider, model: n.meta.model, latencyMs: n.meta.latencyMs, tokensIn: n.meta.tokensIn, tokensOut: n.meta.tokensOut });
        run.emit('simulator', 'message', `Answer: ${truncate(narrative.summary, 200)}`, narrative, { model: n.meta.model, provider: n.meta.provider, latencyMs: n.meta.latencyMs, tokensIn: n.meta.tokensIn, tokensOut: n.meta.tokensOut });
      } catch {
        run.emit('simulator', 'message', 'Narrative step failed; using the standard summary', {});
      }
    }

    const result = buildScenarioResult(sim, narrative, run.data);
    run.scenario('done', JSON.stringify(result));
    run.emit('simulator', 'final', sim.headline, { verdict: result.verdict, lowest: sim.lowest, ending: sim.ending, suggestion: narrative.suggestion });
    return { scenario: scn, verdict: result.verdict as string, headline: sim.headline, summary: narrative.summary };
  },
};
