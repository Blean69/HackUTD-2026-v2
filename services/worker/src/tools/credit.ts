// get_credit_score: the simulated credit score the module keeps per member (docs/contracts.md section 9). Read-only, from the
// household's live cache. Always a made-up demo number: the module derives it from household health and the credit profile,
// and the tool says so in every result.
import { z } from 'zod';
import type { CreditFactorRow, CreditHistoryRow, CreditScoreRow, HouseholdData } from '../types.js';
import { parseDay } from '../util.js';
import { defineTool } from './registry.js';

export const CREDIT_NOTE = 'Simulated score for this demo, not a real credit report.';
/** How far back "the 6-month change" looks for its starting point. */
const WINDOW_DAYS = 190;
/** A comparison point must be at least this old to count as a change over time. */
const MIN_AGE_DAYS = 20;

export interface CreditFactorView {
  factor: string;
  effect: 'helping' | 'holding back';
  points: number;
  max_points: number;
  detail: string;
}

export interface CreditMemberView {
  member_id: string;
  member: string;
  score: number;
  band: string;
  /** Change in points since the oldest history point inside the last ~6 months; null when there is no earlier point. */
  change_6m: { points: number; since: string; months: number; from_score: number } | null;
  top_factors: CreditFactorView[];
  history: { date: string; score: number }[];
}

/**
 * The two factors that matter most for this member: the ones furthest from a middling result (half of their possible points),
 * in either direction. A clean payment record shows up as "helping", a maxed-out card as "holding back".
 */
export function topFactors(factors: readonly CreditFactorRow[], n = 2): CreditFactorView[] {
  return [...factors]
    .map((f) => ({ f, gap: f.points - 0.5 * f.max_points }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || (a.f.key < b.f.key ? -1 : 1))
    .slice(0, n)
    .map(({ f, gap }) => ({
      factor: f.label,
      effect: gap >= 0 ? ('helping' as const) : ('holding back' as const),
      points: Math.round(f.points),
      max_points: Math.round(f.max_points),
      detail: f.explanation,
    }));
}

/** Score change over the last ~6 months from the member's history (the latest point is the current score's day). */
export function sixMonthChange(score: number, history: readonly CreditHistoryRow[]): CreditMemberView['change_6m'] {
  const pts = [...history].sort((a, b) => (a.date < b.date ? -1 : 1));
  const latest = pts.length ? pts[pts.length - 1]!.date : '';
  const latestDay = parseDay(latest);
  if (latestDay === null) return null;
  const from = pts.find((p) => {
    const d = parseDay(p.date);
    return d !== null && latestDay - d >= MIN_AGE_DAYS && latestDay - d <= WINDOW_DAYS;
  });
  if (!from) return null;
  const days = latestDay - (parseDay(from.date) ?? latestDay);
  return { points: score - from.score, since: from.date, months: Math.max(1, Math.round(days / 30.4375)), from_score: from.score };
}

export function memberCreditViews(data: HouseholdData, filter?: string): CreditMemberView[] {
  const names = new Map(data.members.map((m) => [m.id, m.name]));
  const q = filter?.trim().toLowerCase();
  const history = data.credit_history ?? [];
  return (data.credit_scores ?? [])
    .map((c: CreditScoreRow) => {
      const own = history.filter((h) => h.member_id === c.member_id);
      const sorted = [...own].sort((a, b) => (a.date < b.date ? -1 : 1));
      const step = Math.max(1, Math.ceil(sorted.length / 7));
      return {
        member_id: c.member_id,
        member: names.get(c.member_id) ?? c.member_id,
        score: c.score,
        band: c.band,
        change_6m: sixMonthChange(c.score, own),
        top_factors: topFactors(c.factors),
        history: sorted.filter((_h, i) => i % step === 0 || i === sorted.length - 1).map((h) => ({ date: h.date, score: h.score })),
      };
    })
    .filter((m) => !q || m.member.toLowerCase().includes(q) || m.member_id.toLowerCase().includes(q))
    .sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
}

export const getCreditScore = defineTool({
  name: 'get_credit_score',
  description:
    'Simulated credit score (300 to 850) for each household member who has one: the score and its band (poor, fair, good, very good, exceptional), ' +
    'the two factors that matter most in plain words (what is helping and what is holding it back), and how it changed over about 6 months. ' +
    'It is a made-up demo score built from the household\'s finances and credit profile, never a real credit report.',
  schema: z.object({ member: z.string().optional().describe('A member name or id; omit for everyone') }),
  describe: (a) => (a.member ? `Reading ${a.member}'s simulated credit score` : 'Reading simulated credit scores'),
  run: (a, { data }) => {
    const members = memberCreditViews(data, a.member);
    if (!members.length) {
      return {
        available: false,
        simulated: true,
        note: a.member ? `No simulated credit score found for "${a.member}".` : 'No simulated credit score has been computed for this household yet.',
      };
    }
    return { available: true, simulated: true, note: CREDIT_NOTE, as_of: data.asOf, count: members.length, members };
  },
  summarize: (r) =>
    r.available
      ? `${r.count} simulated score${r.count === 1 ? '' : 's'}: ${r.members.map((m: CreditMemberView) => `${m.member.split(' ')[0]} ${m.score} (${m.band})`).join(', ')}`
      : 'No simulated credit score available',
});

export const creditTools = [getCreditScore];
