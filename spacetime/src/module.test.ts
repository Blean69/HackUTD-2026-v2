// Module tests: reducers run against SpacetimeDB's real in-memory datastore (no server needed).
//   npm test
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
