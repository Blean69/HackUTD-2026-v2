import { describe, expect, it } from 'vitest';
import { composeCoachAnswer, routeCoach } from '../llm/local.js';
import { VOICE_VIEW_MAX_CHARS, PHONE_TOOLS, isPhoneTool, voiceView } from '../phone/voice_view.js';
import { smallHousehold } from '../testing/fixtures.js';
import type { CreditFactorRow, CreditHistoryRow, HouseholdData } from '../types.js';
import { CREDIT_NOTE, memberCreditViews, sixMonthChange, topFactors } from './credit.js';
import { FixedExternalApis } from './external.js';
import { buildRegistry } from './index.js';

const f = (key: string, label: string, value: number, weight: number, explanation: string): CreditFactorRow => ({
  key,
  label,
  value,
  weight,
  points: Math.round(550 * weight * value * 10) / 10,
  max_points: Math.round(550 * weight * 10) / 10,
  explanation,
});

const FACTORS_OKAFOR: CreditFactorRow[] = [
  f('household_health', 'Household finances', 0.6, 0.45, 'Household finances score 75 out of 100 (good); the weakest spot is that cards are at 76.5% of their limits.'),
  f('payment_history', 'Payment history', 1, 0.2, 'No late payments in the last 2 years, the biggest single plus.'),
  f('utilization', 'Card utilization', 0.06, 0.15, 'Cards are at 86% of their limits; under 30% helps.'),
  f('history_length', 'Credit history length', 0.6, 0.08, 'The oldest account is 9 years old; a longer history scores higher.'),
  f('new_credit', 'New credit', 0.35, 0.06, '3 hard credit checks in the last year; each one dips the score for a while.'),
  f('credit_mix', 'Credit mix', 0.7, 0.06, '3 kinds of debt (cards, auto loan, personal or student loan); a mix of cards and installment loans helps.'),
];
const FACTORS_RIVERA: CreditFactorRow[] = [
  f('household_health', 'Household finances', 0.63, 0.45, 'Household finances score 79 out of 100 (good).'),
  f('payment_history', 'Payment history', 1, 0.2, 'No late payments in the last 2 years, the biggest single plus.'),
  f('utilization', 'Card utilization', 0.6, 0.15, 'Cards are at 16% of their limits; under 30% helps, under 10% helps more.'),
  f('history_length', 'Credit history length', 0.76, 0.08, 'The oldest account is 16 years old; a longer history scores higher.'),
  f('new_credit', 'New credit', 0.72, 0.06, '1 hard credit check in the last year; each one dips the score for a while.'),
  f('credit_mix', 'Credit mix', 0.7, 0.06, '3 kinds of debt (cards, auto loan, mortgage); a mix of cards and installment loans helps.'),
];

const hist = (member_id: string, pts: [string, number][]): CreditHistoryRow[] => pts.map(([date, score]) => ({ member_id, date, score }));

function withCredit(): HouseholdData {
  return smallHousehold({
    members: [
      { id: 'm1', household_id: 'hh_test', name: 'Alex Test', age: 40, role: 'parent', income_annual: 60000 },
      { id: 'm2', household_id: 'hh_test', name: 'Bea Test', age: 38, role: 'parent', income_annual: 50000 },
      { id: 'm3', household_id: 'hh_test', name: 'Kid Test', age: 9, role: 'child', income_annual: 0 },
    ],
    credit_scores: [
      { member_id: 'm1', score: 622, band: 'fair', factors: FACTORS_OKAFOR },
      { member_id: 'm2', score: 692, band: 'good', factors: FACTORS_RIVERA },
    ],
    credit_history: [
      ...hist('m1', [['2026-06-07', 605], ['2026-08-07', 615], ['2026-10-07', 620], ['2026-11-07', 622]]),
      ...hist('m2', [['2026-06-07', 697], ['2026-10-07', 684], ['2026-11-07', 692]]),
    ],
  });
}
const reg = buildRegistry();
const ctx = (data: HouseholdData) => ({ data, external: new FixedExternalApis() });

describe('topFactors', () => {
  it('picks the two factors furthest from middling, in either direction, in plain words', () => {
    const top = topFactors(FACTORS_OKAFOR);
    expect(top).toHaveLength(2);
    expect(top[0]).toMatchObject({ factor: 'Payment history', effect: 'helping', detail: 'No late payments in the last 2 years, the biggest single plus.' });
    expect(top[1]).toMatchObject({ factor: 'Card utilization', effect: 'holding back', detail: 'Cards are at 86% of their limits; under 30% helps.' });
    expect(topFactors(FACTORS_RIVERA).map((x) => x.effect)).toEqual(['helping', 'helping']);
  });
});

describe('sixMonthChange', () => {
  it('compares the current score with the oldest point inside the last ~6 months', () => {
    const c = sixMonthChange(622, hist('m1', [['2026-06-07', 605], ['2026-08-07', 615], ['2026-11-07', 622]]));
    expect(c).toEqual({ points: 17, since: '2026-06-07', months: 5, from_score: 605 });
  });
  it('is null with no earlier point, or only a very recent one', () => {
    expect(sixMonthChange(600, [])).toBeNull();
    expect(sixMonthChange(600, hist('m', [['2026-11-07', 600]]))).toBeNull();
    expect(sixMonthChange(600, hist('m', [['2026-11-01', 590], ['2026-11-07', 600]]))).toBeNull();
    // a point older than ~190 days is out of the window
    expect(sixMonthChange(600, hist('m', [['2026-01-01', 500], ['2026-11-07', 600]]))).toBeNull();
  });
});

describe('get_credit_score', () => {
  it('returns per member: score, band, top two factors, the 6-month change; labelled as simulated', async () => {
    const out = await reg.execute('get_credit_score', {}, ctx(withCredit()));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.result as { available: boolean; simulated: boolean; note: string; count: number; members: ReturnType<typeof memberCreditViews> };
    expect(r).toMatchObject({ available: true, simulated: true, note: CREDIT_NOTE, count: 2 });
    expect(r.members.map((m) => [m.member, m.score, m.band])).toEqual([['Alex Test', 622, 'fair'], ['Bea Test', 692, 'good']]); // the child has no score
    expect(r.members[0]!.change_6m).toEqual({ points: 17, since: '2026-06-07', months: 5, from_score: 605 });
    expect(r.members[0]!.top_factors).toHaveLength(2);
    expect(r.members[0]!.history.at(-1)).toEqual({ date: '2026-11-07', score: 622 });
    expect(out.summary).toBe('2 simulated scores: Alex 622 (fair), Bea 692 (good)');
    expect(JSON.stringify(r).length).toBeLessThan(3500);
  });

  it('filters by member name or id; a guessed surname still finds them; no match returns everyone; says so when nothing is computed', async () => {
    const one = await reg.execute('get_credit_score', { member: 'bea' }, ctx(withCredit()));
    expect(one.ok && (one.result as { count: number }).count).toBe(1);
    const guessed = await reg.execute('get_credit_score', { member: 'Bea Rivera' }, ctx(withCredit())); // she is Bea Test
    expect(guessed.ok && (guessed.result as { members: { member: string }[] }).members.map((m) => m.member)).toEqual(['Bea Test']);
    const none = await reg.execute('get_credit_score', { member: 'zed' }, ctx(withCredit()));
    expect(none.ok && none.result).toMatchObject({ available: true, simulated: true, count: 2 });
    expect(none.ok && (none.result as { note: string }).note).toMatch(/No member called "zed"; these are everyone's scores/);
    const empty = await reg.execute('get_credit_score', {}, ctx(smallHousehold()));
    expect(empty.ok && empty.result).toMatchObject({ available: false });
    expect(empty.ok && (empty.result as { note: string }).note).toMatch(/has been computed/);
  });

  it('is in the one registry the coach and the agents use, with a JSON schema', () => {
    expect(reg.has('get_credit_score')).toBe(true);
    const spec = reg.specs(['get_credit_score'])[0]!;
    expect(spec.description).toMatch(/Simulated credit score/);
    expect(spec.parameters).toMatchObject({ type: 'object' });
    expect(reg.describeCall('get_credit_score', { member: 'Bea' })).toBe("Reading Bea's simulated credit score");
  });
});

describe('Brian (voice)', () => {
  it('get_credit_score is a phone tool and its voice view is small, spoken-friendly and says simulated', async () => {
    expect(PHONE_TOOLS).toContain('get_credit_score');
    expect(isPhoneTool('get_credit_score')).toBe(true);
    const out = await reg.execute('get_credit_score', {}, ctx(withCredit()));
    if (!out.ok) throw new Error(out.error);
    const v = voiceView('get_credit_score', out.result) as { note: string; scores: { name: string; score: number; band: string; change: { points: number; months: number } | null; top_factors: { factor: string; effect: string; note: string }[] }[] };
    expect(v.note).toMatch(/Simulated/);
    expect(v.scores).toHaveLength(2);
    expect(v.scores[0]).toMatchObject({ name: 'Alex Test', score: 622, band: 'fair', change: { points: 17, months: 5 } });
    expect(v.scores[0]!.top_factors).toHaveLength(2);
    expect(v.scores[0]!.top_factors.every((t) => t.note.length <= 90)).toBe(true);
    expect(JSON.stringify(v).length).toBeLessThanOrEqual(VOICE_VIEW_MAX_CHARS);
    expect(voiceView('get_credit_score', { available: false, note: 'No simulated credit score has been computed for this household yet.' })).toEqual({ available: false, note: 'No simulated credit score has been computed for this household yet.' });
  });

  it('even a big household stays under the voice size cap', () => {
    const many = Array.from({ length: 6 }, (_v, i) => ({ member: `Person Number${i}`, member_id: `m${i}`, score: 700 + i, band: 'good', change_6m: { points: -12, since: '2026-06-07', months: 5, from_score: 712 }, top_factors: topFactors(FACTORS_OKAFOR), history: [] }));
    const v = voiceView('get_credit_score', { available: true, members: many }) as { scores: unknown[] };
    expect(v.scores).toHaveLength(4);
    expect(JSON.stringify(v).length).toBeLessThanOrEqual(VOICE_VIEW_MAX_CHARS);
  });
});

describe('offline coach', () => {
  it('a credit question runs get_credit_score and answers in plain words, flagged as demo numbers', async () => {
    const calls = routeCoach('How is our credit score doing?', '2026-11-07');
    expect(calls.map((c) => c.tool)).toEqual(['get_credit_score', 'get_accounts']);
    const out = await reg.execute('get_credit_score', {}, ctx(withCredit()));
    if (!out.ok) throw new Error(out.error);
    const text = composeCoachAnswer('How is our credit score doing?', [{ name: 'get_credit_score', result: out.result }]);
    expect(text).toContain('Alex Test 622 (fair, up 17 over 5 months; payment history helping and card utilization holding back)');
    expect(text).toContain('demo numbers');
  });
});
