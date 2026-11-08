// save_what_if: put a what-if in the What-If Studio, exactly as typing it under "What if we..." there does (a `scenario` row plus a queued
// `what_if` job; the worker then parses it, simulates it against the real cash flow and posts the result for everyone). Brian already has
// simulate_scenario for an instant spoken answer; this keeps the scenario for the family. The question is plain words, like the Studio's box.
import { z } from 'zod';
import { truncate } from '../util.js';
import { gate, needsAct, spend } from './confirm.js';
import { defineTool } from './registry.js';

const MAX_AMOUNT = 10_000_000; // the biggest dollar figure a saved question may carry, by voice (a mis-heard "million")
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The largest dollar figure written in the question ("$18,000", "$32k", "$1.2 million"), or 0 if there is none. */
export function biggestAmount(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|mm|million|b|billion)?\b/gi)) {
    const unit = (m[2] ?? '').toLowerCase();
    const mult = unit === 'k' || unit === 'thousand' ? 1e3 : unit.startsWith('m') ? 1e6 : unit.startsWith('b') ? 1e9 : 1;
    max = Math.max(max, Number(m[1]!.replace(/,/g, '')) * mult);
  }
  return max;
}

export const saveWhatIf = defineTool({
  name: 'save_what_if',
  description: 'Save a what-if to the What-If Studio so the whole family sees it with its result. The question is the decision in plain words with its numbers, like "Buy an $18,000 truck, financed over 60 months". Only after the caller said yes to saving exactly this: set confirmed to true.',
  schema: z.object({
    question: z.string().min(6).max(300).describe('The decision with its numbers, as typed under "What if we..." in the Studio'),
    confirmed: z.boolean().describe('true only after the caller confirmed saving this exact question'),
  }),
  describe: (a) => `Saving a what-if to the Studio: "${truncate(a.question, 80)}"`,
  run: async (a, ctx) => {
    needsAct(ctx);
    const question = clean(a.question);
    if (biggestAmount(question) > MAX_AMOUNT) return { done: false, note: 'That amount looks too large to be right. Ask the caller to say the figure again.' };
    const key = `whatif:${question.toLowerCase().replace(/[^a-z0-9$%. ]/g, '')}`;
    const ask = gate(ctx.act, key, a.confirmed, `Save "${question}" to the What-If Studio?`);
    if (ask) return ask;
    await ctx.act.saveWhatIf(question);
    spend(ctx.act, key);
    return { done: true, question, note: 'It is in the What-If Studio now. The agents are running it, and the result shows up there in a few seconds.' };
  },
  summarize: (r) => (r.done ? `Saved to the What-If Studio: "${truncate(r.question, 80)}"` : r.ask ? `Asked first: ${r.ask}` : `Not saved: ${r.note}`),
});

export const studioTools = [saveWhatIf];
export const STUDIO_WRITE_TOOLS = ['save_what_if'];
