// Alerts and Family voting for Brian: read the open alerts and the proposals, mark an alert handled ("Mark handled" in the app), start a
// proposal. Voting itself is NOT here: a vote belongs to one person's own phone (the module keys it by the caller's identity, and the worker
// is a single identity for every family), so Brian would fake a voter. Family members vote in the app.
import { z } from 'zod';
import { truncate, usd } from '../util.js';
import { gate, needsAct, niceDate, pickByWords, sounds, spend } from './confirm.js';
import { defineTool } from './registry.js';

const MAX_PROPOSAL = 1_000_000; // a proposal's amount, by voice (the module allows far more)
const MAX_OPEN_DAYS = 14; // the longest the Family votes form offers
const DEFAULT_OPEN_DAYS = 5;

const SEVERITY = new Map([['critical', 0], ['warn', 1], ['info', 2]]);
const rank = (s: string): number => SEVERITY.get(s) ?? 3;

export const getAlerts = defineTool({
  name: 'get_alerts',
  description: "The family's open alerts from the dashboard bell (fraud, scam, data problems, bills, credit), worst first. Alerts nobody has marked handled.",
  schema: z.object({}),
  describe: () => 'Reading the open alerts',
  run: (_args, { data }) => {
    const open = (data.alerts ?? []).filter((a) => !a.acknowledged_by);
    const shown = [...open].sort((a, b) => rank(a.severity) - rank(b.severity) || (a.created_at < b.created_at ? 1 : -1)).slice(0, 4);
    return { open: open.length, alerts: shown.map((a) => ({ severity: a.severity, title: truncate(a.title, 80), detail: truncate(a.detail, 110) })) };
  },
  summarize: (r) => (r.open ? `${r.open} open alert(s), worst: ${truncate(r.alerts[0]?.title ?? '', 60)}` : 'No open alerts'),
});

export const markAlertHandled = defineTool({
  name: 'mark_alert_handled',
  description: 'Mark one open alert as handled (the same as "Mark handled" in the app). Only after the caller said yes to exactly this alert: set confirmed to true.',
  schema: z.object({
    alert: z.string().max(100).describe('A few words from the alert, e.g. "double charge"'),
    confirmed: z.boolean().describe('true only after the caller confirmed this exact alert'),
  }),
  describe: (a) => `Marking an alert handled: "${truncate(a.alert, 60)}"`,
  run: async (a, ctx) => {
    needsAct(ctx);
    const open = (ctx.data.alerts ?? []).filter((x) => !x.acknowledged_by);
    if (!open.length) return { done: false, note: 'There are no open alerts.' };
    const alert = pickByWords(open, a.alert, (x) => x.title, 'alert');
    if ('error' in alert) return { done: false, note: alert.error };
    const key = `alert:${alert.id}`;
    const ask = gate(ctx.act, key, a.confirmed, `Mark "${truncate(alert.title, 90)}" as handled?${alert.severity === 'critical' ? ' It is a critical alert, so only if it has been dealt with.' : ''}`);
    if (ask) return ask;
    await ctx.act.markAlertHandled(alert.id);
    spend(ctx.act, key);
    return { done: true, alert: truncate(alert.title, 90), still_open: open.length - 1, note: 'It is marked handled in the app.' };
  },
  summarize: (r) => (r.done ? `Marked handled: ${truncate(r.alert, 60)} (${r.still_open} still open)` : r.ask ? `Asked first: ${r.ask}` : `Not marked: ${r.note}`),
});

export const getProposals = defineTool({
  name: 'get_proposals',
  description: "The family's proposals to vote on (Family votes): the amount, whether voting is open, the affordability check and the votes so far.",
  schema: z.object({}),
  describe: () => 'Reading the family votes',
  run: (_args, { data }) => {
    const votes = data.votes ?? [];
    const now = Date.now();
    const list = [...(data.proposals ?? [])].map((p) => ({ p, open: p.status === 'open' && Date.parse(p.closes_at) > now }));
    list.sort((a, b) => Number(b.open) - Number(a.open) || (a.p.created_at < b.p.created_at ? 1 : -1));
    return {
      count: list.length,
      proposals: list.slice(0, 3).map(({ p, open }) => {
        const mine = votes.filter((v) => v.proposal_id === p.id);
        const n = (c: string): number => mine.filter((v) => v.choice === c).length;
        return {
          proposal: truncate(p.title, 80),
          amount: p.amount,
          voting: open ? `open until ${niceDate(p.closes_at.slice(0, 10))}` : 'closed',
          affordability: p.verdict || 'still being checked',
          yes: n('yes'),
          no: n('no'),
          not_sure: n('abstain'),
          proposed_by: truncate(p.created_by_name, 30),
        };
      }),
    };
  },
  summarize: (r) => `${r.count} proposal(s)${r.proposals.length ? `: ${r.proposals.map((p: { proposal: string }) => truncate(p.proposal, 30)).join(', ')}` : ''}`,
});

export const createProposal = defineTool({
  name: 'create_proposal',
  description: `Start a family vote on a purchase or decision (an agent checks if the family can afford it). Amount up to $${MAX_PROPOSAL.toLocaleString('en-US')}. Family members cast their own votes in the app. Only after the caller said yes to exactly this proposal: set confirmed to true.`,
  schema: z.object({
    title: z.string().min(3).max(80).describe('What is proposed, e.g. "Buy a used minivan"'),
    amount: z.number().positive().max(MAX_PROPOSAL).describe('Dollars it would cost'),
    days_open: z.number().int().min(1).max(MAX_OPEN_DAYS).optional().describe(`How many days voting stays open (default ${DEFAULT_OPEN_DAYS})`),
    confirmed: z.boolean().describe('true only after the caller confirmed this exact proposal'),
  }),
  describe: (a) => `Starting a family vote: "${a.title}" (${usd(a.amount)})`,
  run: async (a, ctx) => {
    needsAct(ctx);
    const title = a.title.replace(/\s+/g, ' ').trim();
    const days = a.days_open ?? DEFAULT_OPEN_DAYS;
    const amount = Math.round(a.amount * 100) / 100;
    const now = Date.now();
    const same = sounds(title).length >= 3 ? (ctx.data.proposals ?? []).find((p) => p.status === 'open' && Date.parse(p.closes_at) > now && sounds(p.title) === sounds(title)) : undefined;
    if (same) return { done: false, note: `There is already an open vote "${same.title}".` };
    const key = `proposal:${sounds(title)}:${amount}:${days}`;
    const ask = gate(ctx.act, key, a.confirmed, `Start a family vote on "${title}" for ${usd(amount)}, open ${days} ${days === 1 ? 'day' : 'days'}?`);
    if (ask) return ask;
    await ctx.act.createProposal({ title, amount, details: {}, closes_in_days: days });
    spend(ctx.act, key);
    return { done: true, proposal: title, amount, days_open: days, note: 'It is open on the Family votes page. Everyone votes there on their own phone, and an agent is checking if the family can afford it.' };
  },
  summarize: (r) => (r.done ? `Started a family vote: "${r.proposal}" (${usd(r.amount)}, ${r.days_open} day(s))` : r.ask ? `Asked first: ${r.ask}` : `Not started: ${r.note}`),
});

export const familyTools = [getAlerts, markAlertHandled, getProposals, createProposal];
export const FAMILY_WRITE_TOOLS = ['mark_alert_handled', 'create_proposal'];
