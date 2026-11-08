// coach: answer the family's question by planning, calling tools and observing, then reply in the chat.
import { runAgentLoop } from '../agent/loop.js';
import { truncate } from '../util.js';
import { householdBrief, textCacheKey } from './common.js';
import { groundAnswer } from './grounding.js';
import type { WorkflowDef } from './types.js';

export const coachWorkflow: WorkflowDef = {
  name: 'coach',

  async cacheKey(run, job) {
    const text = String(job.input.text ?? '');
    return text ? textCacheKey(run, 'coach', text) : null;
  },

  onError(run, _job, err) {
    run.coachReply(`Sorry, I could not finish looking into that (${truncate(err.message, 120)}). Please try again in a moment.`);
  },

  async run(run, job) {
    const question = String(job.input.text ?? '').trim();
    if (!question) throw new Error('empty question');
    const brief = householdBrief(run);
    const res = await runAgentLoop(run, {
      agent: 'coach',
      task: 'coach',
      system:
        `You are Brianotron's family financial coach. ${brief}\n` +
        'GROUNDING (strict): every number you write (dollars, percentages, rates, dates, balances, payments) must be copied from a tool result in ' +
        'this conversation or from the brief above. Call the tools before answering: get_accounts for balances, interest rates, limits and payments; ' +
        'get_obligations for bills; get_health_indicators for health; get_forecast for the cash outlook; simulate_scenario for what-ifs. ' +
        'Never estimate, never use "typical" or industry values, never do arithmetic that produces a new figure the tools did not return. ' +
        'If the tools do not have something, say you do not have it. If the user says a figure is wrong, re-check with the tools and say what the data shows. ' +
        'Use account and bill names exactly as the tools give them.\n' +
        'Be concise (under 150 words), plain language, dollars not jargon. You are not a licensed financial advisor; never give investment advice. ' +
        'If a tool returns a "fixed_table" or "cache" source, say the figure is a reference value.',
      user: question,
      tools: run.registry.names(),
      local: { question, asOf: run.data.asOf },
    });
    const answer = await groundAnswer(run, { agent: 'coach', answer: res.answer, results: res.results, question, brief });
    run.coachReply(answer);
    return { answer, steps: res.steps, tools_used: res.toolsUsed };
  },
};
