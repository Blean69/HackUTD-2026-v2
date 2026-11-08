// Kids and teens tools (contracts.md section 12) for Brian: read the kids' chores and allowance jars, add a chore, put money in
// a jar. The jar is allowance bookkeeping inside the app, not a bank transfer. The two write tools need `confirmed: true` (Brian
// says the action back and waits for a yes) and the call session's `act` (no other agent can write).
import { z } from 'zod';
import type { HouseholdData, Member } from '../types.js';
import { round2, usd } from '../util.js';
import { defineTool, type ToolContext } from './registry.js';

const MAX_REWARD = 50; // per chore, by voice
const MAX_DEPOSIT = 100; // per deposit, by voice (the module allows up to 500 from the app)

export const isKid = (m: Member): boolean => /child|kid|teen/i.test(m.role) || (m.age > 0 && m.age < 18);
const first = (m: Member): string => m.name.split(/\s+/)[0] ?? m.name;

/** The kid the caller named, by first name (case-insensitive, prefix allowed: "Sof" finds Sofia). */
export function findKid(data: HouseholdData, name: string): Member | { error: string } {
  const kids = data.members.filter(isKid);
  if (!kids.length) return { error: 'This household has no kids or teens on file.' };
  const want = name.trim().toLowerCase().replace(/'s$/, '');
  const hit = kids.find((k) => first(k).toLowerCase() === want) ?? kids.find((k) => k.name.toLowerCase().startsWith(want) && want.length >= 3);
  return hit ?? { error: `No kid named "${name}". The kids are ${kids.map(first).join(' and ')}.` };
}

function jarOf(data: HouseholdData, memberId: string) {
  return (data.kid_jars ?? []).find((j) => j.member_id === memberId);
}

function needsAct(ctx: ToolContext): asserts ctx is ToolContext & { act: NonNullable<ToolContext['act']> } {
  if (!ctx.act) throw new Error('Changing chores or jars is only possible on a call with Brian.');
}

export const getKids = defineTool({
  name: 'get_kids',
  description: "The kids and teens: each one's open chores (with rewards), allowance jar balance and what they are saving for.",
  schema: z.object({}),
  describe: () => "Reading the kids' chores and jars",
  run: (_args, { data }) => ({
    kids: data.members.filter(isKid).map((k) => {
      const jar = jarOf(data, k.id);
      const tasks = (data.kid_tasks ?? []).filter((t) => t.member_id === k.id);
      return {
        name: first(k),
        age: k.age,
        jar_balance: round2(jar?.balance ?? 0),
        saving_for: jar?.goal_title ? { title: jar.goal_title, target: jar.goal_target } : null,
        open_chores: tasks.filter((t) => t.status === 'open').map((t) => ({ chore: t.title, reward: t.reward })),
        waiting_for_approval: tasks.filter((t) => t.status === 'done').map((t) => t.title),
      };
    }),
  }),
  summarize: (r) => `${r.kids.length} kid(s): ${r.kids.map((k: { name: string; jar_balance: number }) => `${k.name} ${usd(k.jar_balance)}`).join(', ') || 'none'}`,
});

export const addKidChore = defineTool({
  name: 'add_kid_chore',
  description: `Add a chore for one kid, with the reward paid into their jar when a parent approves it (0 to $${MAX_REWARD}). Only after the caller said yes to exactly this chore: set confirmed to true.`,
  schema: z.object({
    kid_name: z.string().describe("The kid's first name, e.g. Sofia"),
    chore: z.string().min(2).max(80).describe('The chore, e.g. "Clean your room"'),
    reward: z.number().min(0).max(MAX_REWARD).describe('Dollars paid into the jar when approved'),
    confirmed: z.boolean().describe('true only after the caller confirmed this exact chore and reward'),
  }),
  describe: (a) => `Adding a chore for ${a.kid_name}: "${a.chore}" (${usd(a.reward)})`,
  run: async (a, ctx) => {
    if (!a.confirmed) return { done: false, note: 'Not added: say the chore and reward back to the caller and wait for a yes first.' };
    needsAct(ctx);
    const kid = findKid(ctx.data, a.kid_name);
    if ('error' in kid) return { done: false, note: kid.error };
    await ctx.act.addKidTask(kid.id, a.chore.trim(), round2(a.reward));
    return { done: true, kid: first(kid), chore: a.chore.trim(), reward: round2(a.reward), note: 'It is on the Kids page now.' };
  },
  summarize: (r) => (r.done ? `Added "${r.chore}" for ${r.kid} (${usd(r.reward)} when approved)` : `Not added: ${r.note}`),
});

export const addToKidJar = defineTool({
  name: 'add_to_kid_jar',
  description: `Put money into one kid's allowance jar in the app (an allowance or a gift; up to $${MAX_DEPOSIT}). This is the jar in the app, not a bank transfer. Only after the caller said yes to exactly this amount: set confirmed to true.`,
  schema: z.object({
    kid_name: z.string().describe("The kid's first name, e.g. Sofia"),
    amount: z.number().positive().max(MAX_DEPOSIT).describe('Dollars to add'),
    confirmed: z.boolean().describe('true only after the caller confirmed this exact amount and kid'),
  }),
  describe: (a) => `Adding ${usd(a.amount)} to ${a.kid_name}'s jar`,
  run: async (a, ctx) => {
    if (!a.confirmed) return { done: false, note: 'Not added: say the amount back to the caller and wait for a yes first.' };
    needsAct(ctx);
    const kid = findKid(ctx.data, a.kid_name);
    if ('error' in kid) return { done: false, note: kid.error };
    const amount = round2(a.amount);
    await ctx.act.depositKidJar(kid.id, amount);
    const before = jarOf(ctx.data, kid.id)?.balance ?? 0;
    return { done: true, kid: first(kid), added: amount, new_balance: round2(before + amount) };
  },
  summarize: (r) => (r.done ? `Added ${usd(r.added)} to ${r.kid}'s jar (now ${usd(r.new_balance)})` : `Not added: ${r.note}`),
});

export const kidTools = [getKids, addKidChore, addToKidJar];
/** Tools that change data: kept out of agents that act without a person confirming (Ask, Table Mode, what-ifs). */
export const WRITE_TOOLS = new Set(['add_kid_chore', 'add_to_kid_jar']);
