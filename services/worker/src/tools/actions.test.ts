// What Brian can do for the family beyond the kids (goals, What-If Studio, alerts, family votes): every write asks first, resolves things by
// words, stays under its caps, and refuses outside a call. Kids tools: kids.test.ts.
import { describe, expect, it } from 'vitest';
import { PHONE_TOOLS, VOICE_VIEW_MAX_CHARS, voiceView } from '../phone/voice_view.js';
import { smallHousehold } from '../testing/fixtures.js';
import { toolCtx } from '../testing/fake_act.js';
import type { HouseholdData } from '../types.js';
import { ASK_NOTE, niceDate, pickByWords } from './confirm.js';
import { changeGoal, getGoals } from './goals.js';
import { buildRegistry, WRITE_TOOLS } from './index.js';
import { biggestAmount, saveWhatIf } from './studio.js';
import { createProposal, getAlerts, getProposals, markAlertHandled } from './family.js';

const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();

function household(): HouseholdData {
  return smallHousehold({
    goals: [
      { id: 'goal_a', title: 'Family trip to Hawaii', target_amount: 8000, target_date: '2027-08-01', priority: 2, feasibility: 'stretch', evidence_quote: 'We keep saying Hawaii', source: 'huddle' },
      { id: 'goal_b', title: 'College fund', target_amount: 50000, target_date: '2040-09-01', priority: 1, feasibility: 'off_track' },
      { id: 'goal_c', title: 'College savings for Mateo', target_amount: 0, target_date: '', priority: 3, feasibility: '' },
      { id: 'goal_d', title: 'Second bakery location', target_amount: 60000, target_date: '2028-06-01', priority: 1, feasibility: 'stretch' },
    ],
    alerts: [
      { id: 'a1', severity: 'info', kind: 'insight', title: 'Your CD matures soon', detail: 'Decide before then.', acknowledged_by: '', created_at: '2026-11-01T10:00:00.000Z' },
      { id: 'a2', severity: 'critical', kind: 'fraud', title: 'Card testing at Paysafe', detail: 'Six tiny charges overnight.', acknowledged_by: '', created_at: '2026-11-05T10:00:00.000Z' },
      { id: 'a3', severity: 'warn', kind: 'data_quality', title: 'Possible double charge at Home Depot', detail: 'Same amount twice on Oct 14.', acknowledged_by: '', created_at: '2026-11-04T10:00:00.000Z' },
      { id: 'a4', severity: 'warn', kind: 'data_quality', title: 'Already handled thing', detail: '', acknowledged_by: 'Alex', created_at: '2026-11-03T10:00:00.000Z' },
    ],
    proposals: [
      { id: 'p1', title: 'Buy a used minivan', amount: 22000, status: 'open', verdict: 'tight', closes_at: inDays(3), created_by_name: 'Alex', created_at: '2026-11-06T10:00:00.000Z' },
      { id: 'p2', title: 'New roof', amount: 9000, status: 'open', verdict: '', closes_at: inDays(-1), created_by_name: 'Sam', created_at: '2026-10-01T10:00:00.000Z' },
    ],
    votes: [
      { proposal_id: 'p1', choice: 'yes' },
      { proposal_id: 'p1', choice: 'yes' },
      { proposal_id: 'p1', choice: 'no' },
    ],
  });
}

const note = (r: unknown): string => String((r as { note?: string }).note ?? '');

describe('pickByWords: which one did they mean', () => {
  const items = ['Family trip to Hawaii', 'College fund', 'College savings for Mateo', 'Second bakery location'];
  const find = (said: string) => pickByWords(items, said, (s) => s, 'goal');
  it('finds by a few words, case, plural and spelling', () => {
    expect(find('the Hawaii trip')).toBe('Family trip to Hawaii');
    expect(find('HAWAI trips')).toBe('Family trip to Hawaii'); // a missing letter, a plural
    expect(find('bakery')).toBe('Second bakery location');
    expect(find('college fund')).toBe('College fund');
    expect(find('our college fund goal')).toBe('College fund');
  });
  it('asks instead of guessing when two fit equally or nothing fits, and lists the choices', () => {
    expect(find('college')).toMatchObject({ error: expect.stringMatching(/More than one goal fits "college".*College fund.*College savings/) });
    expect(find('spaceship')).toMatchObject({ error: expect.stringMatching(/No goal matching "spaceship".*Hawaii.*bakery/) });
    expect(find('')).toMatchObject({ error: expect.stringMatching(/Which goal\?/) });
    expect(pickByWords(['Only one'], 'the goal', (s) => s, 'goal')).toBe('Only one'); // nothing but filler words, one choice
    expect(pickByWords([], 'x', (s: string) => s, 'alert')).toMatchObject({ error: 'There are no alerts to choose from.' });
  });
  it('says dates the way a person does', () => {
    expect(niceDate('2028-06-01')).toBe('June 1, 2028');
    expect(niceDate('soon')).toBe('soon');
  });
});

describe('goals', () => {
  it('get_goals: priority order, plain status words, friendly dates', () => {
    const { ctx } = toolCtx(household());
    const r = getGoals.run({}, ctx) as { count: number; goals: { goal: string; target: number | null; by: string | null; status: string }[] };
    expect(r.count).toBe(4);
    expect(r.goals.map((g) => g.goal)).toEqual(['College fund', 'Second bakery location', 'Family trip to Hawaii', 'College savings for Mateo']);
    expect(r.goals[2]).toEqual({ goal: 'Family trip to Hawaii', target: 8000, by: 'August 1, 2027', status: 'a stretch' });
    expect(r.goals[3]).toEqual({ goal: 'College savings for Mateo', target: null, by: null, status: 'not checked yet' });
  });

  it('add: the first call only asks (even with confirmed true), the second writes the same row the Goals page makes, plus a verdict', async () => {
    const { ctx, calls } = toolCtx(household());
    const args = { action: 'add' as const, goal: 'New couch', target_amount: 600, target_date: '2027-03-01' };
    expect(await changeGoal.run({ ...args, confirmed: true }, ctx)).toMatchObject({ done: false, ask: 'Add the goal "New couch", $600 by March 1, 2027?', note: ASK_NOTE });
    expect(calls).toEqual([]);
    const r = await changeGoal.run({ ...args, confirmed: true }, ctx);
    expect(r).toMatchObject({ done: true, action: 'added', goal: 'New couch', target: 600, by: 'March 1, 2027', check: 'on track' }); // $600 is well inside $10,000 of savings
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('goal');
    expect(calls[0]![1]).toMatchObject({ title: 'New couch', target_amount: 600, target_date: '2027-03-01', priority: 2, feasibility: 'on_track', evidence_quote: '', source: 'manual' });
    expect((calls[0]![1] as { id: string }).id).toMatch(/^goal_brian_[a-z0-9]+$/);
    // the yes is spent
    expect(await changeGoal.run({ ...args, confirmed: true }, ctx)).toMatchObject({ done: false });
    expect(calls).toHaveLength(1);
  });

  it('add: a bigger goal gets an honest verdict, no amount means nothing to check, gambling is never on track', async () => {
    const { ctx, calls } = toolCtx(household());
    const go = async (a: Parameters<typeof changeGoal.run>[0]) => {
      await changeGoal.run({ ...a, confirmed: false }, ctx);
      return changeGoal.run({ ...a, confirmed: true }, ctx);
    };
    const big = (await go({ action: 'add', goal: 'Buy a lake house', target_amount: 400000, target_date: '2028-01-01', confirmed: false })) as { check: string; needs_per_month: number; available_per_month: number };
    expect(['off track', 'a stretch']).toContain(big.check);
    expect(big.needs_per_month).toBeGreaterThan(big.available_per_month);
    expect(await go({ action: 'add', goal: 'Learn guitar', confirmed: false })).toMatchObject({ done: true, check: 'needs an amount to check', target: null, by: null });
    expect(await go({ action: 'add', goal: 'Win big at the casino', target_amount: 2000, confirmed: false })).toMatchObject({ done: true, check: 'not advised' });
    expect(calls.map((c) => (c[1] as { feasibility: string }).feasibility)).toEqual([expect.stringMatching(/off_track|stretch/), 'needs_details', 'not_advised']);
    // no date given: judged over 24 months, but no date is invented on the goal
    expect((calls[0]![1] as { target_date: string }).target_date).toBe('2028-01-01');
    const undated = (await go({ action: 'add', goal: 'Patio furniture', target_amount: 1200, confirmed: false })) as { checked_over: string };
    expect(undated.checked_over).toMatch(/24 months/);
    expect((calls[3]![1] as { target_date: string }).target_date).toBe('');
  });

  it('add: refuses a duplicate, a past or malformed date, and anything over the caps', async () => {
    const { ctx, calls } = toolCtx(household());
    expect(await changeGoal.run({ action: 'add', goal: 'college fund', confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/already a goal "College fund".*update/) });
    expect(await changeGoal.run({ action: 'add', goal: 'Trip', target_date: '2020-01-01', confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/already passed/) });
    expect(await changeGoal.run({ action: 'add', goal: 'Trip', target_date: 'next June', confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/YYYY-MM-DD/) });
    expect(await changeGoal.run({ action: 'add', goal: 'Trip', target_date: '2026-02-30', confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/YYYY-MM-DD/) });
    expect(await changeGoal.run({ action: 'add', goal: 'Trip', target_date: '2099-01-01', confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/too far/) });
    expect(calls).toEqual([]);
    const ok = (over: object) => changeGoal.schema.safeParse({ action: 'add', goal: 'Trip', confirmed: true, ...over }).success;
    expect(ok({ target_amount: 1_000_000 })).toBe(true);
    expect(ok({ target_amount: 1_000_001 })).toBe(false);
    expect(ok({ target_amount: 0 })).toBe(false);
    expect(ok({ target_amount: -5 })).toBe(false);
    expect(ok({ goal: 'x' })).toBe(false);
    expect(changeGoal.schema.safeParse({ action: 'nuke', goal: 'Trip', confirmed: true }).success).toBe(false);
  });

  it('update: finds the goal by words, changes only what was said, and keeps everything else on the goal (id, title, priority, quote, source)', async () => {
    const { ctx, calls } = toolCtx(household());
    const a = { action: 'update' as const, goal: 'hawaii trip', target_amount: 9500 };
    expect(await changeGoal.run({ ...a, confirmed: false }, ctx)).toMatchObject({ done: false, ask: 'Update "Family trip to Hawaii": target $9,500?' });
    expect(await changeGoal.run({ ...a, confirmed: true }, ctx)).toMatchObject({ done: true, action: 'updated', goal: 'Family trip to Hawaii', target: 9500, by: 'August 1, 2027' });
    expect(calls[0]![1]).toEqual({ id: 'goal_a', title: 'Family trip to Hawaii', target_amount: 9500, target_date: '2027-08-01', priority: 2, feasibility: expect.stringMatching(/on_track|stretch|off_track/), evidence_quote: 'We keep saying Hawaii', source: 'huddle' });
    const b = { action: 'update' as const, goal: 'bakery', target_date: '2029-01-01' };
    expect(await changeGoal.run({ ...b, confirmed: false }, ctx)).toMatchObject({ ask: 'Update "Second bakery location": by January 1, 2029?' });
    await changeGoal.run({ ...b, confirmed: true }, ctx);
    expect(calls[1]![1]).toMatchObject({ id: 'goal_d', target_amount: 60000, target_date: '2029-01-01', source: 'manual' }); // no source on the row: manual
  });

  it('update and delete: wrong or vague names list the goals instead of guessing; an update with nothing to change says so', async () => {
    const { ctx, calls } = toolCtx(household());
    expect(await changeGoal.run({ action: 'update', goal: 'spaceship', target_amount: 5, confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/No goal matching "spaceship".*Hawaii.*bakery/) });
    expect(await changeGoal.run({ action: 'delete', goal: 'college', confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/More than one goal fits/) });
    expect(await changeGoal.run({ action: 'update', goal: 'bakery', confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/Say what to change/) });
    expect(calls).toEqual([]);
  });

  it('delete: asks, then removes that one goal by id', async () => {
    const { ctx, calls } = toolCtx(household());
    const a = { action: 'delete' as const, goal: 'the college fund goal' };
    expect(await changeGoal.run({ ...a, confirmed: false }, ctx)).toMatchObject({ done: false, ask: 'Delete the goal "College fund"?' });
    expect(await changeGoal.run({ ...a, confirmed: true }, ctx)).toMatchObject({ done: true, action: 'deleted', goal: 'College fund' });
    expect(calls).toEqual([['goal_delete', 'goal_b']]);
  });

  it('refuses to write outside a call with Brian', async () => {
    const { ctx } = toolCtx(household(), false);
    await expect(changeGoal.run({ action: 'add', goal: 'Trip', confirmed: true }, ctx)).rejects.toThrow(/only possible on a call/);
  });
});

describe('save_what_if', () => {
  it('asks first, then queues the question exactly as typed in the Studio', async () => {
    const { ctx, calls } = toolCtx(household());
    const q = '  Buy an $18,000 truck,   financed over 60 months ';
    expect(await saveWhatIf.run({ question: q, confirmed: true }, ctx)).toMatchObject({ done: false, ask: 'Save "Buy an $18,000 truck, financed over 60 months" to the What-If Studio?' });
    expect(calls).toEqual([]);
    expect(await saveWhatIf.run({ question: q, confirmed: true }, ctx)).toMatchObject({ done: true, question: 'Buy an $18,000 truck, financed over 60 months' });
    expect(calls).toEqual([['whatif', 'Buy an $18,000 truck, financed over 60 months']]);
  });

  it('a changed number needs its own yes; absurd amounts are refused; long or empty questions are rejected', async () => {
    const { ctx, calls } = toolCtx(household());
    await saveWhatIf.run({ question: 'Buy a $18,000 truck', confirmed: false }, ctx);
    expect(await saveWhatIf.run({ question: 'Buy a $80,000 truck', confirmed: true }, ctx)).toMatchObject({ done: false });
    expect(await saveWhatIf.run({ question: 'Buy a $18 million yacht', confirmed: true }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/too large/) });
    expect(calls).toEqual([]);
    expect(saveWhatIf.schema.safeParse({ question: 'x'.repeat(301), confirmed: true }).success).toBe(false);
    expect(saveWhatIf.schema.safeParse({ question: 'hi', confirmed: true }).success).toBe(false);
    expect(biggestAmount('a $32k car, $1,500 down, $1.2 million house, $5 more')).toBe(1_200_000);
    expect(biggestAmount('no money here')).toBe(0);
    expect(biggestAmount('$300 mortgage extra')).toBe(300);
  });

  it('refuses outside a call', async () => {
    await expect(saveWhatIf.run({ question: 'Buy a $18,000 truck', confirmed: true }, toolCtx(household(), false).ctx)).rejects.toThrow(/only possible on a call/);
  });
});

describe('alerts', () => {
  it('get_alerts: open alerts only, worst first, short', () => {
    const { ctx } = toolCtx(household());
    const r = getAlerts.run({}, ctx) as { open: number; alerts: { severity: string; title: string }[] };
    expect(r.open).toBe(3);
    expect(r.alerts.map((a) => a.title)).toEqual(['Card testing at Paysafe', 'Possible double charge at Home Depot', 'Your CD matures soon']);
    expect(getAlerts.run({}, toolCtx(smallHousehold()).ctx)).toEqual({ open: 0, alerts: [] });
  });

  it('mark_alert_handled: finds it by words, asks (more firmly for a critical one), marks it once', async () => {
    const { ctx, calls } = toolCtx(household());
    const a = { alert: 'the double charge' };
    expect(await markAlertHandled.run({ ...a, confirmed: false }, ctx)).toMatchObject({ done: false, ask: 'Mark "Possible double charge at Home Depot" as handled?' });
    expect(await markAlertHandled.run({ ...a, confirmed: true }, ctx)).toMatchObject({ done: true, alert: 'Possible double charge at Home Depot', still_open: 2 });
    expect(calls).toEqual([['alert', 'a3']]);
    expect(await markAlertHandled.run({ alert: 'card testing', confirmed: false }, ctx)).toMatchObject({ ask: expect.stringMatching(/Card testing at Paysafe.*critical alert, so only if it has been dealt with/) });
    expect(await markAlertHandled.run({ ...a, confirmed: true }, ctx)).toMatchObject({ done: false }); // spent
    expect(calls).toHaveLength(1);
  });

  it('mark_alert_handled: an already handled alert, an unknown one and an empty list are not guessed at', async () => {
    const { ctx, calls } = toolCtx(household());
    expect(await markAlertHandled.run({ alert: 'already handled thing', confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/No alert matching/) });
    expect(await markAlertHandled.run({ alert: 'the alert', confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/Which alert\?.*Card testing/) }); // three open: ask which
    expect(await markAlertHandled.run({ alert: 'anything', confirmed: false }, toolCtx(smallHousehold()).ctx)).toMatchObject({ done: false, note: 'There are no open alerts.' });
    expect(calls).toEqual([]);
    await expect(markAlertHandled.run({ alert: 'x', confirmed: true }, toolCtx(household(), false).ctx)).rejects.toThrow(/only possible on a call/);
  });
});

describe('family votes', () => {
  it('get_proposals: open votes first with the tally and the affordability check; a lapsed vote reads as closed', () => {
    const { ctx } = toolCtx(household());
    const r = getProposals.run({}, ctx) as { count: number; proposals: Record<string, unknown>[] };
    expect(r.count).toBe(2);
    expect(r.proposals[0]).toMatchObject({ proposal: 'Buy a used minivan', amount: 22000, affordability: 'tight', yes: 2, no: 1, not_sure: 0, proposed_by: 'Alex' });
    expect(String(r.proposals[0]!.voting)).toMatch(/^open until /);
    expect(r.proposals[1]).toMatchObject({ proposal: 'New roof', voting: 'closed', affordability: 'still being checked', yes: 0 });
    expect(getProposals.run({}, toolCtx(smallHousehold()).ctx)).toEqual({ count: 0, proposals: [] });
  });

  it('create_proposal: asks, then opens a vote for the household; capped; a duplicate open vote is refused; there is no voting tool', async () => {
    const { ctx, calls } = toolCtx(household());
    const a = { title: 'Replace the fridge', amount: 1800 };
    expect(await createProposal.run({ ...a, confirmed: true }, ctx)).toMatchObject({ done: false, ask: 'Start a family vote on "Replace the fridge" for $1,800, open 5 days?' });
    expect(calls).toEqual([]);
    expect(await createProposal.run({ ...a, days_open: 3, confirmed: true }, ctx)).toMatchObject({ done: false, ask: expect.stringMatching(/open 3 days/) }); // other days: its own yes
    expect(await createProposal.run({ ...a, days_open: 3, confirmed: true }, ctx)).toMatchObject({ done: true, proposal: 'Replace the fridge', amount: 1800, days_open: 3, note: expect.stringMatching(/Everyone votes there on their own phone/) });
    expect(calls).toEqual([['proposal', { title: 'Replace the fridge', amount: 1800, details: {}, closes_in_days: 3 }]]);
    expect(await createProposal.run({ title: 'buy a used MINIVAN', amount: 22000, confirmed: false }, ctx)).toMatchObject({ done: false, note: expect.stringMatching(/already an open vote "Buy a used minivan"/) });
    expect(await createProposal.run({ title: 'New roof', amount: 9000, confirmed: false }, ctx)).toMatchObject({ ask: expect.any(String) }); // the lapsed vote does not block a new one
    const ok = (over: object) => createProposal.schema.safeParse({ title: 'Trip', amount: 100, confirmed: true, ...over }).success;
    expect(ok({ amount: 1_000_000 })).toBe(true);
    expect(ok({ amount: 1_000_001 })).toBe(false);
    expect(ok({ amount: 0 })).toBe(false);
    expect(ok({ days_open: 15 })).toBe(false);
    expect(ok({ days_open: 0 })).toBe(false);
    expect(ok({ days_open: 2.5 })).toBe(false);
    expect([...buildRegistry().names()].filter((n) => /vote/.test(n))).toEqual([]);
    await expect(createProposal.run({ ...a, confirmed: true }, toolCtx(household(), false).ctx)).rejects.toThrow(/only possible on a call/);
  });
});

describe('the new read tools fit the voice budget even for a crowded household', () => {
  it('long titles, many goals, alerts and proposals: the voice model still gets the whole, unshrunk answer', () => {
    const long = (s: string, i: number): string => `${s} ${i} ${'very long words '.repeat(8)}`.slice(0, 120);
    const data = smallHousehold({
      goals: Array.from({ length: 12 }, (_v, i) => ({ id: `g${i}`, title: long('Goal', i), target_amount: 1_000_000, target_date: '2040-09-30', priority: i, feasibility: 'needs_details' })),
      alerts: Array.from({ length: 12 }, (_v, i) => ({ id: `a${i}`, severity: 'critical', kind: 'fraud', title: long('Alert', i), detail: long('Detail', i), acknowledged_by: '', created_at: `2026-11-0${(i % 9) + 1}T10:00:00.000Z` })),
      proposals: Array.from({ length: 8 }, (_v, i) => ({ id: `p${i}`, title: long('Proposal', i), amount: 999_999, status: 'open', verdict: 'risky', closes_at: inDays(5), created_by_name: 'A very long member name indeed', created_at: `2026-11-0${(i % 9) + 1}T10:00:00.000Z` })),
      votes: Array.from({ length: 30 }, (_v, i) => ({ proposal_id: `p${i % 8}`, choice: ['yes', 'no', 'abstain'][i % 3]! })),
    });
    const { ctx } = toolCtx(data);
    for (const [name, r] of [['get_goals', getGoals.run({}, ctx)], ['get_alerts', getAlerts.run({}, ctx)], ['get_proposals', getProposals.run({}, ctx)]] as const) {
      expect(JSON.stringify(r).length, name).toBeLessThanOrEqual(VOICE_VIEW_MAX_CHARS);
      expect(voiceView(name, r), name).toEqual(JSON.parse(JSON.stringify(r))); // nothing was shrunk or scrubbed away
    }
  });
});

describe('every tool that changes data is fenced', () => {
  const reg = buildRegistry();
  const writers = reg.names().filter((n) => 'confirmed' in ((reg.get(n)!.schema as unknown as { shape: Record<string, unknown> }).shape ?? {}));

  it('any tool with a confirmed flag is a WRITE tool: kept out of the Ask coach and offered to Brian', () => {
    expect(writers.sort()).toEqual(['add_kid_chore', 'add_to_kid_jar', 'approve_kid_chore', 'change_goal', 'create_proposal', 'mark_alert_handled', 'save_what_if', 'set_kid_goal']);
    for (const n of writers) expect(WRITE_TOOLS.has(n), n).toBe(true);
    for (const n of WRITE_TOOLS) {
      expect(reg.has(n), n).toBe(true);
      expect((PHONE_TOOLS as readonly string[]).includes(n), n).toBe(true);
    }
  });

  it('read tools are not write tools, and every new tool is something Brian can call', () => {
    for (const n of ['get_kids', 'get_goals', 'get_alerts', 'get_proposals']) {
      expect(WRITE_TOOLS.has(n), n).toBe(false);
      expect((PHONE_TOOLS as readonly string[]).includes(n), n).toBe(true);
    }
  });

  it('what Brian reads back to the caller survives the injection scrub (questions and notes are not mistaken for orders)', async () => {
    const { ctx } = toolCtx(household());
    const results: [string, unknown][] = [
      ['change_goal', await changeGoal.run({ action: 'add', goal: 'New couch', target_amount: 600, confirmed: false }, ctx)],
      ['save_what_if', await saveWhatIf.run({ question: 'Buy an $18,000 truck', confirmed: false }, ctx)],
      ['mark_alert_handled', await markAlertHandled.run({ alert: 'cd matures', confirmed: false }, ctx)],
      ['create_proposal', await createProposal.run({ title: 'Replace the fridge', amount: 1800, confirmed: false }, ctx)],
    ];
    for (const [name, r] of results) {
      const v = voiceView(name, r) as { ask: string; note: string };
      expect(v.ask, name).toBe((r as { ask: string }).ask);
      expect(v.note, name).toBe(ASK_NOTE);
    }
  });
});
