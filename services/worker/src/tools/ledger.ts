// Read-only ledger tools: accounts, transactions, obligations, credit, health indicators and the forecast.
import { z } from 'zod';
import { formatDay, parseDay, round2, usd } from '../util.js';
import { DEBT_TYPES, cashFlow, liquidBalance, totalAssets, totalDebt, usableTxns } from './finance.js';
import { defineTool } from './registry.js';

export const getAccounts = defineTool({
  name: 'get_accounts',
  description:
    'List the household accounts with balances (debts are positive amounts owed), rates and payments, plus totals: liquid cash, assets, debt, net worth.',
  schema: z.object({ type: z.string().optional().describe('Filter by account type, e.g. checking, savings, credit_card, mortgage') }),
  describe: (a) => (a.type ? `Reading ${a.type} accounts` : 'Reading all accounts'),
  run: (args, { data }) => {
    const rows = data.accounts
      .filter((a) => !args.type || a.type === args.type)
      .map((a) => ({
        id: a.id,
        type: a.type,
        nickname: a.nickname,
        institution: a.institution,
        balance: a.balance,
        ...(a.rate_pct !== undefined ? { rate_pct: a.rate_pct } : {}),
        ...(a.monthly_payment !== undefined ? { monthly_payment: a.monthly_payment } : {}),
        ...(a.credit_limit !== undefined ? { credit_limit: a.credit_limit } : {}),
        ...(a.maturity_date ? { maturity_date: a.maturity_date } : {}),
      }));
    const assets = totalAssets(data);
    const debt = totalDebt(data);
    const home = data.household.home_value ?? 0;
    const vehicle = data.household.vehicle_value ?? 0;
    return {
      count: rows.length,
      accounts: rows,
      totals: {
        liquid_cash: liquidBalance(data),
        assets,
        debt,
        ...(home || vehicle ? { home_value: home, vehicle_value: vehicle } : {}),
        net_worth: round2(assets + home + vehicle - debt),
      },
    };
  },
  summarize: (r) => `${r.count} accounts, liquid cash ${usd(r.totals.liquid_cash)}, debt ${usd(r.totals.debt)}, net worth ${usd(r.totals.net_worth)}`,
});

const TxnArgs = z.object({
  account_id: z.string().optional(),
  category: z.string().optional().describe('e.g. groceries, dining, utilities, income, gift_cards'),
  merchant: z.string().optional().describe('Case-insensitive substring of the merchant name'),
  since: z.string().optional().describe('YYYY-MM-DD, inclusive'),
  until: z.string().optional().describe('YYYY-MM-DD, inclusive'),
  direction: z.enum(['in', 'out']).optional().describe('in = deposits, out = spending'),
  min_amount: z.number().optional().describe('Minimum absolute amount in USD'),
  max_amount: z.number().optional().describe('Maximum absolute amount in USD'),
  limit: z.number().int().min(1).max(40).optional().describe('Max rows to return (default 15, newest first)'),
  group_by: z.enum(['category', 'merchant', 'month']).optional().describe('Return totals per group instead of rows'),
  include_transfers: z.boolean().optional().describe('With group_by: also count transfers, savings moves and credit-card payments (excluded by default)'),
});

const INTERNAL = new Set(['transfer', 'savings', 'credit_card_payment']);

export const getTransactions = defineTool({
  name: 'get_transactions',
  description:
    'Search transactions (negative amount = money out). Returns the newest matching rows, or totals grouped by category, merchant or month.',
  schema: TxnArgs,
  describe: (a) => {
    const bits = [a.category && `category ${a.category}`, a.merchant && `merchant "${a.merchant}"`, a.since && `since ${a.since}`, a.until && `until ${a.until}`, a.direction && a.direction === 'out' ? 'spending' : a.direction === 'in' ? 'deposits' : '', a.group_by && `grouped by ${a.group_by}`].filter(Boolean);
    return `Searching transactions${bits.length ? ` (${bits.join(', ')})` : ''}`;
  },
  run: (a, { data }) => {
    const merchant = a.merchant?.toLowerCase();
    const since = a.since ? parseDay(a.since) : null;
    const until = a.until ? parseDay(a.until) : null;
    const rows = usableTxns(data).filter((t) => {
      if (a.account_id && t.account_id !== a.account_id) return false;
      if (a.category && t.category !== a.category) return false;
      if (merchant && !t.merchant.toLowerCase().includes(merchant) && !t.description.toLowerCase().includes(merchant)) return false;
      const d = parseDay(t.date)!;
      if (since !== null && d < since) return false;
      if (until !== null && d > until) return false;
      if (a.direction === 'in' && t.amount < 0) return false;
      if (a.direction === 'out' && t.amount >= 0) return false;
      const abs = Math.abs(t.amount);
      if (a.min_amount !== undefined && abs < a.min_amount) return false;
      if (a.max_amount !== undefined && abs > a.max_amount) return false;
      return true;
    });
    // grouped totals are about spending, so moves between the household's own accounts are left out unless asked for
    if (a.group_by && !a.include_transfers) {
      const keep = rows.filter((t) => !INTERNAL.has(t.category));
      rows.length = 0;
      rows.push(...keep);
    }
    rows.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
    const total_out = round2(rows.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0));
    const total_in = round2(rows.reduce((s, t) => s + (t.amount > 0 ? t.amount : 0), 0));
    if (a.group_by) {
      const groups = new Map<string, { key: string; count: number; out: number; in: number }>();
      for (const t of rows) {
        const key = a.group_by === 'category' ? t.category : a.group_by === 'merchant' ? t.merchant : t.date.slice(0, 7);
        const g = groups.get(key) ?? { key, count: 0, out: 0, in: 0 };
        g.count++;
        if (t.amount < 0) g.out += -t.amount;
        else g.in += t.amount;
        groups.set(key, g);
      }
      const list = [...groups.values()]
        .map((g) => ({ ...g, out: round2(g.out), in: round2(g.in) }))
        .sort((x, y) => (a.group_by === 'month' ? (x.key < y.key ? -1 : 1) : y.out + y.in - (x.out + x.in)))
        .slice(0, 15);
      return { matched: rows.length, total_out, total_in, group_by: a.group_by, groups: list };
    }
    const limit = a.limit ?? 15;
    return {
      matched: rows.length,
      total_out,
      total_in,
      transactions: rows.slice(0, limit).map((t) => ({
        id: t.id,
        date: t.date.slice(0, 10),
        amount: t.amount,
        merchant: t.merchant,
        category: t.category,
        account_id: t.account_id,
      })),
    };
  },
  summarize: (r) => `${r.matched} matching transactions, ${usd(r.total_out)} out, ${usd(r.total_in)} in`,
});

export const getObligations = defineTool({
  name: 'get_obligations',
  description: 'List recurring obligations (bills, loans, subscriptions, tuition, insurance, taxes) with amount and due day, plus the monthly total.',
  schema: z.object({ kind: z.string().optional().describe('bill | loan | subscription | tuition | insurance | tax') }),
  describe: (a) => (a.kind ? `Reading ${a.kind} obligations` : 'Reading monthly obligations'),
  run: (a, { data }) => {
    const rows = data.obligations.filter((o) => !a.kind || o.kind === a.kind);
    return {
      count: rows.length,
      monthly_total: round2(rows.reduce((s, o) => s + o.amount, 0)),
      obligations: rows.map((o) => ({ id: o.id, name: o.name, amount: o.amount, due_day: o.due_day, kind: o.kind })),
    };
  },
  summarize: (r) => `${r.count} obligations totalling ${usd(r.monthly_total)} per month`,
});

export const getCreditProfiles = defineTool({
  name: 'get_credit_profiles',
  description: 'Credit score, utilization, hard inquiries and late payments for each household member who has a profile.',
  schema: z.object({}),
  describe: () => 'Reading credit profiles',
  run: (_a, { data }) => {
    const names = new Map(data.members.map((m) => [m.id, m.name]));
    const profiles = data.credit.map((c) => ({
      member: names.get(c.member_id) ?? c.member_id,
      score: c.score,
      utilization_pct: c.utilization_pct,
      hard_inquiries_12m: c.hard_inquiries_12m,
      late_payments_24m: c.late_payments_24m,
      oldest_account_years: c.oldest_account_years,
    }));
    const card = data.accounts.filter((a) => a.type === 'credit_card');
    return { count: profiles.length, profiles, card_balance_total: round2(card.reduce((s, a) => s + a.balance, 0)) };
  },
  summarize: (r) => `${r.count} credit profiles${r.count ? `, scores ${r.profiles.map((p: { score: number }) => p.score).join('/')}` : ''}`,
});

export const getHealthIndicators = defineTool({
  name: 'get_health_indicators',
  description:
    'The household financial health indicators already computed in the database: liquidity runway, debt-to-income, credit utilization, savings rate, net worth trend, emergency fund, forecast low point, credit score.',
  schema: z.object({ key: z.string().optional().describe('Return only this indicator key') }),
  describe: (a) => (a.key ? `Reading health indicator ${a.key}` : 'Reading health indicators'),
  run: (a, { data }) => {
    const rows = data.health.filter((h) => !a.key || h.key === a.key);
    return {
      count: rows.length,
      indicators: rows.map((h) => ({ key: h.key, label: h.label, value: h.value, unit: h.unit, status: h.status, explanation: h.explanation })),
    };
  },
  summarize: (r) => {
    const risk = r.indicators.filter((i: { status: string }) => i.status === 'risk').length;
    const watch = r.indicators.filter((i: { status: string }) => i.status === 'watch').length;
    return `${r.count} indicators: ${risk} at risk, ${watch} to watch`;
  },
});

export const getForecast = defineTool({
  name: 'get_forecast',
  description: 'The 90-day cash forecast computed in the database: starting and ending balance, the lowest point and when, days below zero, obligations due.',
  schema: z.object({ horizon_days: z.number().int().min(7).max(90).optional() }),
  describe: (a) => `Reading the ${a.horizon_days ?? 90}-day cash forecast`,
  run: (a, { data }) => {
    const pts = [...data.forecast].sort((x, y) => (x.date < y.date ? -1 : 1));
    if (!pts.length) return { available: false, note: 'No forecast has been computed yet for this household.' };
    const horizon = a.horizon_days ?? 90;
    const startDay = parseDay(pts[0]!.date) ?? 0;
    const within = pts.filter((p) => (parseDay(p.date) ?? 0) - startDay < horizon);
    let low = within[0]!;
    let below = 0;
    let due = 0;
    for (const p of within) {
      if (p.balance < low.balance) low = p;
      if (p.balance < 0) below++;
      due += p.obligations_due;
    }
    const step = Math.max(1, Math.floor(within.length / 6));
    const sampled = within.filter((_p, i) => i % step === 0 || i === within.length - 1).map((p) => ({ date: p.date, balance: round2(p.balance) }));
    const last = within[within.length - 1]!;
    return {
      available: true,
      start: { date: within[0]!.date, balance: round2(within[0]!.balance) },
      end: { date: last.date, balance: round2(last.balance) },
      lowest: { date: low.date, balance: round2(low.balance) },
      days_below_zero: below,
      obligations_due_total: round2(due),
      net_change_per_month: round2(((last.balance - within[0]!.balance) / Math.max(1, (parseDay(last.date) ?? 0) - startDay)) * 30.4375),
      points: sampled,
      as_of: formatDay(startDay),
    };
  },
  summarize: (r) =>
    r.available ? `Lowest balance ${usd(r.lowest.balance)} on ${r.lowest.date}; ends at ${usd(r.end.balance)}; ${r.days_below_zero} days below zero` : 'No forecast available',
});

export const ledgerTools = [getAccounts, getTransactions, getObligations, getCreditProfiles, getHealthIndicators, getForecast];

// Re-exported for the simulator and feasibility tools.
export { DEBT_TYPES, cashFlow };
