// coach: answer the family's question by planning, calling tools and observing, then reply in the chat.
import { runAgentLoop } from '../agent/loop.js';
import { truncate } from '../util.js';
import { householdBrief, textCacheKey } from './common.js';
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
    const res = await runAgentLoop(run, {
      agent: 'coach',
      task: 'coach',
      system: `You are Keystone's family financial coach. ${householdBrief(run)} Answer using the tools so every number comes from the household's real data. Be concise (under 150 words), plain language, dollars not jargon. You are not a licensed financial advisor; never give investment advice. If a tool returns a "fixed_table" or "cache" source, say the figure is a reference value.`,
      user: question,
      tools: run.registry.names(),
      local: { question, asOf: run.data.asOf },
    });
    run.coachReply(res.answer);
    return { answer: res.answer, steps: res.steps, tools_used: res.toolsUsed };
  },
};
