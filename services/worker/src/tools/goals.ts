// Goals page tools for Brian: read the goals, and add, change or delete one when the caller asks and says yes. The same rows the Goals
// page makes (title, amount, date, priority; source `manual`), plus the feasibility verdict the page would otherwise show as
// "Checking..." and then "Not checked": neither the page nor the module queues a check for a hand-made goal, so the tool works it
// out with the same deterministic goal_feasibility the Table Mode and onboarding agents use and saves it with the goal (agent_upsert_goal).
import { z } from 'zod';
import type { GoalInput } from '../agent/sink.js';
import type { GoalRow, HouseholdData } from '../types.js';
import { MS_DAY, addMonthsIso, parseDay, plural, round2, truncate, usd } from '../util.js';
import { gate, needsAct, niceDate, pickByWords, sounds, spend } from './confirm.js';
import { goalFeasibility } from './feasibility.js';
import { defineTool } from './registry.js';
import { riskyGoal } from './risky.js';

const MAX_GOAL = 1_000_000; // a goal's target amount, by voice
const MAX_YEARS_AHEAD = 50;
const DEFAULT_PRIORITY = 2; // "medium" on the Goals page

const STATUS: Record<string, string> = { on_track: 'on track', stretch: 'a stretch', off_track: 'off track', needs_details: 'needs an amount to check', not_advised: 'not advised' };
const statusOf = (feasibility: string): string => STATUS[feasibility] ?? 'not checked yet';
const SOURCES = new Set(['huddle', 'manual', 'coach', 'onboarding']);
const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A real, future calendar day (YYYY-MM-DD), or "" for no deadline. */
function checkDate(data: HouseholdData, raw: string | undefined): { date: string } | { error: string } {
  const date = tidy(raw ?? '');
  if (!date) return { date: '' };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? parseDay(date) : null;
  if (day === null) return { error: 'The date must be a real day written as YYYY-MM-DD, for example 2028-06-01.' };
  const today = parseDay(data.asOf) ?? Math.floor(Date.now() / MS_DAY);
  if (day < today) return { error: `${niceDate(date)} has already passed. Ask for a date in the future.` };
  if (day > today + 365 * MAX_YEARS_AHEAD) return { error: `${niceDate(date)} is too far away. Goals can be up to ${MAX_YEARS_AHEAD} years out.` };
  return { date };
}

/** The verdict saved with the goal. Gambling and speculation are never "on track" (the Table Mode rule); no amount means nothing to check. */
interface Verdict {
  feasibility: GoalInput['feasibility'];
  why: string;
  needs_per_month?: number;
  available_per_month?: number;
  judged_over_24_months?: boolean;
}
function verdict(data: HouseholdData, title: string, amount: number, date: string): Verdict {
  const risky = riskyGoal(title);
  if (risky) return { feasibility: 'not_advised', why: risky.why };
  if (!(amount > 0)) return { feasibility: 'needs_details', why: 'No amount yet, so there is nothing to check. Ask how much it will cost.' };
  // no deadline said: judge it over 24 months, but do not invent a date on the goal (the Table Mode rule)
  const r = goalFeasibility({ title, target_amount: amount, target_date: date || addMonthsIso(data.asOf, 24) }, data);
  return { feasibility: r.feasibility, why: r.explanation, needs_per_month: Math.round(r.required_monthly), available_per_month: Math.round(r.available_monthly), judged_over_24_months: !date };
}

const goalLabel = (g: GoalRow): string => g.title;
const newGoalId = (): string => `goal_brian_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const getGoals = defineTool({
  name: 'get_goals',
  description: "The family's savings goals from the Goals page: each one's target amount, date and whether it is on track.",
  schema: z.object({}),
  describe: () => 'Reading the goals',
  run: (_args, { data }) => ({
    count: data.goals.length,
    goals: [...data.goals]
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 6)
      .map((g) => ({ goal: truncate(g.title, 60), target: g.target_amount > 0 ? round2(g.target_amount) : null, by: g.target_date ? niceDate(g.target_date) : null, status: statusOf(g.feasibility) })),
  }),
  summarize: (r) => `${plural(r.count, 'goal')}${r.goals.length ? `: ${r.goals.map((g: { goal: string }) => truncate(g.goal, 30)).join(', ')}` : ''}`,
});

export const changeGoal = defineTool({
  name: 'change_goal',
  description: `Add a goal to the Goals page, change an existing goal's amount or date, or delete one. Amounts up to $${MAX_GOAL.toLocaleString('en-US')}. Only after the caller said yes to exactly this change: set confirmed to true.`,
  schema: z.object({
    action: z.enum(['add', 'update', 'delete']).describe('add a new goal, update the amount or date of an existing one, or delete one'),
    goal: z.string().min(2).max(80).describe('add: the goal in a few plain words, e.g. "Family trip to Hawaii". update or delete: a few words of the existing goal'),
    target_amount: z.number().positive().max(MAX_GOAL).optional().describe('Dollars needed (add or update)'),
    target_date: z.string().optional().describe('Deadline as YYYY-MM-DD (add or update)'),
    confirmed: z.boolean().describe('true only after the caller confirmed this exact change'),
  }),
  describe: (a) => `${a.action === 'add' ? 'Adding' : a.action === 'update' ? 'Changing' : 'Deleting'} the goal "${a.goal}"${a.target_amount ? ` (${usd(a.target_amount)})` : ''}`,
  run: async (a, ctx) => {
    needsAct(ctx);
    const { data, act } = ctx;
    if (a.action === 'delete') {
      const g = pickByWords(data.goals, a.goal, goalLabel, 'goal');
      if ('error' in g) return { done: false, note: g.error };
      const key = `goal:delete:${g.id}`;
      const ask = gate(act, key, a.confirmed, `Delete the goal "${g.title}"?`);
      if (ask) return ask;
      await act.deleteGoal(g.id);
      spend(act, key);
      return { done: true, action: 'deleted', goal: g.title, note: 'It is gone from the Goals page.' };
    }

    const dt = checkDate(data, a.target_date);
    if ('error' in dt) return { done: false, note: dt.error };

    if (a.action === 'add') {
      const title = tidy(a.goal);
      const same = sounds(title).length >= 3 ? data.goals.find((g) => sounds(g.title) === sounds(title)) : undefined;
      if (same) return { done: false, note: `There is already a goal "${same.title}". To change it, update that goal instead.` };
      const amount = round2(a.target_amount ?? 0);
      const key = `goal:add:${sounds(title)}:${amount}:${dt.date}`;
      const ask = gate(act, key, a.confirmed, `Add the goal "${title}"${amount ? `, ${usd(amount)}` : ''}${dt.date ? ` by ${niceDate(dt.date)}` : ''}?`);
      if (ask) return ask;
      const v = verdict(data, title, amount, dt.date);
      await act.saveGoal({ id: newGoalId(), title, target_amount: amount, target_date: dt.date, priority: DEFAULT_PRIORITY, feasibility: v.feasibility, evidence_quote: '', source: 'manual' });
      spend(act, key);
      return { done: true, action: 'added', goal: title, target: amount || null, by: dt.date ? niceDate(dt.date) : null, check: statusOf(v.feasibility), ...spoken(v), note: 'It is on the Goals page now.' };
    }

    // update: the amount, the date, or both
    const g = pickByWords(data.goals, a.goal, goalLabel, 'goal');
    if ('error' in g) return { done: false, note: g.error };
    if (a.target_amount === undefined && !dt.date) return { done: false, note: `Say what to change on "${g.title}": the amount, the date, or both.` };
    const amount = round2(a.target_amount ?? g.target_amount);
    const date = dt.date || g.target_date;
    const changes = [a.target_amount !== undefined ? `target ${usd(amount)}` : '', dt.date ? `by ${niceDate(date)}` : ''].filter(Boolean).join(', ');
    const key = `goal:update:${g.id}:${amount}:${date}`;
    const ask = gate(act, key, a.confirmed, `Update "${g.title}": ${changes}?`);
    if (ask) return ask;
    const v = verdict(data, g.title, amount, date);
    const source = (SOURCES.has(g.source ?? '') ? g.source : 'manual') as GoalInput['source'];
    await act.saveGoal({ id: g.id, title: g.title, target_amount: amount, target_date: date, priority: g.priority, feasibility: v.feasibility, evidence_quote: g.evidence_quote ?? '', source });
    spend(act, key);
    return { done: true, action: 'updated', goal: g.title, target: amount || null, by: date ? niceDate(date) : null, check: statusOf(v.feasibility), ...spoken(v), note: 'The Goals page is updated.' };
  },
  summarize: (r) =>
    r.done ? `${r.action === 'added' ? 'Added' : r.action === 'updated' ? 'Updated' : 'Deleted'} goal "${r.goal}"${r.check ? ` (${r.check})` : ''}` : r.ask ? `Asked first: ${r.ask}` : `No change: ${r.note}`,
});

/** The part of a verdict worth saying out loud, without the machine fields. */
function spoken(v: Verdict) {
  return { why: v.why, ...(v.needs_per_month !== undefined ? { needs_per_month: v.needs_per_month, available_per_month: v.available_per_month } : {}), ...(v.judged_over_24_months ? { checked_over: '24 months, since no date was given' } : {}) };
}

export const goalTools = [getGoals, changeGoal];
export const GOAL_WRITE_TOOLS = ['change_goal'];
