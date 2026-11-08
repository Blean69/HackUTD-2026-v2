// onboarding_insights: the last step of onboarding (docs/contracts.md section 7). finish_onboarding queues it once the bank is
// imported and the questions are answered. Fully traced, Nemotron-first:
//
//   plan -> read the real numbers (get_accounts, get_health_indicators, get_transactions by category, get_forecast)
//        -> 3 to 5 plain-English insight alerts (kind `insight`; Nemotron picks and words them from rule-found candidates,
//           so every number comes from the household's data)
//        -> goal feasibility for each goal the family named (goal_feasibility -> agent_upsert_goal, source `onboarding`)
//        -> one suggested first proposal in the voting tables (create_proposal; its affordability check queues itself)
//
// The job input carries the answers: {answers, priorities, risk_comfort, voting_enabled, voice_consent}.
import { z } from 'zod';
import { emitPlan } from '../agent/loop.js';
import type { RunContext } from '../agent/run.js';
import { structured } from '../llm/structured.js';
import type { FeasibilityResult } from '../tools/feasibility.js';
import { DEBT_TYPES, cashFlow, liquidBalance, totalDebt } from '../tools/finance.js';
import type { HouseholdData } from '../types.js';
import { addMonthsIso, clamp, parseDay, plural, round2, slug, truncate, usd } from '../util.js';
import { householdBrief } from './common.js';
import type { WorkflowDef } from './types.js';

// ---- facts + candidate insights (pure, deterministic) -----------------------------------------------------------------

export interface Insight {
  /** Stable id: becomes the alert key `insight:<topic>`, so a re-run updates instead of duplicating. */
  topic: string;
  severity: 'info' | 'warn';
  title: string;
  detail: string;
  /** Higher = more useful to show first among equals. */
  weight: number;
  related: string[];
}

const SUBSCRIPTION = /netflix|spotify|hulu|disney|hbo|max\b|paramount|peacock|youtube|apple\.com|icloud|amazon prime|prime video|audible|adobe|dropbox|microsoft 365|gym|fitness|peloton|xbox|playstation|nintendo|sirius|patreon|nytimes|new york times/i;

export interface Facts {
  as_of: string;
  liquid: number;
  debt: number;
  monthly_in: number;
  monthly_out: number;
  monthly_net: number;
  cushion_months: number | null;
  top_categories: { category: string; monthly: number; share_pct: number }[];
  cards: { id: string; name: string; balance: number; limit: number | null; apr: number | null }[];
  card_utilization_pct: number | null;
  mortgage: { name: string; balance: number; rate: number | null } | null;
  cds: { name: string; balance: number; matures: string }[];
  subscriptions: { count: number; monthly: number; merchants: string[] };
  indicators: Record<string, { value: number; unit: string; status: string }>;
  forecast_low: { date: string; balance: number } | null;
  net_worth: number;
  assets: number;
}

export function computeFacts(data: HouseholdData): Facts {
  const flow = cashFlow(data);
  const liquid = liquidBalance(data);
  const debt = totalDebt(data);
  const assets = round2(data.accounts.filter((a) => !DEBT_TYPES.has(a.type)).reduce((s, a) => s + a.balance, 0));
  const home = data.household.home_value ?? 0;
  const vehicle = data.household.vehicle_value ?? 0;
  const outTotal = flow.top_outflow_categories.reduce((s, c) => s + c.monthly, 0) || flow.monthly_out;
  const cards = data.accounts
    .filter((a) => a.type === 'credit_card' && a.balance > 0)
    .map((a) => ({ id: a.id, name: a.nickname || 'Credit card', balance: a.balance, limit: a.credit_limit ?? null, apr: a.rate_pct ?? null }));
  const limitSum = data.accounts.filter((a) => a.type === 'credit_card' && (a.credit_limit ?? 0) > 0).reduce((s, a) => s + (a.credit_limit ?? 0), 0);
  const owedOnLimited = data.accounts.filter((a) => a.type === 'credit_card' && (a.credit_limit ?? 0) > 0).reduce((s, a) => s + a.balance, 0);
  const mortgage = data.accounts.find((a) => a.type === 'mortgage');
  const today = parseDay(data.asOf) ?? 0;
  const cds = data.accounts
    .filter((a) => a.type === 'cd' && a.maturity_date && (parseDay(a.maturity_date) ?? Infinity) - today <= 120 && (parseDay(a.maturity_date) ?? -1) >= today)
    .map((a) => ({ name: a.nickname || 'CD', balance: a.balance, matures: a.maturity_date!.slice(0, 10) }));

  // subscriptions: small recurring charges that look like subscriptions, seen in at least two different months
  const months = new Map<string, Set<string>>();
  const amounts = new Map<string, number[]>();
  for (const t of data.txns) {
    if (t.amount >= 0 || -t.amount > 80 || !SUBSCRIPTION.test(`${t.merchant} ${t.description}`)) continue;
    const key = t.merchant.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    (months.get(key) ?? months.set(key, new Set()).get(key)!).add(t.date.slice(0, 7));
    (amounts.get(key) ?? amounts.set(key, []).get(key)!).push(-t.amount);
  }
  const subs = [...months.entries()].filter(([, m]) => m.size >= 2).map(([k]) => ({ k, avg: amounts.get(k)!.reduce((s, x) => s + x, 0) / amounts.get(k)!.length }));

  const ind: Facts['indicators'] = {};
  for (const h of data.health) ind[h.key] = { value: h.value, unit: h.unit, status: h.status };
  const low = data.forecast.length ? data.forecast.reduce((m, p) => (p.balance < m.balance ? p : m)) : null;

  return {
    as_of: data.asOf,
    liquid,
    debt,
    monthly_in: flow.monthly_in,
    monthly_out: flow.monthly_out,
    monthly_net: flow.monthly_net,
    cushion_months: flow.monthly_out > 0 ? round2(liquid / flow.monthly_out) : null,
    top_categories: flow.top_outflow_categories.map((c) => ({ category: c.category, monthly: c.monthly, share_pct: outTotal > 0 ? Math.round((c.monthly / outTotal) * 100) : 0 })),
    cards,
    card_utilization_pct: limitSum > 0 ? Math.round((owedOnLimited / limitSum) * 100) : null,
    mortgage: mortgage ? { name: mortgage.nickname || 'Mortgage', balance: mortgage.balance, rate: mortgage.rate_pct ?? null } : null,
    cds,
    subscriptions: { count: subs.length, monthly: round2(subs.reduce((s, x) => s + x.avg, 0)), merchants: subs.map((s) => s.k).slice(0, 6) },
    indicators: ind,
    forecast_low: low ? { date: low.date, balance: low.balance } : null,
    net_worth: round2(assets + home + vehicle - debt),
    assets,
  };
}

const words = (s: string): string => s.replace(/_/g, ' ');
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function candidateInsights(f: Facts, priorities: string[] = []): Insight[] {
  const out: Insight[] = [];
  const add = (i: Insight): void => void out.push(i);
  const has = f.liquid > 0 || f.monthly_out > 0 || f.debt > 0;

  if (f.cushion_months !== null) {
    const m = f.cushion_months;
    add({
      topic: 'cushion',
      severity: m < 3 ? 'warn' : 'info',
      title: m < 1 ? `Your cash covers less than a month of spending` : `Your cash covers about ${m.toFixed(1)} months of spending`,
      detail: `Checking and savings hold ${usd(f.liquid)} against about ${usd(f.monthly_out)} of spending a month. ${m < 3 ? 'Most advisors suggest 3 to 6 months, so this is the first gap to close.' : m < 6 ? 'That is a solid start; 6 months is a comfortable target.' : 'That is a strong cushion.'}`,
      weight: m < 3 ? 90 : 40,
      related: [],
    });
  }
  const costly = [...f.cards].filter((c) => (c.apr ?? 0) >= 15).sort((a, b) => b.balance * (b.apr ?? 0) - a.balance * (a.apr ?? 0))[0];
  if (costly) {
    const yearly = round2((costly.balance * (costly.apr ?? 0)) / 100);
    add({
      topic: 'card_interest',
      severity: 'warn',
      title: `${truncate(costly.name, 40)} costs about ${usd(yearly)} a year in interest`,
      detail: `It carries ${usd(costly.balance)} at ${costly.apr}% APR. Paying it down is a guaranteed return of that rate, usually better than any savings account pays.`,
      weight: 85,
      related: [costly.id],
    });
  }
  if (f.card_utilization_pct !== null && f.card_utilization_pct > 30) {
    add({ topic: 'utilization', severity: 'warn', title: `You use ${f.card_utilization_pct}% of your card limits`, detail: 'Staying under 30% of each limit is the usual rule of thumb for a healthy credit score.', weight: 75, related: [] });
  }
  const sr = f.indicators['savings_rate'];
  if (sr) {
    add({
      topic: 'savings_rate',
      severity: sr.status === 'risk' ? 'warn' : 'info',
      title: `You saved about ${Math.round(sr.value)}% of income over the last 3 months`,
      detail: sr.status === 'good' ? 'That meets the common 15% target.' : `The common target is 15%. At ${usd(f.monthly_in)} coming in and ${usd(f.monthly_out)} going out a month, the gap is ${usd(Math.max(0, f.monthly_in * 0.15 - f.monthly_net))} a month.`,
      weight: sr.status === 'good' ? 35 : 70,
      related: [],
    });
  }
  if (f.forecast_low && f.forecast_low.balance < Math.max(500, f.monthly_out * 0.25)) {
    add({
      topic: 'forecast_low',
      severity: 'warn',
      title: `Cash gets low around ${f.forecast_low.date}`,
      detail: `The 90-day forecast bottoms out at ${usd(f.forecast_low.balance)} on ${f.forecast_low.date}. It is worth lining up bills and paydays before then.`,
      weight: 95,
      related: [],
    });
  }
  if (f.subscriptions.count >= 3) {
    add({
      topic: 'subscriptions',
      severity: 'info',
      title: `${f.subscriptions.count} subscriptions cost about ${usd(f.subscriptions.monthly)} a month`,
      detail: `That is roughly ${usd(f.subscriptions.monthly * 12)} a year across ${f.subscriptions.merchants.join(', ')}. Cancelling the ones nobody uses is the easiest money to win back.`,
      weight: 50,
      related: [],
    });
  }
  for (const cd of f.cds.slice(0, 1)) {
    add({ topic: 'cd_maturing', severity: 'info', title: `A ${usd(cd.balance)} CD matures on ${cd.matures}`, detail: 'Decide before then whether to roll it over, move it to savings or use it for a goal, otherwise banks often renew it automatically at whatever rate they offer.', weight: 60, related: [] });
  }
  if (f.mortgage) {
    const r = f.mortgage.rate;
    add({
      topic: 'mortgage',
      severity: 'info',
      title: r !== null ? `Your mortgage rate is ${r}%` : `You owe ${usd(f.mortgage.balance)} on the mortgage`,
      detail: r !== null && r <= 4.5 ? `A rate that low is worth keeping; extra cash usually works harder on higher-interest debt or savings. ${usd(f.mortgage.balance)} is left.` : `${usd(f.mortgage.balance)} is left. If rates have fallen since you borrowed, ask what a refinance would save.`,
      weight: 30,
      related: [],
    });
  }
  const top = f.top_categories[0];
  if (top) {
    add({ topic: 'top_spending', severity: 'info', title: `${cap(words(top.category))} is your biggest expense`, detail: `About ${usd(top.monthly)} a month, ${top.share_pct}% of everything you spend.`, weight: 45, related: [] });
  }
  if (has) {
    add({ topic: 'net_worth', severity: 'info', title: `Your net worth is about ${usd(f.net_worth)}`, detail: `${usd(f.assets)} in accounts against ${usd(f.debt)} of debt, before counting any home or vehicle value you entered.`, weight: 20, related: [] });
  }
  // nothing to analyse yet (no bank linked): answer-based starters so the family still gets 3 useful notes
  const starters: Insight[] = [
    { topic: 'connect_bank', severity: 'info', title: 'Connect a bank to see your real numbers', detail: 'Brianotron has no account data yet, so these notes come from your answers only. Linking a bank adds balances, spending and a 90-day forecast.', weight: 10, related: [] },
    { topic: 'first_priority', severity: 'info', title: priorities[0] ? `Your first priority: ${words(priorities[0])}` : 'Pick your first priority', detail: 'Everything in the plan is ordered around it. You can reorder priorities any time from the goals page.', weight: 9, related: [] },
    { topic: 'start_small', severity: 'info', title: 'Small, regular steps beat big plans', detail: 'Even a small automatic transfer on payday builds the habit while the full picture fills in.', weight: 8, related: [] },
  ];
  for (const s of starters) if (out.length < 3 && !out.some((o) => o.topic === s.topic)) add(s);
  return out.sort((a, b) => (a.severity === b.severity ? b.weight - a.weight : a.severity === 'warn' ? -1 : 1));
}

// ---- goals ---------------------------------------------------------------------------------------------------------------

export interface GoalPlan {
  target_amount: number;
  target_date: string;
  current_saved?: number;
  note: string;
}

const roundTo = (x: number, step: number): number => Math.round(x / step) * step;

/** A default amount and date for a goal that was only named. Deliberately simple and stated in the trace. */
export function planGoal(key: string, title: string, data: HouseholdData, f: Facts): GoalPlan | null {
  const income = data.members.reduce((s, m) => s + m.income_annual, 0) || f.monthly_in * 12;
  const date = (months: number): string => addMonthsIso(data.asOf, months);
  switch (key) {
    case 'emergency_fund':
      return { target_amount: Math.max(1000, roundTo(f.monthly_out * 6, 100)), target_date: date(18), note: 'six months of current spending' };
    case 'home': {
      const price = clamp(roundTo(income * 3, 10000), 200000, 600000);
      return { target_amount: roundTo(price * 0.23, 500), target_date: date(36), note: `20% down plus closing costs on a ${usd(price)} home` };
    }
    case 'college': {
      const kids = data.members.filter((m) => m.age > 0 && m.age < 18).sort((a, b) => a.age - b.age);
      const months = kids[0] ? clamp((18 - kids[0].age) * 12, 12, 168) : 60;
      return { target_amount: 60000, target_date: date(months), note: kids[0] ? `four years of in-state costs by the time the youngest turns 18` : 'four years of in-state costs in five years' };
    }
    case 'retirement':
      return { target_amount: Math.max(2000, roundTo(income * 0.15, 100)), target_date: date(12), current_saved: 0, note: '15% of income put into retirement accounts this year' };
    case 'debt_payoff': {
      const debt = data.accounts.filter((a) => DEBT_TYPES.has(a.type) && a.type !== 'mortgage').reduce((s, a) => s + a.balance, 0);
      return debt > 0 ? { target_amount: roundTo(debt, 50), target_date: date(36), current_saved: 0, note: 'all debt other than the mortgage, in three years' } : null;
    }
    case 'travel':
      return { target_amount: 5000, target_date: date(12), note: 'a $5,000 family trip next year' };
    case 'business':
      return { target_amount: 50000, target_date: date(24), note: 'a $50,000 launch fund in two years' };
    case 'caring_for_parents':
      return { target_amount: 12000, target_date: date(12), current_saved: 0, note: 'about $1,000 a month toward a parent\'s care' };
    case 'custom': {
      const m = /\$\s?([\d,]+(?:\.\d+)?)\s*(k)?/i.exec(title);
      if (!m) return null;
      const amount = Number(m[1]!.replace(/,/g, '')) * (m[2] ? 1000 : 1);
      return Number.isFinite(amount) && amount > 0 ? { target_amount: amount, target_date: date(12), note: 'the amount in your own words, within a year' } : null;
    }
    default:
      return null;
  }
}

// ---- proposal ideas --------------------------------------------------------------------------------------------------------

export interface ProposalIdea {
  id: string;
  title: string;
  amount: number;
  details: Record<string, unknown>;
  why: string;
}

export function proposalIdeas(f: Facts, priorities: string[]): ProposalIdea[] {
  const room = Math.max(0, f.liquid - f.monthly_out * 2); // never suggest spending into the last two months of cushion
  const cap = (x: number): number => Math.max(100, Math.min(roundTo(x, 50), roundTo(room * 0.5, 50) || 100));
  const byPriority: Record<string, ProposalIdea | null> = {
    debt_payoff: (() => {
      const c = [...f.cards].sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0) || b.balance - a.balance)[0];
      return c && c.balance >= 100 ? { id: 'payoff_card', title: `Pay off the ${truncate(c.name, 40)} balance`, amount: round2(c.balance), details: { kind: 'purchase', card: c.name, apr_pct: c.apr }, why: `It costs ${c.apr ?? 'double-digit'}% interest, more than savings earn.` } : null;
    })(),
    travel: { id: 'family_trip', title: 'Plan a family trip', amount: cap(2500), details: { kind: 'purchase', note: 'Pick the place together; flights and a place to stay.' }, why: 'You named travel as a priority and the cash is there.' },
    retirement: { id: 'ira_top_up', title: 'Top up the IRA this year', amount: cap(2000), details: { kind: 'purchase', note: 'A one-time deposit into the IRA.' }, why: 'You named retirement as a priority.' },
    college: { id: 'college_fund', title: 'Open a college fund with a first deposit', amount: cap(1500), details: { kind: 'purchase', note: 'A first deposit into a 529 plan.' }, why: 'You named college as a priority.' },
    home: { id: 'house_fund', title: 'Start a house fund with a first deposit', amount: cap(3000), details: { kind: 'purchase', note: 'A first deposit into a dedicated savings account.' }, why: 'You named a home as a priority.' },
  };
  const ideas: ProposalIdea[] = [];
  for (const p of priorities) {
    const i = byPriority[p];
    if (i) ideas.push(i);
  }
  ideas.push({ id: 'family_outing', title: 'A family weekend away', amount: cap(1000), details: { kind: 'purchase', note: 'A first thing to vote on together.' }, why: 'A small, fun first decision to try voting with.' });
  return ideas;
}

// ---- the workflow --------------------------------------------------------------------------------------------------------

const InsightsSchema = z.object({
  insights: z
    .array(z.object({ topic: z.string().min(2).max(40), title: z.string().min(5).max(90), detail: z.string().min(10).max(320) }))
    .min(3)
    .max(5),
});
const ProposalWordsSchema = z.object({ title: z.string().min(5).max(100), note: z.string().min(5).max(240) });

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export const onboardingInsightsWorkflow: WorkflowDef = {
  name: 'onboarding_insights',
  // no cacheKey: this is the first look at a brand-new household and must always run live

  async run(run: RunContext, job) {
    const priorities = arr(job.input.priorities);
    const risk = Number(job.input.risk_comfort) || 3;
    const votingOn = job.input.voting_enabled !== false;
    const hh = job.householdId;

    await emitPlan(run, {
      agent: 'planner',
      task: 'onboarding',
      system: `You are the planner for Brianotron's onboarding. ${householdBrief(run)}`,
      user: `The family just finished onboarding (priorities: ${priorities.join(', ') || 'none given'}; risk comfort ${risk} of 5). Plan how to turn their imported accounts and answers into a first set of insights, goal checks and one suggested proposal.`,
      toolNames: ['get_accounts', 'get_health_indicators', 'get_transactions', 'get_forecast', 'goal_feasibility'],
      local: {
        plan: [
          'Read the imported accounts, health indicators, spending by category and the 90-day forecast',
          'Find what stands out (cash cushion, costly debt, subscriptions, upcoming low point) and word 3 to 5 insights in plain English',
          "Check each goal the family named against their real cash flow (goal_feasibility) and save the verdicts",
          'Suggest one first proposal for the family to vote on; its affordability check runs on its own',
        ],
      },
    });

    // 1. read the numbers (each tool call is a visible step)
    run.handoff('planner', 'analyst', 'Reading the imported accounts and the health math');
    await run.tool('analyst', 'get_accounts', {});
    await run.tool('analyst', 'get_health_indicators', {});
    await run.tool('analyst', 'get_transactions', { group_by: 'category', direction: 'out' });
    await run.tool('analyst', 'get_forecast', {});
    const facts = computeFacts(run.data);
    const candidates = candidateInsights(facts, priorities);
    run.emit('analyst', 'message', `Found ${candidates.length} things worth a look: ${candidates.map((c) => c.topic).join(', ')}`, { facts: { liquid: facts.liquid, debt: facts.debt, monthly_in: facts.monthly_in, monthly_out: facts.monthly_out, cushion_months: facts.cushion_months, net_worth: facts.net_worth }, candidates: candidates.map((c) => ({ topic: c.topic, severity: c.severity })) });

    // 2. insights
    run.handoff('analyst', 'insight_writer', 'Choosing and wording the insights for the family');
    const chosen = candidates.slice(0, 5);
    let final = chosen;
    try {
      const r = await structured(run.llm, {
        name: 'write_insights',
        description: 'Pick and word 3 to 5 insights for the family from the candidate findings',
        schema: InsightsSchema,
        role: 'agent',
        task: 'onboarding.insights',
        local: { structured: { insights: chosen.map((c) => ({ topic: c.topic, title: c.title, detail: c.detail })) } },
        maxTokens: 1400,
        messages: [
          { role: 'system', content: `You write the first insights a family sees after connecting their bank, in warm, plain language (no jargon, no investment advice, no fear). Use ONLY the numbers in the candidates; never invent figures. Pick the 3 to 5 most useful for this family's priorities, put the most important first, and keep each topic id exactly as given. ${householdBrief(run)} All data is synthetic.` },
          { role: 'user', content: JSON.stringify({ priorities, risk_comfort_1_to_5: risk, candidates: candidates.map((c) => ({ topic: c.topic, severity: c.severity, title: c.title, detail: c.detail })) }) },
        ],
      });
      run.noteLlm({ content: '', toolCalls: [], provider: r.meta.provider, model: r.meta.model, latencyMs: r.meta.latencyMs, tokensIn: r.meta.tokensIn, tokensOut: r.meta.tokensOut });
      const byTopic = new Map(candidates.map((c) => [c.topic, c]));
      const picked: Insight[] = [];
      for (const i of r.value.insights) {
        const base = byTopic.get(i.topic);
        if (base && !picked.some((p) => p.topic === i.topic)) picked.push({ ...base, title: i.title, detail: i.detail });
      }
      for (const c of candidates) if (picked.length < 3 && !picked.some((p) => p.topic === c.topic)) picked.push(c); // the model must not leave us under 3
      final = picked.slice(0, 5);
      run.emit('insight_writer', 'message', r.meta.provider === 'local' ? `Using the rule-based wording for ${final.length} insights (offline fallback)` : `Nemotron worded ${final.length} insights`, { topics: final.map((p) => p.topic) }, { model: r.meta.model, provider: r.meta.provider, latencyMs: r.meta.latencyMs, tokensIn: r.meta.tokensIn, tokensOut: r.meta.tokensOut });
    } catch (e) {
      run.emit('insight_writer', 'message', `The wording step failed (${truncate(e instanceof Error ? e.message : String(e), 100)}); using the standard wording`, {});
    }
    for (const i of final) {
      run.alert({ key: `insight:${slug(i.topic, 30)}`, severity: i.severity, kind: 'insight', title: truncate(i.title, 190), detail: truncate(i.detail, 1800), related_ids: i.related });
      run.emit('insight_writer', 'message', `Insight: ${i.title}`, { topic: i.topic, severity: i.severity });
    }

    // 3. goal feasibility
    run.handoff('insight_writer', 'goal_planner', 'Checking each goal against the real cash flow');
    const prefix = `goal_${hh}_`;
    const goals = run.data.goals.filter((g) => g.id.startsWith(prefix));
    const checked: { id: string; title: string; feasibility: string }[] = [];
    for (const g of goals) {
      const key = g.id.slice(prefix.length);
      const plan = g.target_amount > 0 && g.target_date ? { target_amount: g.target_amount, target_date: g.target_date, note: 'the amount and date already on the goal' } : planGoal(key, g.title, run.data, facts);
      if (!plan) {
        run.emit('goal_planner', 'message', `"${truncate(g.title, 80)}" has no amount to check yet; left for the family to fill in`, { goal_id: g.id });
        continue;
      }
      run.emit('goal_planner', 'message', `Assuming ${usd(plan.target_amount)} by ${plan.target_date} for "${truncate(g.title, 60)}": ${plan.note}`, { goal_id: g.id, assumption: plan.note });
      const out = await run.tool('goal_planner', 'goal_feasibility', { title: g.title, target_amount: plan.target_amount, target_date: plan.target_date, ...(plan.current_saved !== undefined ? { current_saved: plan.current_saved } : {}) });
      if (!out.ok) continue;
      const res = out.result as FeasibilityResult;
      run.goal({ id: g.id, key, title: g.title, target_amount: plan.target_amount, target_date: plan.target_date, priority: g.priority, feasibility: res.feasibility, evidence_quote: key === 'custom' ? truncate(g.title, 280) : '', source: 'onboarding' });
      checked.push({ id: g.id, title: g.title, feasibility: res.feasibility });
    }
    run.emit('goal_planner', 'message', checked.length ? `Checked ${plural(checked.length, 'goal')}: ${checked.map((c) => `${truncate(c.title, 30)} ${c.feasibility.replace('_', ' ')}`).join('; ')}` : 'No goals with an amount to check', { goals: checked });

    // 4. one suggested first proposal
    let suggested: string | null = null;
    if (!votingOn) {
      run.emit('proposal_scout', 'message', 'Family voting is switched off in the answers; no proposal suggested', {});
    } else {
      run.handoff('goal_planner', 'proposal_scout', 'Suggesting a first thing for the family to vote on');
      const idea = proposalIdeas(facts, priorities)[0]!;
      let title = idea.title;
      let note = String((idea.details as { note?: string }).note ?? idea.why);
      try {
        const w = await structured(run.llm, {
          name: 'write_proposal',
          description: 'Word the suggested first proposal for the family vote',
          schema: ProposalWordsSchema,
          role: 'fast',
          task: 'onboarding.proposal',
          local: { structured: { title, note } },
          messages: [
            { role: 'system', content: 'You word one suggested family proposal: a short title (max 100 characters, no dollar sign needed) and a one-sentence note on why it fits. Keep the amount and idea exactly as given. Plain, friendly language.' },
            { role: 'user', content: JSON.stringify({ idea: idea.title, amount: idea.amount, why: idea.why, priorities }) },
          ],
        });
        run.noteLlm({ content: '', toolCalls: [], provider: w.meta.provider, model: w.meta.model, latencyMs: w.meta.latencyMs, tokensIn: w.meta.tokensIn, tokensOut: w.meta.tokensOut });
        title = w.value.title;
        note = w.value.note;
      } catch {
        /* keep the standard wording */
      }
      run.proposeToFamily({ title: truncate(title, 140), amount: idea.amount, details: { ...idea.details, note: truncate(note, 240), suggested_by: 'Brianotron onboarding' }, closes_in_days: 7, author_name: 'Brian (AI)' });
      suggested = title;
      run.emit('proposal_scout', 'message', `Opened a proposal for the family to vote on: ${truncate(title, 100)} (${usd(idea.amount)}). Its affordability check runs next.`, { idea: idea.id, amount: idea.amount });
    }

    run.emit('insight_writer', 'final', `Onboarding done: ${plural(final.length, 'insight')}, ${plural(checked.length, 'goal')} checked${suggested ? `, proposal "${truncate(suggested, 60)}" opened` : ''}`, { insights: final.map((i) => i.topic), goals: checked.length, proposal: suggested });
    return { insights: final.map((i) => i.topic), goals: checked, proposal: suggested };
  },
};
