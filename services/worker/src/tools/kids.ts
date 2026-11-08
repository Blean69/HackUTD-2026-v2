// Kids and teens tools (contracts.md section 12) for Brian: read the kids' chores and allowance jars, add a chore, put money in
// a jar, approve a finished chore, set a savings goal. The jar is allowance bookkeeping inside the app, not a bank transfer. The
// write tools need `confirmed: true` (Brian says the action back and waits for a yes) and the call session's `act` (no other agent can write).
import { z } from 'zod';
import type { HouseholdData, Member } from '../types.js';
import { round2, usd } from '../util.js';
import { editDistance, gate, pickByWords, sounds, spend } from './confirm.js';
import { defineTool, type ToolContext } from './registry.js';

export { sounds }; // the spelling-blind name form now lives in confirm.ts, shared with the other write tools

const MAX_REWARD = 50; // per chore, by voice
const MAX_DEPOSIT = 100; // per deposit, by voice (the module allows up to 500 from the app)
const MAX_APPROVE = 100; // per approved chore, by voice (the same cap as a deposit)
const MAX_KID_GOAL = 5000; // a kid's savings goal, by voice

export const isKid = (m: Member): boolean => /child|kid|teen/i.test(m.role) || (m.age > 0 && m.age < 18);
const first = (m: Member): string => m.name.split(/\s+/)[0] ?? m.name;

/** The kid the caller named, by first name: case- and spelling-tolerant ("Sophia" finds Sofia), prefix allowed ("Sof"). */
export function findKid(data: HouseholdData, name: string): Member | { error: string } {
  const kids = data.members.filter(isKid);
  if (!kids.length) return { error: 'This household has no kids or teens on file.' };
  const want = name.trim().toLowerCase().replace(/'s$/, '');
  const near = kids.filter((k) => { const a = sounds(first(k)); const b = sounds(want); return a.length >= 3 && (a === b || editDistance(a, b) <= 1); });
  const hit = kids.find((k) => first(k).toLowerCase() === want) ?? kids.find((k) => k.name.toLowerCase().startsWith(want) && want.length >= 3) ?? (near.length === 1 ? near[0] : undefined);
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
    needsAct(ctx);
    const kid = findKid(ctx.data, a.kid_name);
    if ('error' in kid) return { done: false, note: kid.error };
    const key = `chore:${kid.id}:${round2(a.reward)}`;
    if (!a.confirmed || !ctx.act.confirmable(key)) {
      ctx.act.propose(key);
      return { done: false, ask: `Add "${a.chore.trim()}" for ${first(kid)}, ${usd(a.reward)}?`, note: 'Not added yet: ask the caller exactly this and wait for a yes, then call again with confirmed true.' };
    }
    await ctx.act.addKidTask(kid.id, a.chore.trim(), round2(a.reward));
    spend(ctx.act, key);
    return { done: true, kid: first(kid), chore: a.chore.trim(), reward: round2(a.reward), note: 'It is on the Kids page now.' };
  },
  summarize: (r) => (r.done ? `Added "${r.chore}" for ${r.kid} (${usd(r.reward)} when approved)` : r.ask ? `Asked first: ${r.ask}` : `Not added: ${r.note}`),
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
    needsAct(ctx);
    const kid = findKid(ctx.data, a.kid_name);
    if ('error' in kid) return { done: false, note: kid.error };
    const amount = round2(a.amount);
    const key = `jar:${kid.id}:${amount}`;
    if (!a.confirmed || !ctx.act.confirmable(key)) {
      ctx.act.propose(key);
      return { done: false, ask: `Add ${usd(amount)} to ${first(kid)}'s jar?`, note: 'Not added yet: ask the caller exactly this and wait for a yes, then call again with confirmed true.' };
    }
    await ctx.act.depositKidJar(kid.id, amount);
    spend(ctx.act, key);
    const before = jarOf(ctx.data, kid.id)?.balance ?? 0;
    return { done: true, kid: first(kid), added: amount, new_balance: round2(before + amount) };
  },
  summarize: (r) => (r.done ? `Added ${usd(r.added)} to ${r.kid}'s jar (now ${usd(r.new_balance)})` : r.ask ? `Asked first: ${r.ask}` : `Not added: ${r.note}`),
});

export const approveKidChore = defineTool({
  name: 'approve_kid_chore',
  description: `Approve a chore a kid marked done and pay its reward (up to $${MAX_APPROVE}) into their jar in the app. Only after the caller said yes to exactly this chore: set confirmed to true.`,
  schema: z.object({
    kid_name: z.string().describe("The kid's first name, e.g. Sofia"),
    chore: z.string().max(80).optional().describe('A few words of the chore, only if that kid has more than one waiting'),
    confirmed: z.boolean().describe('true only after the caller confirmed this exact chore'),
  }),
  describe: (a) => `Approving ${a.kid_name}'s finished chore${a.chore ? `: "${a.chore}"` : ''}`,
  run: async (a, ctx) => {
    needsAct(ctx);
    const kid = findKid(ctx.data, a.kid_name);
    if ('error' in kid) return { done: false, note: kid.error };
    const mine = (ctx.data.kid_tasks ?? []).filter((t) => t.member_id === kid.id);
    const waiting = mine.filter((t) => t.status === 'done');
    if (!waiting.length) {
      const open = mine.filter((t) => t.status === 'open').length;
      return { done: false, note: `${first(kid)} has no chores waiting for approval${open ? `; ${open} still open` : ''}.` };
    }
    const task = pickByWords(waiting, a.chore ?? '', (t) => t.title, 'chore');
    if ('error' in task) return { done: false, note: task.error };
    if (task.reward > MAX_APPROVE) return { done: false, note: `That chore pays ${usd(task.reward)}, more than Brian approves by voice. A parent can approve it on the Kids page.` };
    const key = `approve:${task.id}`;
    const ask = gate(ctx.act, key, a.confirmed, `Approve "${task.title}" for ${first(kid)} and pay ${usd(task.reward)} into the jar?`);
    if (ask) return ask;
    await ctx.act.approveKidTask(task.id);
    spend(ctx.act, key);
    return { done: true, kid: first(kid), chore: task.title, paid: round2(task.reward), new_balance: round2((jarOf(ctx.data, kid.id)?.balance ?? 0) + task.reward) };
  },
  summarize: (r) => (r.done ? `Approved "${r.chore}" for ${r.kid}: ${usd(r.paid)} into the jar (now ${usd(r.new_balance)})` : r.ask ? `Asked first: ${r.ask}` : `Not approved: ${r.note}`),
});

export const setKidGoal = defineTool({
  name: 'set_kid_goal',
  description: `Set what one kid is saving for in the app (a title and a target up to $${MAX_KID_GOAL}); it replaces their current goal. Only after the caller said yes to exactly this goal: set confirmed to true.`,
  schema: z.object({
    kid_name: z.string().describe("The kid's first name, e.g. Sofia"),
    goal: z.string().min(2).max(60).describe('What they are saving for, e.g. "Lego set"'),
    target: z.number().positive().max(MAX_KID_GOAL).describe('Dollars needed'),
    confirmed: z.boolean().describe('true only after the caller confirmed this exact goal and target'),
  }),
  describe: (a) => `Setting ${a.kid_name}'s savings goal: "${a.goal}" (${usd(a.target)})`,
  run: async (a, ctx) => {
    needsAct(ctx);
    const kid = findKid(ctx.data, a.kid_name);
    if ('error' in kid) return { done: false, note: kid.error };
    const target = round2(a.target);
    const goal = a.goal.trim();
    const jar = jarOf(ctx.data, kid.id);
    const key = `kidgoal:${kid.id}:${sounds(goal)}:${target}`;
    const ask = gate(ctx.act, key, a.confirmed, `Set ${first(kid)}'s savings goal to "${goal}", ${usd(target)}${jar?.goal_title ? `, replacing "${jar.goal_title}"` : ''}?`);
    if (ask) return ask;
    await ctx.act.setKidGoal(kid.id, goal, target);
    spend(ctx.act, key);
    return { done: true, kid: first(kid), goal, target, saved_so_far: round2(jar?.balance ?? 0), note: 'It is on the Kids page now.' };
  },
  summarize: (r) => (r.done ? `Set ${r.kid}'s savings goal: "${r.goal}" (${usd(r.target)})` : r.ask ? `Asked first: ${r.ask}` : `Not set: ${r.note}`),
});

export const kidTools = [getKids, addKidChore, addToKidJar, approveKidChore, setKidGoal];
/** Tools that change data: kept out of agents that act without a person confirming (Ask, Table Mode, what-ifs). The other write tools add theirs in tools/index.ts. */
export const WRITE_TOOLS = new Set(['add_kid_chore', 'add_to_kid_jar', 'approve_kid_chore', 'set_kid_goal']);
