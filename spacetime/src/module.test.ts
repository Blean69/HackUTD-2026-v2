// Module tests: reducers run against SpacetimeDB's real in-memory datastore (no server needed).
//   npm test
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConnectionId, ScheduleAt, TimeDuration, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as m from './index';

const NOW = Timestamp.fromDate(new Date('2026-11-07T18:00:00Z'));
let conn = 1n;
const who = (sub: string) =>
  TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(conn++));

function fresh() {
  const test = createModuleTestHarness(spacetimedb, m, { rngSeed: 7n });
  test.clock.set(NOW);
  return test;
}

// ---- a tiny household in the shape of data/seed/*.json -------------------------------------------------------------
const households = [{ id: 'hh_demo', name: 'The Demos', city: 'Dallas', state: 'TX', persona: 'bakery owners', home_value: 310000, vehicle_value: 18000 }];
const members = [
  { id: 'mem_a', household_id: 'hh_demo', name: 'Ana', age: 41, role: 'parent', income_annual: 72000 },
  { id: 'mem_b', household_id: 'hh_demo', name: 'Ben', age: 12, role: 'child', income_annual: 0 },
];
const accounts = [
  { id: 'acct_chk', household_id: 'hh_demo', owner_member_ids: ['mem_a'], type: 'checking', institution: 'PNC', nickname: 'Main', balance: 4200, opened_date: '2018-01-01' },
  { id: 'acct_sav', household_id: 'hh_demo', owner_member_ids: ['mem_a', 'mem_b'], type: 'savings', institution: 'PNC', nickname: 'Rainy day', balance: 3000, rate_pct: 4.1, opened_date: '2019-01-01' },
  { id: 'acct_cc', household_id: 'hh_demo', owner_member_ids: ['mem_a'], type: 'credit_card', institution: 'PNC', nickname: 'Visa', balance: 2400, credit_limit: 6000, monthly_payment: 70, opened_date: '2020-01-01' },
];
const txns: Record<string, unknown>[] = [];
let tn = 0;
const addTxn = (date: string, amount: number, merchant: string, extra: Record<string, unknown> = {}) =>
  txns.push({ id: `txn_${String(++tn).padStart(4, '0')}`, account_id: 'acct_chk', date, amount, merchant, category: 'shopping', description: '', is_recurring: false, ...extra });
for (const mo of ['2026-08', '2026-09', '2026-10', '2026-11']) {
  addTxn(`${mo}-01`, 3000, 'DEMO BAKERY PAYROLL', { category: 'income', is_recurring: true });
  addTxn(`${mo}-03`, -1400, 'Oak Cliff Rent', { category: 'housing', is_recurring: true });
  for (const d of ['05', '12', '21']) if (`${mo}-${d}` <= '2026-11-07') addTxn(`${mo}-${d}`, -(60 + Number(d)), 'Tom Thumb', { category: 'groceries' });
}
// planted data-quality problems (anomaly is ground truth: rules must not use it)
addTxn('2026-10-14', -37.25, 'Home Depot', { anomaly: 'duplicate' });
addTxn('2026-10-14', -37.25, 'Home Depot', { anomaly: 'duplicate' });
addTxn('2026-10-15', -9.5, 'CafÃ© Rosa', { anomaly: 'garbled' });
addTxn('2026-10-16', -2_400_000, 'Mystery Wire', { anomaly: 'impossible_value' });
addTxn('2027-03-01', -20, 'Time Machine Cafe', { anomaly: 'impossible_value' });
for (let i = 0; i < 6; i++) addTxn(`2026-10-17T03:${String(10 + i * 3).padStart(2, '0')}:00Z`, -(0.99 + i / 100), 'PAYSAFE*TEST', { anomaly: 'card_testing' });
const credit = [{ member_id: 'mem_a', score: 712, utilization_pct: 40, hard_inquiries_12m: 2, oldest_account_years: 8, late_payments_24m: 1 }];
const obligations = [
  { id: 'obl_rent', household_id: 'hh_demo', name: 'Rent', amount: 1400, due_day: 3, account_id: 'acct_chk', kind: 'bill' },
  { id: 'obl_ins', household_id: 'hh_demo', name: 'Car insurance', amount: 180, due_day: 18, account_id: 'acct_chk', kind: 'insurance' },
];
const conversations = [
  { id: 'conv_1', household_id: 'hh_demo', title: 'Dinner talk', turns: [{ speaker: 'Ana', text: 'We want a second shop.' }], expected_goals: [{ title: 'Second shop' }] },
];

const worker = who('worker');
const alice = who('alice');
const bob = who('bob');

function seeded() {
  const test = fresh();
  test.withReducerTx(worker, (ctx) => m.register_worker(ctx, { secret: 'keystone-dev-secret', label: 'test worker' }));
  const j = JSON.stringify;
  test.withReducerTx(worker, (ctx) => {
    m.seed_households(ctx, { rows_json: j(households) });
    m.seed_members(ctx, { rows_json: j(members) });
    m.seed_accounts(ctx, { rows_json: j(accounts) });
    m.seed_credit(ctx, { rows_json: j(credit) });
    m.seed_txns(ctx, { rows_json: j(txns) });
    m.seed_obligations(ctx, { rows_json: j(obligations) });
    m.seed_conversations(ctx, { rows_json: j(conversations) });
  });
  return test;
}

describe('worker auth', () => {
  it('rejects a wrong secret and accepts the dev secret', () => {
    const test = fresh();
    expect(() => test.withReducerTx(bob, (ctx) => m.register_worker(ctx, { secret: 'nope', label: 'x' }))).toThrow('invalid worker secret');
    expect(test.db.worker.count()).toBe(0n);
    test.withReducerTx(bob, (ctx) => m.register_worker(ctx, { secret: 'keystone-dev-secret', label: 'x' }));
    expect(test.db.worker.count()).toBe(1n);
  });

  it('worker-only reducers reject everyone else', () => {
    const test = seeded();
    const rejected = [
      (ctx: never) => m.seed_households(ctx, { rows_json: '[]' }),
      (ctx: never) => m.claim_job(ctx, { job_id: 1n }),
      (ctx: never) => m.purge_transcript(ctx, { huddle_id: 'x' }),
      (ctx: never) => m.set_huddle_status(ctx, { huddle_id: 'x', status: 'done' }),
      (ctx: never) => m.agent_coach_reply(ctx, { household_id: 'hh_demo', text: 'hi', run_id: '' }),
      (ctx: never) => m.agent_update_proposal(ctx, { proposal_id: 'x', verdict: 'fine', analysis_json: '{}', run_id: '' }),
      (ctx: never) => m.seed_proposals(ctx, { rows_json: '[]' }),
      (ctx: never) => m.seed_votes(ctx, { rows_json: '[]' }),
      (ctx: never) => m.agent_enqueue_job(ctx, { workflow: 'phone', household_id: 'hh_demo', subject_id: 'call_1', input_json: '{}' }),
    ];
    for (const call of rejected) {
      expect(() => test.withReducerTx(alice, call as never)).toThrow('worker only');
    }
  });
});

describe('seed reducers', () => {
  it('insert in bulk, skip existing ids, and derive household_id for txns/credit', () => {
    const test = seeded();
    expect(test.db.household.count()).toBe(1n);
    expect(test.db.member.count()).toBe(2n);
    expect(test.db.txn.count()).toBe(BigInt(txns.length));
    expect(test.db.txn.id.find('txn_0001')!.household_id).toBe('hh_demo');
    expect(test.db.credit_profile.member_id.find('mem_a')!.household_id).toBe('hh_demo');
    expect(test.db.account.id.find('acct_sav')!.owner_member_ids_json).toBe('["mem_a","mem_b"]');
    expect(test.db.account.id.find('acct_chk')!.rate_pct).toBeUndefined();
    expect(test.db.account.id.find('acct_sav')!.rate_pct).toBe(4.1);
    // the ground-truth label is stored for scoring
    expect(test.db.txn.iter().next().value).toBeDefined();
    expect([...test.db.txn.iter()].filter((x) => x.anomaly_truth === 'card_testing')).toHaveLength(6);
    // re-seeding is a no-op
    test.withReducerTx(worker, (ctx) => m.seed_txns(ctx, { rows_json: JSON.stringify(txns) }));
    expect(test.db.txn.count()).toBe(BigInt(txns.length));
    // seeding marks the household dirty for the scheduled recompute
    expect(test.db.dirty_household.household_id.find('hh_demo')).toBeTruthy();
  });

  it('fail loudly on a txn whose account has not been seeded', () => {
    const test = fresh();
    test.withReducerTx(worker, (ctx) => m.register_worker(ctx, { secret: 'keystone-dev-secret', label: 'w' }));
    expect(() =>
      test.withReducerTx(worker, (ctx) =>
        m.seed_txns(ctx, { rows_json: JSON.stringify([{ id: 't1', account_id: 'nope', date: '2026-01-01', amount: -1, merchant: 'x', category: '', description: '', is_recurring: false }]) }),
      ),
    ).toThrow('seed_accounts first');
  });
});

describe('recompute_household', () => {
  it('writes indicators, a 90-day forecast and rule alerts, and is idempotent', () => {
    const test = seeded();
    const run = () => test.withReducerTx(alice, (ctx) => m.recompute_household(ctx, { household_id: 'hh_demo' }));
    run();
    const keys = [...test.db.health_indicator.iter()].map((i) => i.key).sort();
    expect(keys).toEqual(['credit_score', 'credit_utilization', 'debt_to_income', 'emergency_fund', 'forecast_low_point', 'liquidity_runway', 'net_worth_trend', 'savings_rate']);
    expect(test.db.health_indicator.id.find('hh_demo:credit_utilization')!.value).toBe(40); // 2400 / 6000
    expect(test.db.forecast_point.count()).toBe(90n);

    const alertIds = [...test.db.alert.iter()].map((a) => a.id).sort();
    expect(alertIds.some((id) => id.startsWith('rule:hh_demo:duplicate:'))).toBe(true);
    expect(alertIds.some((id) => id.startsWith('rule:hh_demo:garbled:'))).toBe(true);
    expect(alertIds.filter((id) => id.startsWith('rule:hh_demo:impossible:'))).toHaveLength(2);
    expect(alertIds.some((id) => id.startsWith('rule:hh_demo:burst:'))).toBe(true);
    expect(test.db.dirty_household.household_id.find('hh_demo')).toBeFalsy();

    const snapshot = () => ({
      ind: [...test.db.health_indicator.iter()].map(({ updated_at: _u, ...r }) => r).sort((a, b) => (a.id < b.id ? -1 : 1)),
      fc: [...test.db.forecast_point.iter()].sort((a, b) => (a.id < b.id ? -1 : 1)),
      al: [...test.db.alert.iter()].map(({ created_at: _c, ...r }) => r).sort((a, b) => (a.id < b.id ? -1 : 1)),
    });
    const before = snapshot();
    test.clock.advance(TimeDuration.fromMillis(5_000));
    run();
    expect(snapshot()).toEqual(before);
    expect(test.db.forecast_point.count()).toBe(90n);
  });

  it('keeps an acknowledgement across recomputes and drops alerts whose cause was fixed', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.recompute_household(ctx, { household_id: 'hh_demo' }));
    const dup = [...test.db.alert.iter()].find((a) => a.id.includes(':duplicate:'))!;
    test.withReducerTx(alice, (ctx) => m.ack_alert(ctx, { alert_id: dup.id, display_name: 'Ana' }));
    test.withReducerTx(alice, (ctx) => m.recompute_household(ctx, { household_id: 'hh_demo' }));
    expect(test.db.alert.id.find(dup.id)!.acknowledged_by).toBe('Ana');
    // remove the duplicate row, recompute, alert disappears
    const dupTxns = JSON.parse(dup.related_ids_json) as string[];
    test.db.txn.id.delete(dupTxns[1]!);
    test.withReducerTx(alice, (ctx) => m.recompute_household(ctx, { household_id: 'hh_demo' }));
    expect(test.db.alert.id.find(dup.id)).toBeFalsy();
  });

  it('never reads anomaly_truth: flipping the labels changes nothing', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.recompute_household(ctx, { household_id: 'hh_demo' }));
    const strip = () => [...test.db.alert.iter()].map((a) => [a.id, a.title, a.detail]).sort();
    const before = strip();
    for (const x of [...test.db.txn.iter()]) test.db.txn.id.update({ ...x, anomaly_truth: x.anomaly_truth ? '' : 'duplicate' });
    test.withReducerTx(alice, (ctx) => m.recompute_household(ctx, { household_id: 'hh_demo' }));
    expect(strip()).toEqual(before);
  });

  it('tick_recompute picks up dirty households', () => {
    const test = seeded();
    expect(test.db.health_indicator.count()).toBe(0n);
    test.withReducerTx(TestAuth.internal(), (ctx) =>
      m.tick_recompute(ctx, { arg: { scheduled_id: 1n, scheduled_at: ScheduleAt.interval(60_000_000n) } }),
    );
    expect(test.db.health_indicator.count()).toBeGreaterThan(5n);
    expect(test.db.dirty_household.count()).toBe(0n);
  });

  it('the 60 s schedule row is created by init and on first connect', () => {
    const test = fresh();
    test.withReducerTx(TestAuth.internal(), (ctx) => m.init(ctx, {}));
    expect(test.db.recompute_tick.count()).toBe(1n);
    test.withReducerTx(alice, (ctx) => m.onConnect(ctx, {}));
    expect(test.db.recompute_tick.count()).toBe(1n);
  });
});

describe('presence', () => {
  it('lobby on connect, room on join_room, gone on disconnect', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.onConnect(ctx, {}));
    expect(test.db.presence.count()).toBe(1n);
    test.withReducerTx(alice, (ctx) => m.join_room(ctx, { household_id: 'hh_demo', display_name: 'Ana', role: 'family' }));
    const row = [...test.db.presence.iter()][0]!;
    expect(row.household_id).toBe('hh_demo');
    expect(row.display_name).toBe('Ana');
    expect(() => test.withReducerTx(alice, (ctx) => m.join_room(ctx, { household_id: 'hh_nope', display_name: 'Ana', role: 'family' }))).toThrow('unknown household');
    expect(() => test.withReducerTx(alice, (ctx) => m.join_room(ctx, { household_id: 'hh_demo', display_name: 'Ana', role: 'admin' }))).toThrow('role must be');
    test.withReducerTx(alice, (ctx) => m.onDisconnect(ctx, {}));
    expect(test.db.presence.count()).toBe(0n);
  });
});

describe('create_sandbox', () => {
  it('deep-copies with fresh ids, remapped foreign keys, fresh health math and a data_quality job', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.create_sandbox(ctx, { template_household_id: 'hh_demo', display_name: 'Judge Judy' }));
    const sbx = [...test.db.household.iter()].find((h) => h.id.startsWith('hh_sbx_'))!;
    expect(sbx.template_id).toBe('hh_demo');
    expect(sbx.owner!.toHexString()).toBeTruthy();
    expect(sbx.id).toMatch(/^hh_sbx_[0-9a-z]{6}$/);
    const suffix = sbx.id.slice('hh_sbx_'.length);

    const sm = [...test.db.member.household_id.filter(sbx.id)];
    const sa = [...test.db.account.household_id.filter(sbx.id)];
    const st = [...test.db.txn.household_id.filter(sbx.id)];
    expect(sm).toHaveLength(2);
    expect(sa).toHaveLength(3);
    expect(st).toHaveLength(txns.length);
    expect([...test.db.obligation.household_id.filter(sbx.id)]).toHaveLength(2);
    expect([...test.db.conversation.household_id.filter(sbx.id)]).toHaveLength(1);
    expect([...test.db.credit_profile.household_id.filter(sbx.id)]).toHaveLength(1);

    // every copied id is fresh; every foreign key points inside the sandbox
    const memberIds = new Set(sm.map((x) => x.id));
    const accountIds = new Set(sa.map((x) => x.id));
    for (const x of [...sm, ...sa, ...st]) expect(x.id.endsWith(`__${suffix}`)).toBe(true);
    for (const x of st) expect(accountIds.has(x.account_id)).toBe(true);
    for (const x of test.db.obligation.household_id.filter(sbx.id)) expect(accountIds.has(x.account_id)).toBe(true);
    for (const x of test.db.credit_profile.household_id.filter(sbx.id)) expect(memberIds.has(x.member_id)).toBe(true);
    for (const x of sa) for (const id of JSON.parse(x.owner_member_ids_json) as string[]) expect(memberIds.has(id)).toBe(true);
    // the template is untouched
    expect([...test.db.txn.household_id.filter('hh_demo')]).toHaveLength(txns.length);

    // health math ran for the sandbox, with the same numbers as the template
    test.withReducerTx(alice, (ctx) => m.recompute_household(ctx, { household_id: 'hh_demo' }));
    const pick = (hh: string) => [...test.db.health_indicator.household_id.filter(hh)].map((i) => [i.key, i.value, i.status]).sort();
    expect(pick(sbx.id)).toEqual(pick('hh_demo'));
    expect([...test.db.forecast_point.household_id.filter(sbx.id)]).toHaveLength(90);
    expect([...test.db.alert.household_id.filter(sbx.id)].length).toBeGreaterThan(0);

    // job + presence
    const jobs = [...test.db.agent_job.iter()].filter((j) => j.household_id === sbx.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.workflow).toBe('data_quality');
    expect(jobs[0]!.status).toBe('queued');
    const p = [...test.db.presence.iter()][0]!;
    expect(p.household_id).toBe(sbx.id);
    expect(p.display_name).toBe('Judge Judy');

    // owner can delete it, nobody else can
    expect(() => test.withReducerTx(bob, (ctx) => m.delete_sandbox(ctx, { household_id: sbx.id }))).toThrow('owner');
    test.withReducerTx(alice, (ctx) => m.delete_sandbox(ctx, { household_id: sbx.id }));
    expect([...test.db.txn.household_id.filter(sbx.id)]).toHaveLength(0);
    expect(test.db.household.id.find(sbx.id)).toBeFalsy();
    expect(() => test.withReducerTx(alice, (ctx) => m.delete_sandbox(ctx, { household_id: 'hh_demo' }))).toThrow('only sandboxes');
  });

  it('two sandboxes get different ids', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.create_sandbox(ctx, { template_household_id: 'hh_demo', display_name: 'A' }));
    test.withReducerTx(bob, (ctx) => m.create_sandbox(ctx, { template_household_id: 'hh_demo', display_name: 'B' }));
    expect([...test.db.household.iter()].filter((h) => h.id.startsWith('hh_sbx_'))).toHaveLength(2);
  });
});

describe('huddle flow + job queue', () => {
  it('start -> append -> end enqueues one huddle job; the worker claims, runs, traces and purges', () => {
    const test = seeded();
    expect(() => test.withReducerTx(alice, (ctx) => m.start_huddle(ctx, { household_id: 'hh_demo', consent_names_json: '[]' }))).toThrow('consent');
    test.withReducerTx(alice, (ctx) => m.join_room(ctx, { household_id: 'hh_demo', display_name: 'Ana', role: 'family' }));
    test.withReducerTx(alice, (ctx) => m.start_huddle(ctx, { household_id: 'hh_demo', consent_names_json: '["Ana","Ben"]' }));
    const h = [...test.db.huddle.iter()][0]!;
    expect(h.status).toBe('live');
    expect(h.started_by_name).toBe('Ana');
    // a second phone starting the same huddle joins it and adds its consent
    test.withReducerTx(bob, (ctx) => m.start_huddle(ctx, { household_id: 'hh_demo', consent_names_json: '["Cara"]' }));
    expect(test.db.huddle.count()).toBe(1n);
    expect(JSON.parse(test.db.huddle.id.find(h.id)!.consent_names_json)).toEqual(['Ana', 'Ben', 'Cara']);

    test.withReducerTx(alice, (ctx) => m.append_transcript(ctx, { huddle_id: h.id, speaker: 'Ana', text: 'We want a second bakery.' }));
    test.withReducerTx(bob, (ctx) => m.append_transcript(ctx, { huddle_id: h.id, speaker: 'Ben', text: 'And college.' }));
    expect(test.db.transcript_line.count()).toBe(2n);
    expect(() => test.withReducerTx(alice, (ctx) => m.append_transcript(ctx, { huddle_id: h.id, speaker: 'x', text: '   ' }))).toThrow('must not be empty');

    test.withReducerTx(alice, (ctx) => m.end_huddle(ctx, { huddle_id: h.id }));
    test.withReducerTx(bob, (ctx) => m.end_huddle(ctx, { huddle_id: h.id })); // idempotent
    expect(test.db.huddle.id.find(h.id)!.status).toBe('analyzing');
    expect(() => test.withReducerTx(alice, (ctx) => m.append_transcript(ctx, { huddle_id: h.id, speaker: 'Ana', text: 'late' }))).toThrow('no longer live');
    const jobs = [...test.db.agent_job.iter()].filter((j) => j.workflow === 'huddle');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.subject_id).toBe(h.id);
    expect(jobs[0]!.household_id).toBe('hh_demo');

    // worker: claim (second claimer loses), run, trace, goal, purge, finish
    const jobId = jobs[0]!.id;
    test.withReducerTx(worker, (ctx) => m.claim_job(ctx, { job_id: jobId }));
    expect(() => test.withReducerTx(worker, (ctx) => m.claim_job(ctx, { job_id: jobId }))).toThrow('already claimed');
    test.withReducerTx(worker, (ctx) => m.start_run(ctx, { run_id: 'run_1', job_id: jobId }));
    test.withReducerTx(worker, (ctx) =>
      m.emit_trace(ctx, { run_id: 'run_1', seq: 1, workflow: 'huddle', agent: 'planner', type: 'plan', title: 'Plan', data_json: '{"x":1}', model: 'nvidia/nemotron', provider: 'nvidia', latency_ms: 120, tokens_in: 10, tokens_out: 20 }),
    );
    test.withReducerTx(worker, (ctx) =>
      m.emit_trace(ctx, { run_id: 'run_1', seq: 2, workflow: 'huddle', agent: 'planner', type: 'thought', title: 'Big', data_json: 'x'.repeat(9000), model: 'm', provider: 'local', latency_ms: 1, tokens_in: 0, tokens_out: 0 }),
    );
    const traces = [...test.db.trace_event.run_id.filter('run_1')].sort((a, b) => a.seq - b.seq);
    expect(traces.map((x) => x.household_id)).toEqual(['hh_demo', 'hh_demo']);
    expect(traces[0]!.provider).toBe('nvidia');
    expect(traces[1]!.data_json.length).toBeLessThan(4096);
    expect(JSON.parse(traces[1]!.data_json).truncated).toBe(true);
    test.withReducerTx(worker, (ctx) =>
      m.agent_upsert_goal(ctx, { id: '', household_id: 'hh_demo', title: 'Second bakery location', target_amount: 90000, target_date: '2028-06-01', priority: 1, feasibility: 'stretch', evidence_quote: 'We want a second bakery.', source: 'huddle' }),
    );
    expect([...test.db.goal.iter()][0]!.feasibility).toBe('stretch');
    test.withReducerTx(worker, (ctx) => m.purge_transcript(ctx, { huddle_id: h.id }));
    expect(test.db.transcript_line.count()).toBe(0n);
    test.withReducerTx(worker, (ctx) => m.set_huddle_status(ctx, { huddle_id: h.id, status: 'done' }));
    test.withReducerTx(worker, (ctx) => m.finish_run(ctx, { run_id: 'run_1', status: 'done', providers_json: '["nvidia"]', result_json: '{"goals":1}' }));
    expect(test.db.agent_job.id.find(jobId)!.status).toBe('done');
    expect(test.db.agent_run.run_id.find('run_1')!.status).toBe('done');
    expect(test.db.agent_run.run_id.find('run_1')!.finished_at).toBeTruthy();
    expect(test.db.huddle.id.find(h.id)!.status).toBe('done');
  });

  it('what-if, coach, goals, advisor notes', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.request_simulation(ctx, { household_id: 'hh_demo', prompt: 'What if we buy a van?' }));
    test.withReducerTx(alice, (ctx) => m.ask_coach(ctx, { household_id: 'hh_demo', text: 'Can we afford it?' }));
    const wf = [...test.db.agent_job.iter()].map((j) => j.workflow).sort();
    expect(wf).toEqual(['coach', 'what_if']);
    const scn = [...test.db.scenario.iter()][0]!;
    expect(scn.status).toBe('queued');
    test.withReducerTx(worker, (ctx) => m.agent_update_scenario(ctx, { id: scn.id, status: 'done', result_json: '{"ok":true}' }));
    expect(test.db.scenario.id.find(scn.id)!.status).toBe('done');
    test.withReducerTx(worker, (ctx) => m.agent_coach_reply(ctx, { household_id: 'hh_demo', text: 'Probably, yes.', run_id: 'run_9' }));
    expect([...test.db.coach_message.iter()].map((x) => x.role)).toEqual(['user', 'assistant']);

    test.withReducerTx(alice, (ctx) => m.upsert_goal(ctx, { id: '', household_id: 'hh_demo', title: 'College fund', target_amount: 50000, target_date: '2040-09-01', priority: 2 }));
    const g = [...test.db.goal.iter()][0]!;
    expect(g.source).toBe('manual');
    test.withReducerTx(worker, (ctx) => m.agent_upsert_goal(ctx, { id: g.id, household_id: 'hh_demo', title: g.title, target_amount: 50000, target_date: '2040-09-01', priority: 2, feasibility: 'on_track', evidence_quote: '', source: 'coach' }));
    test.withReducerTx(alice, (ctx) => m.upsert_goal(ctx, { id: g.id, household_id: 'hh_demo', title: 'College fund', target_amount: 50000, target_date: '2040-09-01', priority: 1 }));
    expect(test.db.goal.id.find(g.id)!.feasibility).toBe('on_track'); // unchanged amount/date keeps the verdict
    test.withReducerTx(alice, (ctx) => m.upsert_goal(ctx, { id: g.id, household_id: 'hh_demo', title: 'College fund', target_amount: 80000, target_date: '2040-09-01', priority: 1 }));
    expect(test.db.goal.id.find(g.id)!.feasibility).toBe(''); // stale verdict cleared
    test.withReducerTx(alice, (ctx) => m.delete_goal(ctx, { id: g.id }));
    expect(test.db.goal.count()).toBe(0n);

    test.withReducerTx(bob, (ctx) => m.post_advisor_note(ctx, { household_id: 'hh_demo', author_name: 'Pat (PNC)', text: 'Call them about the CD maturing.' }));
    expect(test.db.advisor_note.count()).toBe(1n);
    expect([...test.db.alert.iter()].filter((a) => a.kind === 'advisor')).toHaveLength(1);
  });

  it('agent alerts cannot impersonate rule alerts', () => {
    const test = seeded();
    expect(() =>
      test.withReducerTx(worker, (ctx) =>
        m.agent_create_alert(ctx, { id: 'rule:hh_demo:x', household_id: 'hh_demo', severity: 'warn', kind: 'scam', title: 't', detail: '', related_ids_json: '[]' }),
      ),
    ).toThrow('reserved');
    test.withReducerTx(worker, (ctx) =>
      m.agent_create_alert(ctx, { id: 'scam_1', household_id: 'hh_demo', severity: 'critical', kind: 'scam', title: 'Grandson-in-jail call', detail: 'linked to a $2,000 gift-card purchase', related_ids_json: '["txn_0001"]' }),
    );
    // recompute must not touch it
    test.withReducerTx(alice, (ctx) => m.recompute_household(ctx, { household_id: 'hh_demo' }));
    expect(test.db.alert.id.find('scam_1')).toBeTruthy();
  });
});

describe('phone calls: agent_enqueue_job', () => {
  const enqueue = (test: ReturnType<typeof seeded>, a: Partial<{ workflow: string; household_id: string; subject_id: string; input_json: string }> = {}) =>
    test.withReducerTx(worker, (ctx) => m.agent_enqueue_job(ctx, { workflow: 'phone', household_id: 'hh_demo', subject_id: 'call_1', input_json: '{"transport":"webrtc"}', ...a }));

  it('is worker only', () => {
    const test = seeded();
    expect(() => test.withReducerTx(alice, (ctx) => m.agent_enqueue_job(ctx, { workflow: 'phone', household_id: 'hh_demo', subject_id: 'call_1', input_json: '{}' }))).toThrow('worker only');
    expect(test.db.agent_job.count()).toBe(0n);
  });

  it('queues a phone job; the worker claims it, starts the run, traces it and finishes it', () => {
    const test = seeded();
    enqueue(test);
    const jobs = [...test.db.agent_job.iter()];
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job).toMatchObject({ workflow: 'phone', household_id: 'hh_demo', subject_id: 'call_1', status: 'queued', run_id: '' });
    expect(JSON.parse(job.input_json)).toEqual({ transport: 'webrtc' });

    test.withReducerTx(worker, (ctx) => m.claim_job(ctx, { job_id: job.id }));
    test.withReducerTx(worker, (ctx) => m.start_run(ctx, { run_id: 'run_phone_1', job_id: job.id }));
    expect(test.db.agent_run.run_id.find('run_phone_1')).toMatchObject({ workflow: 'phone', household_id: 'hh_demo', status: 'running' });
    test.withReducerTx(worker, (ctx) =>
      m.emit_trace(ctx, { run_id: 'run_phone_1', seq: 0, workflow: 'phone', agent: 'voice_agent', type: 'run_started', title: 'Voice call connected (Demo family)', data_json: '{}', model: '', provider: 'nvidia', latency_ms: 0, tokens_in: 0, tokens_out: 0 }),
    );
    expect(test.db.trace_event.run_id.filter('run_phone_1').next().value!.household_id).toBe('hh_demo');
    test.withReducerTx(worker, (ctx) => m.finish_run(ctx, { run_id: 'run_phone_1', status: 'done', providers_json: '[]', result_json: '{"turns":2}' }));
    expect(test.db.agent_run.run_id.find('run_phone_1')!.status).toBe('done');
    expect(test.db.agent_job.id.find(job.id)!.status).toBe('done');
  });

  it('validates the workflow, the household and the input', () => {
    const test = seeded();
    expect(() => enqueue(test, { workflow: 'telepathy' })).toThrow('workflow must be one of');
    expect(() => enqueue(test, { household_id: 'hh_nope' })).toThrow('unknown household');
    expect(() => enqueue(test, { input_json: '{nope' })).toThrow('valid JSON');
    expect(() => enqueue(test, { input_json: '[1]' })).toThrow('JSON object');
    expect(() => enqueue(test, { input_json: JSON.stringify({ x: 'y'.repeat(9000) }) })).toThrow('too long');
    expect(test.db.agent_job.count()).toBe(0n);
    enqueue(test, { input_json: '' }); // blank means {}
    expect(JSON.parse([...test.db.agent_job.iter()][0]!.input_json)).toEqual({});
  });

  it('refuses a second queued job for the same call, but allows it once the first was claimed', () => {
    const test = seeded();
    enqueue(test);
    expect(() => enqueue(test)).toThrow('already queued');
    enqueue(test, { subject_id: 'call_2' });
    expect(test.db.agent_job.count()).toBe(2n);
    const first = [...test.db.agent_job.iter()].find((j) => j.subject_id === 'call_1')!;
    test.withReducerTx(worker, (ctx) => m.claim_job(ctx, { job_id: first.id }));
    enqueue(test);
    expect(test.db.agent_job.count()).toBe(3n);
  });

  it('other workflows can still be queued by the worker (what_if)', () => {
    const test = seeded();
    enqueue(test, { workflow: 'what_if', subject_id: 'scn_1', input_json: '{"prompt":"buy a car"}' });
    expect([...test.db.agent_job.iter()][0]!.workflow).toBe('what_if');
  });
});

describe('Plaid Sandbox support', () => {
  const j = JSON.stringify;
  it('request_bank_sync enqueues one plaid_sync job; the worker saves the item, accounts and txns', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.request_bank_sync(ctx, { household_id: 'hh_demo' }));
    test.withReducerTx(alice, (ctx) => m.request_bank_sync(ctx, { household_id: 'hh_demo' })); // deduped while queued
    expect([...test.db.agent_job.iter()].filter((x) => x.workflow === 'plaid_sync')).toHaveLength(1);
    expect(() => test.withReducerTx(alice, (ctx) => m.request_bank_sync(ctx, { household_id: 'hh_nope' }))).toThrow('unknown household');

    for (const call of [
      (ctx: never) => m.agent_save_plaid_item(ctx, { item_id: 'i1', household_id: 'hh_demo', access_token: 'access-sandbox-1', institution_id: 'ins_109508', institution_name: 'First Platypus Bank', cursor: '' }),
      (ctx: never) => m.agent_set_bank_connection(ctx, { item_id: 'i1', household_id: 'hh_demo', institution_name: 'x', status: 'ok', accounts_count: 1, txns_count: 1, error: '' }),
      (ctx: never) => m.agent_upsert_accounts(ctx, { rows_json: '[]' }),
      (ctx: never) => m.agent_upsert_txns(ctx, { rows_json: '[]' }),
      (ctx: never) => m.agent_remove_txns(ctx, { ids_json: '[]' }),
    ]) expect(() => test.withReducerTx(alice, call as never)).toThrow('worker only');

    test.withReducerTx(worker, (ctx) =>
      m.agent_save_plaid_item(ctx, { item_id: 'item_1', household_id: 'hh_demo', access_token: 'access-sandbox-secret', institution_id: 'ins_109508', institution_name: 'First Platypus Bank', cursor: '' }),
    );
    expect(test.db.bank_connection.item_id.find('item_1')!.status).toBe('linking');
    test.withReducerTx(worker, (ctx) => m.agent_set_bank_connection(ctx, { item_id: 'item_1', household_id: 'hh_demo', institution_name: '', status: 'syncing', accounts_count: 0, txns_count: 0, error: '' }));
    test.withReducerTx(worker, (ctx) =>
      m.agent_upsert_accounts(ctx, {
        rows_json: j([{ id: 'acct_plaid_A1', household_id: 'hh_demo', type: 'checking', institution: 'First Platypus Bank', nickname: 'Plaid Checking', balance: 110.5, opened_date: '' }]),
      }),
    );
    expect(() => test.withReducerTx(worker, (ctx) => m.agent_upsert_accounts(ctx, { rows_json: j([{ id: 'acct_plaid_B', household_id: 'hh_demo', type: 'depository', balance: 1 }]) }))).toThrow('not one of');
    expect(() => test.withReducerTx(worker, (ctx) => m.agent_upsert_accounts(ctx, { rows_json: j([{ ...accounts[0], balance: 1 }]) }))).toThrow('seed account');
    test.withReducerTx(worker, (ctx) =>
      m.agent_upsert_txns(ctx, {
        rows_json: j([
          { id: 'txn_plaid_T1', account_id: 'acct_plaid_A1', date: '2026-11-05', amount: -12.34, merchant: 'Sparkfun', category: 'shopping', description: '', is_recurring: false, anomaly: 'duplicate' },
          { id: 'txn_plaid_T2', account_id: 'acct_plaid_A1', date: '2026-11-06', amount: 500, merchant: 'Payroll', category: 'income', description: '', is_recurring: true },
        ]),
      }),
    );
    const t1 = test.db.txn.id.find('txn_plaid_T1')!;
    expect(t1.source).toBe('plaid');
    expect(t1.household_id).toBe('hh_demo');
    expect(t1.anomaly_truth).toBe(''); // Plaid rows never carry ground truth
    expect(test.db.account.id.find('acct_plaid_A1')!.source).toBe('plaid');
    expect(test.db.account.id.find('acct_chk')!.source).toBe('seed');
    expect(test.db.txn.id.find('txn_0001')!.source).toBe('seed');
    // modified rows update in place
    test.withReducerTx(worker, (ctx) => m.agent_upsert_txns(ctx, { rows_json: j([{ id: 'txn_plaid_T1', account_id: 'acct_plaid_A1', date: '2026-11-05', amount: -15, merchant: 'Sparkfun', category: 'shopping', description: '', is_recurring: false }]) }));
    expect(test.db.txn.id.find('txn_plaid_T1')!.amount).toBe(-15);
    // removal only touches plaid rows
    test.withReducerTx(worker, (ctx) => m.agent_remove_txns(ctx, { ids_json: j(['txn_plaid_T2', 'txn_0001', 'nope']) }));
    expect(test.db.txn.id.find('txn_plaid_T2')).toBeFalsy();
    expect(test.db.txn.id.find('txn_0001')).toBeTruthy();
    // connection stamps last_synced_at on ok, records errors
    test.withReducerTx(worker, (ctx) => m.agent_set_bank_connection(ctx, { item_id: 'item_1', household_id: 'hh_demo', institution_name: '', status: 'ok', accounts_count: 1, txns_count: 1, error: 'ignored' }));
    const c = test.db.bank_connection.item_id.find('item_1')!;
    expect(c.status).toBe('ok');
    expect(c.error).toBe('');
    expect(c.institution_name).toBe('First Platypus Bank');
    expect(c.last_synced_at).toBeTruthy();
    test.withReducerTx(worker, (ctx) => m.agent_set_bank_connection(ctx, { item_id: 'item_1', household_id: 'hh_demo', institution_name: '', status: 'error', accounts_count: 1, txns_count: 1, error: 'ITEM_LOGIN_REQUIRED' }));
    expect(test.db.bank_connection.item_id.find('item_1')!.error).toBe('ITEM_LOGIN_REQUIRED');
    expect(() => test.withReducerTx(worker, (ctx) => m.agent_set_bank_connection(ctx, { item_id: 'item_1', household_id: 'hh_demo', institution_name: '', status: 'weird', accounts_count: 0, txns_count: 0, error: '' }))).toThrow('status must be');

    // cursor-only update keeps the token
    test.withReducerTx(worker, (ctx) => m.agent_save_plaid_item(ctx, { item_id: 'item_1', household_id: 'hh_demo', access_token: '', institution_id: '', institution_name: '', cursor: 'cur_9' }));
    const item = test.db.plaid_item.item_id.find('item_1')!;
    expect(item.access_token).toBe('access-sandbox-secret');
    expect(item.cursor).toBe('cur_9');

    // the token is visible to workers through the view, and to nobody else
    const seen = (auth: ReturnType<typeof who>) => m.worker_plaid_items(test.viewContext(auth)) as unknown as { item_id: string }[];
    expect([...seen(worker)].map((x) => x.item_id)).toEqual(['item_1']);
    expect([...seen(alice)]).toEqual([]);
  });

  it('create_sandbox does not copy plaid_item or bank_connection rows', () => {
    const test = seeded();
    test.withReducerTx(worker, (ctx) => m.agent_save_plaid_item(ctx, { item_id: 'item_1', household_id: 'hh_demo', access_token: 'tok', institution_id: 'ins', institution_name: 'Bank', cursor: '' }));
    test.withReducerTx(alice, (ctx) => m.create_sandbox(ctx, { template_household_id: 'hh_demo', display_name: 'J' }));
    const sbx = [...test.db.household.iter()].find((h) => h.id.startsWith('hh_sbx_'))!;
    expect([...test.db.bank_connection.household_id.filter(sbx.id)]).toHaveLength(0);
    expect([...test.db.plaid_item.household_id.filter(sbx.id)]).toHaveLength(0);
    expect(test.db.plaid_item.count()).toBe(1n);
    expect(test.db.bank_connection.count()).toBe(1n);
  });
});

// ---- worker secret override (production needs no source edit) -------------------------------------------------------
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const publisher = who('publisher');

describe('worker secret hash override', () => {
  const PROD = sha256('a-long-random-production-secret');
  const registerWith = (test: ReturnType<typeof fresh>, auth: ReturnType<typeof who>, secret: string) =>
    test.withReducerTx(auth, (ctx) => m.register_worker(ctx, { secret, label: 'w' }));
  const setHash = (test: ReturnType<typeof fresh>, auth: ReturnType<typeof who>, hex: string) =>
    test.withReducerTx(auth, (ctx) => m.admin_set_worker_secret_hash(ctx, { sha256_hex: hex }));
  const idOf = (test: ReturnType<typeof fresh>, auth: ReturnType<typeof who>) => test.withReducerTx(auth, (ctx) => ctx.sender.toHexString());
  const published = () => {
    const test = fresh();
    test.withReducerTx(publisher, (ctx) => m.init(ctx, {})); // the host runs init as the publishing identity
    return test;
  };

  it('init records ctx.sender as the publisher, with no override yet', () => {
    const test = published();
    expect(test.db.module_config.count()).toBe(1n);
    const row = test.db.module_config.id.find(1)!;
    expect(row.publisher!.toHexString()).toBe(idOf(test, publisher));
    expect(row.publisher!.toHexString()).not.toBe(idOf(test, alice));
    expect(row.worker_secret_hash).toBe('');
    // running init again (e.g. after a publish that wipes data) never creates a second row and keeps an override
    setHash(test, publisher, PROD);
    test.withReducerTx(publisher, (ctx) => m.init(ctx, {}));
    expect(test.db.module_config.count()).toBe(1n);
    expect(test.db.module_config.id.find(1)!.worker_secret_hash).toBe(PROD);
  });

  it('the dev hash is the default; the publisher can replace it, and then the dev secret stops working', () => {
    const test = published();
    registerWith(test, alice, 'keystone-dev-secret'); // default still accepts the dev secret
    expect(test.db.worker.count()).toBe(1n);
    setHash(test, publisher, PROD);
    expect(() => registerWith(test, bob, 'keystone-dev-secret')).toThrow('invalid worker secret');
    expect(() => registerWith(test, bob, 'wrong')).toThrow('invalid worker secret');
    registerWith(test, bob, 'a-long-random-production-secret');
    expect(test.db.worker.count()).toBe(2n);
    // the registered worker works as before
    expect(() => test.withReducerTx(bob, (ctx) => m.claim_job(ctx, { job_id: 99n }))).toThrow('unknown job');
  });

  it('only the publisher may call it: strangers and even registered workers are rejected', () => {
    const test = published();
    registerWith(test, alice, 'keystone-dev-secret');
    for (const who_ of [alice, bob]) expect(() => setHash(test, who_, PROD)).toThrow('not allowed');
    expect(test.db.module_config.id.find(1)!.worker_secret_hash).toBe('');
    setHash(test, publisher, PROD);
    // once set, a registered worker still cannot rotate it
    expect(() => setHash(test, alice, sha256('mine'))).toThrow('not allowed');
    expect(test.db.module_config.id.find(1)!.worker_secret_hash).toBe(PROD);
  });

  it('validates and normalizes the digest; "" returns to the dev default', () => {
    const test = published();
    for (const bad of ['abc', 'g'.repeat(64), PROD.slice(1), `${PROD}0`, 'keystone-dev-secret']) {
      expect(() => setHash(test, publisher, bad)).toThrow('64 hex');
    }
    setHash(test, publisher, `  ${PROD.toUpperCase()}\n`);
    expect(test.db.module_config.id.find(1)!.worker_secret_hash).toBe(PROD);
    setHash(test, publisher, '');
    expect(test.db.module_config.id.find(1)!.worker_secret_hash).toBe('');
    registerWith(test, alice, 'keystone-dev-secret');
  });

  it('LEGACY (database published before init recorded a publisher): only an already-registered worker, only while no override exists', () => {
    const test = fresh(); // init never ran
    expect(test.db.module_config.count()).toBe(0n);
    expect(() => setHash(test, bob, PROD)).toThrow('not allowed'); // a stranger
    registerWith(test, alice, 'keystone-dev-secret'); // alice becomes a worker (dev secret accepted: no override yet)
    registerWith(test, worker, 'keystone-dev-secret');
    setHash(test, alice, PROD); // first override: allowed, and alice is recorded as the admin
    expect(test.db.module_config.id.find(1)!.publisher!.toHexString()).toBe(idOf(test, alice)); // the first adopter is recorded
    expect(() => registerWith(test, bob, 'keystone-dev-secret')).toThrow('invalid worker secret');
    expect(() => setHash(test, worker, sha256('hijack'))).toThrow('not allowed'); // another worker cannot take over
    expect(() => setHash(test, bob, sha256('hijack'))).toThrow('not allowed');
    setHash(test, alice, sha256('rotated')); // the recorded admin can rotate
    registerWith(test, bob, 'rotated');
  });
});

// ---- family voting (docs/contracts.md section 6) --------------------------------------------------------------------
describe('family voting', () => {
  const DAY = 86_400_000;
  const create = (test: ReturnType<typeof fresh>, over: Partial<{ title: string; amount: number; details_json: string; closes_in_days: number; author_name: string; household_id: string }> = {}) => {
    test.withReducerTx(alice, (ctx) =>
      m.create_proposal(ctx, { household_id: 'hh_demo', title: 'Buy a reliable used car', amount: 14000, details_json: '{"down_pct":10,"term_months":60,"rate_pct":12.5}', closes_in_days: 7, author_name: 'Ana', ...over }),
    );
    const all = [...test.db.proposal.iter()];
    return all[all.length - 1]!;
  };
  const vote = (test: ReturnType<typeof fresh>, auth: ReturnType<typeof who>, id: string, choice: string, name = '') =>
    test.withReducerTx(auth, (ctx) => m.cast_vote(ctx, { proposal_id: id, choice, voter_name: name }));

  it('create_proposal inserts an open proposal and queues exactly one what_if job carrying it', () => {
    const test = seeded();
    const p = create(test);
    expect(p.id).toMatch(/^prop_[0-9a-z]+$/);
    expect(p).toMatchObject({ household_id: 'hh_demo', title: 'Buy a reliable used car', amount: 14000, status: 'open', verdict: '', analysis_json: '', run_id: '', created_by_name: 'Ana' });
    expect(JSON.parse(p.details_json)).toEqual({ down_pct: 10, term_months: 60, rate_pct: 12.5 });
    expect(Number(p.closes_at.microsSinceUnixEpoch - p.created_at.microsSinceUnixEpoch) / 1000).toBe(7 * DAY);
    const jobs = [...test.db.agent_job.iter()].filter((j) => j.workflow === 'what_if');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ household_id: 'hh_demo', subject_id: p.id, status: 'queued' });
    const input = JSON.parse(jobs[0]!.input_json);
    expect(input).toMatchObject({ proposal_id: p.id, title: 'Buy a reliable used car', amount: 14000, details: { down_pct: 10 }, created_by: 'Ana' });
  });

  it('create_proposal validates its input and fills in the author from presence when blank', () => {
    const test = seeded();
    const bad = (over: Parameters<typeof create>[1]) => () => create(test, over);
    expect(bad({ household_id: 'hh_nope' })).toThrow('unknown household');
    expect(bad({ title: '   ' })).toThrow('title must not be empty');
    expect(bad({ title: 'x'.repeat(141) })).toThrow('too long');
    expect(bad({ amount: -1 })).toThrow('amount');
    expect(bad({ amount: Number.NaN })).toThrow('amount');
    expect(bad({ closes_in_days: 0 })).toThrow('closes_in_days');
    expect(bad({ closes_in_days: 91 })).toThrow('closes_in_days');
    expect(bad({ details_json: '[1,2]' })).toThrow('JSON object');
    expect(bad({ details_json: '{nope' })).toThrow('JSON object');
    expect(test.db.proposal.count()).toBe(0n);
    expect([...test.db.agent_job.iter()]).toHaveLength(0);
    test.withReducerTx(alice, (ctx) => m.join_room(ctx, { household_id: 'hh_demo', display_name: 'Ana Demo', role: 'family' }));
    const p = create(test, { author_name: '', details_json: '', amount: 0, closes_in_days: 0.5 });
    expect(p.created_by_name).toBe('Ana Demo');
    expect(p.details_json).toBe('{}');
    expect(Number(p.closes_at.microsSinceUnixEpoch - p.created_at.microsSinceUnixEpoch) / 1000).toBe(DAY / 2);
  });

  it('cast_vote: one vote per identity, changeable until closed, keyed by the caller identity', () => {
    const test = seeded();
    const p = create(test);
    vote(test, alice, p.id, 'yes', 'Ana');
    vote(test, bob, p.id, 'no', 'Ben');
    expect(test.db.vote.count()).toBe(2n);
    vote(test, alice, p.id, 'no', 'Ana'); // changes the vote, does not add one
    expect(test.db.vote.count()).toBe(2n);
    const mine = [...test.db.vote.proposal_id.filter(p.id)].find((v) => v.voter_name === 'Ana')!;
    expect(mine.choice).toBe('no');
    expect(mine.household_id).toBe('hh_demo');
    expect(mine.id).toBe(`${p.id}:${mine.voter_key}`);
    expect(mine.voter_key).toMatch(/^[0-9a-f]{64}$/);
    vote(test, alice, p.id, 'abstain'); // blank name falls back to the caller's name
    expect([...test.db.vote.proposal_id.filter(p.id)].filter((v) => v.choice === 'abstain')).toHaveLength(1);
    expect(() => vote(test, alice, p.id, 'maybe')).toThrow('choice must be one of');
    expect(() => vote(test, alice, 'prop_nope', 'yes')).toThrow('unknown proposal');
    expect(() => vote(test, alice, p.id, 'yes', 'x'.repeat(41))).toThrow('too long');
  });

  it('closing: close_proposal is idempotent, and nobody can vote or change a vote afterwards', () => {
    const test = seeded();
    const p = create(test);
    vote(test, alice, p.id, 'yes', 'Ana');
    test.withReducerTx(bob, (ctx) => m.close_proposal(ctx, { proposal_id: p.id }));
    test.withReducerTx(bob, (ctx) => m.close_proposal(ctx, { proposal_id: p.id }));
    expect(test.db.proposal.id.find(p.id)!.status).toBe('closed');
    expect(() => vote(test, bob, p.id, 'no', 'Ben')).toThrow('closed');
    expect(() => vote(test, alice, p.id, 'no', 'Ana')).toThrow('closed');
    expect([...test.db.vote.iter()].map((v) => v.choice)).toEqual(['yes']);
    expect(() => test.withReducerTx(bob, (ctx) => m.close_proposal(ctx, { proposal_id: 'prop_nope' }))).toThrow('unknown proposal');
  });

  it('a proposal past its deadline rejects votes immediately and is closed by the 60 s tick', () => {
    const test = seeded();
    const p = create(test, { closes_in_days: 1 });
    vote(test, alice, p.id, 'yes', 'Ana');
    test.clock.advance(TimeDuration.fromMillis(DAY + 1000));
    expect(test.db.proposal.id.find(p.id)!.status).toBe('open'); // nothing flipped it yet...
    expect(() => vote(test, bob, p.id, 'no', 'Ben')).toThrow('closed'); // ...but voting is already shut
    test.withReducerTx(TestAuth.internal(), (ctx) => m.tick_recompute(ctx, { arg: { scheduled_id: 1n, scheduled_at: ScheduleAt.interval(60_000_000n) } }));
    expect(test.db.proposal.id.find(p.id)!.status).toBe('closed');
    // a still-open proposal is left alone
    const q = create(test, { title: 'Family trip', closes_in_days: 30 });
    test.withReducerTx(TestAuth.internal(), (ctx) => m.tick_recompute(ctx, { arg: { scheduled_id: 1n, scheduled_at: ScheduleAt.interval(60_000_000n) } }));
    expect(test.db.proposal.id.find(q.id)!.status).toBe('open');
  });

  it('agent_update_proposal: worker only, validated, and still allowed after voting closed', () => {
    const test = seeded();
    const p = create(test);
    const analysis = JSON.stringify({ summary: 'Tight but doable.', metrics: [], suggestion: 'Raise the down payment.' });
    expect(() => test.withReducerTx(alice, (ctx) => m.agent_update_proposal(ctx, { proposal_id: p.id, verdict: 'fine', analysis_json: analysis, run_id: 'run_1' }))).toThrow('worker only');
    expect(() => test.withReducerTx(worker, (ctx) => m.agent_update_proposal(ctx, { proposal_id: p.id, verdict: 'great', analysis_json: analysis, run_id: 'run_1' }))).toThrow('verdict must be one of');
    expect(() => test.withReducerTx(worker, (ctx) => m.agent_update_proposal(ctx, { proposal_id: p.id, verdict: 'fine', analysis_json: '{oops', run_id: 'run_1' }))).toThrow('valid JSON');
    expect(() => test.withReducerTx(worker, (ctx) => m.agent_update_proposal(ctx, { proposal_id: 'prop_nope', verdict: 'fine', analysis_json: analysis, run_id: 'run_1' }))).toThrow('unknown proposal');
    test.withReducerTx(worker, (ctx) => m.agent_update_proposal(ctx, { proposal_id: p.id, verdict: 'tight', analysis_json: analysis, run_id: 'run_1' }));
    expect(test.db.proposal.id.find(p.id)).toMatchObject({ verdict: 'tight', analysis_json: analysis, run_id: 'run_1', status: 'open', title: 'Buy a reliable used car' });
    test.withReducerTx(alice, (ctx) => m.close_proposal(ctx, { proposal_id: p.id }));
    test.withReducerTx(worker, (ctx) => m.agent_update_proposal(ctx, { proposal_id: p.id, verdict: 'risky', analysis_json: analysis, run_id: 'run_2' }));
    expect(test.db.proposal.id.find(p.id)).toMatchObject({ verdict: 'risky', run_id: 'run_2', status: 'closed' });
  });

  it('the full loop: create -> job -> worker claims -> agent_update_proposal -> votes', () => {
    const test = seeded();
    const p = create(test);
    const job = [...test.db.agent_job.iter()].find((j) => j.subject_id === p.id)!;
    test.withReducerTx(worker, (ctx) => m.claim_job(ctx, { job_id: job.id }));
    test.withReducerTx(worker, (ctx) => m.start_run(ctx, { run_id: 'run_p', job_id: job.id }));
    test.withReducerTx(worker, (ctx) => m.agent_update_proposal(ctx, { proposal_id: p.id, verdict: 'risky', analysis_json: '{"summary":"x"}', run_id: 'run_p' }));
    test.withReducerTx(worker, (ctx) => m.finish_run(ctx, { run_id: 'run_p', status: 'done', providers_json: '[]', result_json: '{}' }));
    vote(test, alice, p.id, 'no', 'Ana');
    expect(test.db.proposal.id.find(p.id)!.verdict).toBe('risky');
    expect(test.db.agent_job.id.find(job.id)!.status).toBe('done');
  });

  const seedRows = [
    { id: 'prop_seed_1', household_id: 'hh_demo', title: 'Take the loan', amount: 250000, details: { kind: 'loan', term_months: 120 }, created_by_name: 'Ana', created_at: '2026-11-06T18:00:00Z', closes_at: '2026-11-20T18:00:00Z', status: 'open' },
    { id: 'prop_seed_2', household_id: 'hh_demo', title: 'Already checked', amount: 100, details_json: '{}', created_by_name: 'Ben', created_at: '2026-11-06T18:00:00Z', closes_in_days: 3, status: 'open', verdict: 'fine', analysis: { summary: 'ok' } },
  ];
  const seedVotes = [
    { proposal_id: 'prop_seed_1', voter_key: 'mem_a', voter_name: 'Ana', choice: 'yes', updated_at: '2026-11-06T19:00:00Z' },
    { proposal_id: 'prop_seed_1', voter_key: 'mem_b', voter_name: 'Ben', choice: 'abstain' },
  ];

  it('seed_proposals / seed_votes load rows, derive ids, skip existing, and queue a check only for rows without a verdict', () => {
    const test = seeded();
    const j = JSON.stringify;
    test.withReducerTx(worker, (ctx) => m.seed_proposals(ctx, { rows_json: j(seedRows) }));
    test.withReducerTx(worker, (ctx) => m.seed_votes(ctx, { rows_json: j(seedVotes) }));
    expect(test.db.proposal.count()).toBe(2n);
    const p1 = test.db.proposal.id.find('prop_seed_1')!;
    expect(p1.closes_at.toDate().toISOString()).toBe('2026-11-20T18:00:00.000Z');
    expect(JSON.parse(p1.details_json)).toEqual({ kind: 'loan', term_months: 120 });
    const p2 = test.db.proposal.id.find('prop_seed_2')!;
    expect(p2.verdict).toBe('fine');
    expect(JSON.parse(p2.analysis_json)).toEqual({ summary: 'ok' });
    expect(p2.closes_at.toDate().toISOString()).toBe('2026-11-09T18:00:00.000Z'); // created_at + closes_in_days
    expect(test.db.vote.id.find('prop_seed_1:mem_a')).toMatchObject({ household_id: 'hh_demo', voter_name: 'Ana', choice: 'yes', voter_key: 'mem_a' });
    expect(test.db.vote.id.find('prop_seed_1:mem_b')!.updated_at.microsSinceUnixEpoch).toBe(NOW.microsSinceUnixEpoch);
    // one check queued, for the proposal that has no verdict
    const jobs = [...test.db.agent_job.iter()].filter((x) => x.workflow === 'what_if');
    expect(jobs.map((x) => x.subject_id)).toEqual(['prop_seed_1']);
    // idempotent: re-seeding changes and queues nothing
    test.withReducerTx(worker, (ctx) => m.seed_proposals(ctx, { rows_json: j(seedRows) }));
    test.withReducerTx(worker, (ctx) => m.seed_votes(ctx, { rows_json: j(seedVotes) }));
    expect(test.db.proposal.count()).toBe(2n);
    expect(test.db.vote.count()).toBe(2n);
    expect([...test.db.agent_job.iter()].filter((x) => x.workflow === 'what_if')).toHaveLength(1);
  });

  it('seed reducers reject bad rows loudly', () => {
    const test = seeded();
    const j = JSON.stringify;
    const call = (fn: 'seed_proposals' | 'seed_votes', rows: unknown[]) => () => test.withReducerTx(worker, (ctx) => m[fn](ctx, { rows_json: j(rows) }));
    expect(call('seed_proposals', [{ ...seedRows[0], household_id: 'hh_nope' }])).toThrow('unknown household');
    expect(call('seed_proposals', [{ ...seedRows[0], status: 'maybe' }])).toThrow('status');
    expect(call('seed_proposals', [{ ...seedRows[0], created_at: 'yesterday-ish' }])).toThrow('ISO date');
    expect(call('seed_proposals', [{ ...seedRows[0], details: [1] }])).toThrow('JSON object');
    expect(call('seed_votes', [seedVotes[0]])).toThrow('seed_proposals first');
    test.withReducerTx(worker, (ctx) => m.seed_proposals(ctx, { rows_json: j(seedRows) }));
    expect(call('seed_votes', [{ ...seedVotes[0], voter_key: 'mem_c', choice: 'sure' }])).toThrow('choice');
  });

  it('create_sandbox copies proposals and seeded member votes with remapped ids; delete_sandbox removes them', () => {
    const test = seeded();
    const j = JSON.stringify;
    test.withReducerTx(worker, (ctx) => m.seed_proposals(ctx, { rows_json: j(seedRows) }));
    test.withReducerTx(worker, (ctx) => m.seed_votes(ctx, { rows_json: j(seedVotes) }));
    test.withReducerTx(worker, (ctx) => m.agent_update_proposal(ctx, { proposal_id: 'prop_seed_1', verdict: 'tight', analysis_json: '{"summary":"s"}', run_id: 'run_template' }));
    const p1 = create(test, { title: 'Live proposal from a judge' }); // a real proposal with a real identity vote on the template
    vote(test, bob, p1.id, 'yes', 'Bob');
    test.clock.advance(TimeDuration.fromMillis(2 * DAY)); // the sandbox is created two days later
    test.withReducerTx(alice, (ctx) => m.create_sandbox(ctx, { template_household_id: 'hh_demo', display_name: 'Judge Judy' }));
    const sbx = [...test.db.household.iter()].find((h) => h.id.startsWith('hh_sbx_'))!;
    const suffix = sbx.id.slice('hh_sbx_'.length);
    const props = [...test.db.proposal.household_id.filter(sbx.id)];
    expect(props).toHaveLength(3);
    for (const p of props) expect(p.id.endsWith(`__${suffix}`)).toBe(true);
    // the template is untouched
    expect([...test.db.proposal.household_id.filter('hh_demo')]).toHaveLength(3);
    expect(test.db.proposal.id.find('prop_seed_1')!.run_id).toBe('run_template');

    const copy = test.db.proposal.id.find(`prop_seed_1__${suffix}`)!;
    expect(copy).toMatchObject({ title: 'Take the loan', amount: 250000, verdict: 'tight', run_id: '', status: 'open' });
    expect(JSON.parse(copy.analysis_json)).toEqual({ summary: 's' });
    // fresh voting window of the same length (14 days), starting now
    expect(copy.created_at.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch);
    expect(Number(copy.closes_at.microsSinceUnixEpoch - copy.created_at.microsSinceUnixEpoch) / 1000).toBe(14 * DAY);
    // seeded member votes: remapped proposal id and member id; identity votes stay in the template
    const copied = [...test.db.vote.household_id.filter(sbx.id)];
    expect(copied.map((v) => v.id).sort()).toEqual([`prop_seed_1__${suffix}:mem_a__${suffix}`, `prop_seed_1__${suffix}:mem_b__${suffix}`]);
    const memberIds = new Set([...test.db.member.household_id.filter(sbx.id)].map((x) => x.id));
    for (const v of copied) {
      expect(memberIds.has(v.voter_key)).toBe(true);
      expect(v.proposal_id).toBe(`prop_seed_1__${suffix}`);
    }
    expect(test.db.vote.id.find(`${p1.id}:${[...test.db.vote.proposal_id.filter(p1.id)][0]!.voter_key}`)).toBeTruthy();
    expect([...test.db.vote.household_id.filter(sbx.id)].some((v) => v.proposal_id.startsWith(p1.id))).toBe(false);
    // the sandbox owner can vote on the copy at once
    vote(test, alice, copy.id, 'yes', 'Judy');
    // a copy that still has no verdict gets its check queued (the live proposal was never analysed)
    const queued = [...test.db.agent_job.iter()].filter((x) => x.household_id === sbx.id && x.workflow === 'what_if');
    expect(queued.map((x) => x.subject_id).sort()).toEqual([`${p1.id}__${suffix}`]);
    expect(JSON.parse(queued[0]!.input_json).proposal_id).toBe(`${p1.id}__${suffix}`);

    test.withReducerTx(alice, (ctx) => m.delete_sandbox(ctx, { household_id: sbx.id }));
    expect([...test.db.proposal.household_id.filter(sbx.id)]).toHaveLength(0);
    expect([...test.db.vote.household_id.filter(sbx.id)]).toHaveLength(0);
    expect([...test.db.proposal.household_id.filter('hh_demo')]).toHaveLength(3);
  });
});

// ---- onboarding (docs/contracts.md section 7) -----------------------------------------------------------------------
describe('onboarding', () => {
  const j = JSON.stringify;
  const start = (test: ReturnType<typeof fresh>, auth = alice, hhName = 'The Whitfields', who_ = 'Dana') => {
    test.withReducerTx(auth, (ctx) => m.start_onboarding(ctx, { household_name: hhName, display_name: who_ }));
    const all = [...test.db.household.iter()].filter((h) => h.id.startsWith('hh_onb_'));
    return all[all.length - 1]!;
  };
  const options = [
    { account_id: 'acc_chk', name: 'Plaid Checking', official_name: 'Plaid Gold Standard 0% Interest Checking', mask: '0000', type: 'depository', subtype: 'checking', balance: 4200.5 },
    { account_id: 'acc_sav', name: 'Plaid Saving', official_name: '', mask: '1111', type: 'depository', subtype: 'savings', balance: 9000 },
    { account_id: 'acc_card', name: 'Plaid Credit Card', official_name: '', mask: '3333', type: 'credit', subtype: 'credit card', balance: 410 },
  ];
  /** A household with a linked bank whose accounts were offered by the worker. */
  function linked() {
    const test = seeded();
    const hh = start(test);
    test.withReducerTx(worker, (ctx) => m.agent_save_plaid_item(ctx, { item_id: 'item_1', household_id: hh.id, access_token: 'access-sandbox-xyz', institution_id: 'ins_109508', institution_name: 'First Platypus Bank', cursor: '' }));
    test.withReducerTx(worker, (ctx) => m.agent_set_account_options(ctx, { household_id: hh.id, item_id: 'item_1', rows_json: j(options) }));
    return { test, hh };
  }
  const profile = (test: ReturnType<typeof fresh>, hh: string) => test.db.household_profile.household_id.find(hh)!;
  const conn = (test: ReturnType<typeof fresh>) => test.db.bank_connection.item_id.find('item_1')!;

  it('start_onboarding creates an owned household, the caller as a member, a profile in "connect", and moves presence', () => {
    const test = seeded();
    test.withReducerTx(alice, (ctx) => m.onConnect(ctx, {}));
    const hh = start(test);
    expect(hh.id).toMatch(/^hh_onb_[0-9a-z]{6}$/);
    expect(hh).toMatchObject({ name: 'The Whitfields', template_id: '', home_value: 0, vehicle_value: 0 });
    expect(hh.owner!.toHexString()).toBe(test.withReducerTx(alice, (ctx) => ctx.sender.toHexString()));
    const members = [...test.db.member.household_id.filter(hh.id)];
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ name: 'Dana', role: 'parent' });
    expect(profile(test, hh.id)).toMatchObject({ onboarding_status: 'connect', risk_comfort: 3, voting_enabled: true, voice_consent: false, priorities_json: '[]' });
    const p = [...test.db.presence.iter()][0]!;
    expect(p).toMatchObject({ household_id: hh.id, display_name: 'Dana', role: 'family' });
    // a second one gets another id; blanks are rejected
    expect(start(test, bob, 'Another family', 'Ben').id).not.toBe(hh.id);
    expect(() => start(test, alice, '  ', 'Dana')).toThrow('household_name must not be empty');
    expect(() => start(test, alice, 'X', '')).toThrow('display_name must not be empty');
  });

  it('agent_set_account_options is worker-only, stores the offered accounts (selected by default) and moves the statuses to "selecting"', () => {
    const { test, hh } = linked();
    expect(() => test.withReducerTx(alice, (ctx) => m.agent_set_account_options(ctx, { household_id: hh.id, item_id: 'item_1', rows_json: '[]' }))).toThrow('worker only');
    const rows = [...test.db.bank_account_option.household_id.filter(hh.id)];
    expect(rows.map((r) => r.id).sort()).toEqual(['item_1:acc_card', 'item_1:acc_chk', 'item_1:acc_sav']);
    expect(rows.every((r) => r.selected)).toBe(true);
    expect(test.db.bank_account_option.id.find('item_1:acc_chk')).toMatchObject({ name: 'Plaid Checking', mask: '0000', type: 'depository', subtype: 'checking', balance: 4200.5, item_id: 'item_1', account_id: 'acc_chk' });
    expect(conn(test)).toMatchObject({ status: 'selecting', accounts_count: 3 });
    expect(profile(test, hh.id).onboarding_status).toBe('selecting');
    // the access token never reaches a public table
    expect(JSON.stringify(rows)).not.toContain('access-sandbox');
    // bad rows
    expect(() => test.withReducerTx(worker, (ctx) => m.agent_set_account_options(ctx, { household_id: hh.id, item_id: 'item_1', rows_json: '{}' }))).toThrow('JSON array');
    expect(() => test.withReducerTx(worker, (ctx) => m.agent_set_account_options(ctx, { household_id: hh.id, item_id: 'item_1', rows_json: j([{ name: 'x' }]) }))).toThrow('account_id');
    expect(() => test.withReducerTx(worker, (ctx) => m.agent_set_account_options(ctx, { household_id: 'hh_nope', item_id: 'item_1', rows_json: '[]' }))).toThrow('unknown household');
  });

  it('select_bank_accounts marks the choice, queues exactly one plaid_sync, sets syncing and moves the profile to "questions"', () => {
    const { test, hh } = linked();
    const call = (ids: unknown, h = hh.id, item = 'item_1') => test.withReducerTx(alice, (ctx) => m.select_bank_accounts(ctx, { household_id: h, item_id: item, account_ids_json: j(ids) }));
    expect(() => call([], hh.id)).toThrow('at least one');
    expect(() => call(['acc_nope'])).toThrow('unknown account');
    expect(() => call([42])).toThrow('array of account id strings');
    expect(() => call(['acc_chk'], hh.id, 'item_x')).toThrow('no accounts were offered');
    expect(() => test.withReducerTx(alice, (ctx) => m.select_bank_accounts(ctx, { household_id: hh.id, item_id: 'item_1', account_ids_json: 'nope' }))).toThrow('JSON array');
    call(['acc_chk', 'acc_card']);
    expect([...test.db.bank_account_option.household_id.filter(hh.id)].map((r) => [r.account_id, r.selected]).sort()).toEqual([['acc_card', true], ['acc_chk', true], ['acc_sav', false]]);
    expect(conn(test).status).toBe('syncing');
    expect(profile(test, hh.id).onboarding_status).toBe('questions');
    const jobs = [...test.db.agent_job.iter()].filter((x) => x.workflow === 'plaid_sync' && x.household_id === hh.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('queued');
    call(['acc_chk']); // changing the choice while the job still waits does not queue a second one
    expect([...test.db.agent_job.iter()].filter((x) => x.workflow === 'plaid_sync' && x.household_id === hh.id)).toHaveLength(1);
    expect(test.db.bank_account_option.id.find('item_1:acc_card')!.selected).toBe(false);
  });

  it('adding an account that was not selected before restarts the transaction cursor; keeping the same set does not', () => {
    const { test, hh } = linked();
    const call = (ids: string[]) => test.withReducerTx(alice, (ctx) => m.select_bank_accounts(ctx, { household_id: hh.id, item_id: 'item_1', account_ids_json: j(ids) }));
    call(['acc_chk']);
    test.withReducerTx(worker, (ctx) => m.agent_save_plaid_item(ctx, { item_id: 'item_1', household_id: hh.id, access_token: '', institution_id: '', institution_name: '', cursor: 'cur_5' }));
    call(['acc_chk']);
    expect(test.db.plaid_item.item_id.find('item_1')!.cursor).toBe('cur_5');
    call(['acc_chk', 'acc_sav']);
    expect(test.db.plaid_item.item_id.find('item_1')!.cursor).toBe('');
    expect(test.db.plaid_item.item_id.find('item_1')!.access_token).toBe('access-sandbox-xyz'); // token untouched
  });

  it('a refresh of the offered accounts keeps earlier choices, adds new accounts as selected and drops vanished ones', () => {
    const { test, hh } = linked();
    test.withReducerTx(alice, (ctx) => m.select_bank_accounts(ctx, { household_id: hh.id, item_id: 'item_1', account_ids_json: j(['acc_chk']) }));
    test.withReducerTx(worker, (ctx) => m.agent_set_account_options(ctx, { household_id: hh.id, item_id: 'item_1', rows_json: j([options[0], options[1], { account_id: 'acc_new', name: 'New', type: 'depository', subtype: 'cd', balance: 1 }]) }));
    const rows = new Map([...test.db.bank_account_option.household_id.filter(hh.id)].map((r) => [r.account_id, r.selected]));
    expect([...rows.entries()].sort()).toEqual([['acc_chk', true], ['acc_new', true], ['acc_sav', false]]);
    expect(profile(test, hh.id).onboarding_status).toBe('questions'); // never moves backwards
  });

  it('save_onboarding_answers upserts members, housing, goals and the profile, and is safe to repeat', () => {
    const { test, hh } = linked();
    const answers = {
      members: [
        { name: 'Dana', role: 'parent', age: 39, income_annual: 82000 },
        { name: 'Sam', role: 'parent', age: 41, income_annual: 64000 },
        { name: 'Kit', role: 'child', age: 9, income_annual: 0 },
        { name: 'Grandpa Joe', role: 'aunt', age: 71, income_annual: 18000 },
      ],
      own_home: true,
      home_value: 355000,
      vehicle_value: 31000,
      priorities: ['Emergency fund', 'college', 'travel'],
      goal_text: 'Replace the roof by spring',
      risk_comfort: 2,
      voting_enabled: false,
      voice_consent: true,
    };
    const save = (a: unknown, h = hh.id, auth = alice) => test.withReducerTx(auth, (ctx) => m.save_onboarding_answers(ctx, { household_id: h, answers_json: typeof a === 'string' ? a : j(a) }));
    save(answers);
    const members = [...test.db.member.household_id.filter(hh.id)];
    expect(members.map((x) => x.name).sort()).toEqual(['Dana', 'Grandpa Joe', 'Kit', 'Sam']);
    expect(members.find((x) => x.name === 'Dana')).toMatchObject({ age: 39, income_annual: 82000, id: `mem_onb_${hh.id.slice('hh_onb_'.length)}_1` }); // the caller's own row was updated, not duplicated
    expect(members.find((x) => x.name === 'Grandpa Joe')!.role).toBe('other'); // unknown role
    expect(new Set(members.map((x) => x.id)).size).toBe(4);
    expect(test.db.household.id.find(hh.id)).toMatchObject({ home_value: 355000, vehicle_value: 31000 });
    const goals = [...test.db.goal.household_id.filter(hh.id)].sort((a, b) => a.priority - b.priority);
    expect(goals.map((g) => [g.id, g.title, g.priority, g.source, g.target_amount])).toEqual([
      [`goal_${hh.id}_emergency_fund`, 'Build an emergency fund', 1, 'onboarding', 0],
      [`goal_${hh.id}_college`, 'Save for college', 2, 'onboarding', 0],
      [`goal_${hh.id}_travel`, 'Save for travel', 3, 'onboarding', 0],
      [`goal_${hh.id}_custom`, 'Replace the roof by spring', 4, 'onboarding', 0],
    ]);
    expect(profile(test, hh.id)).toMatchObject({ onboarding_status: 'questions', risk_comfort: 2, voting_enabled: false, voice_consent: true });
    expect(JSON.parse(profile(test, hh.id).priorities_json)).toEqual(['emergency_fund', 'college', 'travel']);
    expect(JSON.parse(profile(test, hh.id).answers_json).goal_text).toBe('Replace the roof by spring');

    // repeat: same rows; an agent-filled goal keeps its verdict; a dropped priority disappears; renting zeroes the home value
    test.withReducerTx(worker, (ctx) => m.agent_upsert_goal(ctx, { id: `goal_${hh.id}_college`, household_id: hh.id, title: 'Save for college', target_amount: 60000, target_date: '2031-08-01', priority: 2, feasibility: 'stretch', evidence_quote: '', source: 'onboarding' }));
    save({ ...answers, priorities: ['college', 'emergency_fund'], own_home: false, goal_text: '' });
    expect([...test.db.member.household_id.filter(hh.id)]).toHaveLength(4);
    const again = [...test.db.goal.household_id.filter(hh.id)].sort((a, b) => a.priority - b.priority);
    expect(again.map((g) => g.id)).toEqual([`goal_${hh.id}_college`, `goal_${hh.id}_emergency_fund`]);
    expect(again[0]).toMatchObject({ priority: 1, feasibility: 'stretch', target_amount: 60000 });
    expect(test.db.household.id.find(hh.id)!.home_value).toBe(0);
    // another household's rows are untouched
    expect([...test.db.goal.household_id.filter('hh_demo')]).toHaveLength(0);
  });

  it('save_onboarding_answers rejects bad answers and non-onboarding households', () => {
    const { test, hh } = linked();
    const save = (a: unknown, h = hh.id) => () => test.withReducerTx(alice, (ctx) => m.save_onboarding_answers(ctx, { household_id: h, answers_json: typeof a === 'string' ? a : j(a) }));
    expect(save('[1]')).toThrow('JSON object');
    expect(save('{nope')).toThrow('JSON object');
    expect(save({ priorities: ['yachts'] })).toThrow('unknown priority');
    expect(save({ risk_comfort: 9 })).toThrow('risk_comfort');
    expect(save({ members: 'Dana' })).toThrow('members must be an array');
    expect(save({ members: [{ name: '' }] })).toThrow('name must not be empty');
    expect(save({ members: [{ name: 'A', age: 400 }] })).toThrow('age');
    expect(save({ members: [{ name: 'A', income_annual: -5 }] })).toThrow('income_annual');
    expect(save({ vehicle_value: 'lots' })).toThrow('vehicle_value');
    expect(save({ members: Array.from({ length: 13 }, (_, i) => ({ name: `P${i}` })) })).toThrow('at most 12');
    expect(save({ goal_text: 'x'.repeat(141) })).toThrow('too long');
    expect(save({}, 'hh_demo')).toThrow('not an onboarding household');
    expect(save({}, 'hh_nope')).toThrow('unknown household');
    expect([...test.db.member.household_id.filter(hh.id)]).toHaveLength(1); // nothing half-applied
  });

  it('finish_onboarding waits for the bank, recomputes, marks done and queues one onboarding_insights job with the answers', () => {
    const { test, hh } = linked();
    const finish = (h = hh.id) => test.withReducerTx(alice, (ctx) => m.finish_onboarding(ctx, { household_id: h }));
    expect(() => finish()).toThrow('choose which accounts');
    test.withReducerTx(alice, (ctx) => m.select_bank_accounts(ctx, { household_id: hh.id, item_id: 'item_1', account_ids_json: j(['acc_chk', 'acc_sav']) }));
    expect(() => finish()).toThrow('still running');
    test.withReducerTx(alice, (ctx) => m.save_onboarding_answers(ctx, { household_id: hh.id, answers_json: j({ priorities: ['home'], risk_comfort: 4, voting_enabled: true }) }));
    test.withReducerTx(worker, (ctx) => m.agent_set_bank_connection(ctx, { item_id: 'item_1', household_id: hh.id, institution_name: '', status: 'ok', accounts_count: 2, txns_count: 0, error: '' }));
    expect(test.db.health_indicator.household_id.filter(hh.id)[Symbol.iterator]().next().done).toBe(true);
    finish();
    expect(profile(test, hh.id).onboarding_status).toBe('done');
    expect([...test.db.health_indicator.household_id.filter(hh.id)].length).toBeGreaterThan(5); // recompute ran
    const jobs = [...test.db.agent_job.iter()].filter((x) => x.workflow === 'onboarding_insights');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ household_id: hh.id, subject_id: hh.id, status: 'queued' });
    const input = JSON.parse(jobs[0]!.input_json);
    expect(input).toMatchObject({ household_id: hh.id, priorities: ['home'], risk_comfort: 4, voting_enabled: true, finished_by: 'Dana' });
    expect(input.answers.priorities).toEqual(['home']);
    finish(); // idempotent
    expect([...test.db.agent_job.iter()].filter((x) => x.workflow === 'onboarding_insights')).toHaveLength(1);
    expect(() => finish('hh_demo')).toThrow('not an onboarding household');
  });

  it('a household can finish onboarding without ever linking a bank', () => {
    const test = seeded();
    const hh = start(test);
    test.withReducerTx(alice, (ctx) => m.finish_onboarding(ctx, { household_id: hh.id }));
    expect(profile(test, hh.id).onboarding_status).toBe('done');
    expect([...test.db.agent_job.iter()].filter((x) => x.workflow === 'onboarding_insights')).toHaveLength(1);
  });

  it('the worker may write insight alerts and onboarding goals; "selecting" is a valid connection status', () => {
    const { test, hh } = linked();
    test.withReducerTx(worker, (ctx) => m.agent_create_alert(ctx, { id: 'agent:ins:1', household_id: hh.id, severity: 'info', kind: 'insight', title: 'You keep 4 months of spending in cash', detail: 'Good cushion.', related_ids_json: '[]' }));
    expect(test.db.alert.id.find('agent:ins:1')!.kind).toBe('insight');
    expect(() => test.withReducerTx(worker, (ctx) => m.agent_create_alert(ctx, { id: 'agent:ins:2', household_id: hh.id, severity: 'info', kind: 'gossip', title: 't', detail: '', related_ids_json: '[]' }))).toThrow('kind must be one of');
    test.withReducerTx(worker, (ctx) => m.agent_upsert_goal(ctx, { id: '', household_id: hh.id, title: 'g', target_amount: 1, target_date: '', priority: 1, feasibility: '', evidence_quote: '', source: 'onboarding' }));
    test.withReducerTx(worker, (ctx) => m.agent_set_bank_connection(ctx, { item_id: 'item_1', household_id: hh.id, institution_name: '', status: 'selecting', accounts_count: 3, txns_count: 0, error: '' }));
    expect(conn(test).status).toBe('selecting');
  });

  it('the owner can delete an onboarding household with everything attached; strangers and real households are refused', () => {
    const { test, hh } = linked();
    test.withReducerTx(alice, (ctx) => m.save_onboarding_answers(ctx, { household_id: hh.id, answers_json: j({ priorities: ['home'], members: [{ name: 'Sam', role: 'parent', age: 40 }] }) }));
    expect(() => test.withReducerTx(bob, (ctx) => m.delete_sandbox(ctx, { household_id: hh.id }))).toThrow('only the sandbox owner');
    expect(() => test.withReducerTx(alice, (ctx) => m.delete_sandbox(ctx, { household_id: 'hh_demo' }))).toThrow('only sandboxes and onboarding households');
    test.withReducerTx(alice, (ctx) => m.delete_sandbox(ctx, { household_id: hh.id }));
    expect(test.db.household.id.find(hh.id)).toBeFalsy();
    expect(test.db.household_profile.household_id.find(hh.id)).toBeFalsy();
    expect([...test.db.bank_account_option.household_id.filter(hh.id)]).toHaveLength(0);
    expect([...test.db.member.household_id.filter(hh.id)]).toHaveLength(0);
    expect([...test.db.goal.household_id.filter(hh.id)]).toHaveLength(0);
    expect(test.db.bank_connection.count()).toBe(0n);
    expect(test.db.plaid_item.count()).toBe(0n);
    expect(test.db.household.id.find('hh_demo')).toBeTruthy();
  });

  it('recompute works on a household with no data yet', () => {
    const test = seeded();
    const hh = start(test);
    test.withReducerTx(alice, (ctx) => m.recompute_household(ctx, { household_id: hh.id }));
    expect([...test.db.forecast_point.household_id.filter(hh.id)]).toHaveLength(90);
  });
});

describe('kids: chores and the savings jar', () => {
  it('pays a chore once, only after the kid finished and a parent approved, then redeems the goal', () => {
    const test = seeded();
    const call = <A extends object>(fn: (ctx: never, a: A) => void, a: A) => test.withReducerTx(alice, (ctx) => fn(ctx as never, a));
    call(m.add_kid_task, { household_id: 'hh_demo', member_id: 'mem_b', title: 'Dishes', reward: 3, author_name: 'Ana' });
    const task = [...test.db.kid_task.household_id.filter('hh_demo')][0]!;
    expect(task.status).toBe('open');
    call(m.approve_kid_task, { task_id: task.id }); // not finished yet: no pay
    expect(test.db.kid_jar.member_id.find('mem_b')).toBeFalsy();
    call(m.complete_kid_task, { task_id: task.id });
    call(m.approve_kid_task, { task_id: task.id });
    call(m.approve_kid_task, { task_id: task.id }); // double tap: still paid once
    expect(test.db.kid_jar.member_id.find('mem_b')!.balance).toBe(3);
    expect(() => call(m.add_kid_task, { household_id: 'hh_demo', member_id: 'mem_nope', title: 'x', reward: 1, author_name: '' })).toThrow();
    call(m.set_kid_goal, { household_id: 'hh_demo', member_id: 'mem_b', title: 'Lego set', target: 5 });
    expect(() => call(m.redeem_kid_goal, { member_id: 'mem_b' })).toThrow('not enough saved yet');
    call(m.set_kid_goal, { household_id: 'hh_demo', member_id: 'mem_b', title: 'Lego set', target: 2 });
    call(m.redeem_kid_goal, { member_id: 'mem_b' });
    const jar = test.db.kid_jar.member_id.find('mem_b')!;
    expect([jar.balance, jar.goal_target]).toEqual([1, 0]);
  });
});
