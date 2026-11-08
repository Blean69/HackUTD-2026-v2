// The callback's worker half (docs/contracts.md section 10): alert candidates from real signals, the critical alert row, the callback run.
import { describe, expect, it } from 'vitest';
import { MemorySink } from '../agent/sink.js';
import { loadConfig } from '../config.js';
import { Router } from '../http.js';
import type { HttpRequest } from '../http.js';
import { buildLLMClient } from '../llm/client.js';
import { smallHousehold, txn } from '../testing/fixtures.js';
import { FixedExternalApis } from '../tools/external.js';
import { buildRegistry } from '../tools/index.js';
import type { HouseholdData } from '../types.js';
import { buildAlertCandidates, last4, StaticAlertSource, type AlertRow } from './callback.js';
import { loadPhoneConfig } from './config.js';
import { registerPhoneRoutes, type PhoneRuntime } from './routes.js';
import { PhoneService, type PhoneDeps } from './session.js';

const SECRET = 'test-voice-secret-0123456789';
const cfg = () => loadPhoneConfig({ VOICE_SHARED_SECRET: SECRET, PHONE_PINS: '1234:hh_test' });

const alertRow = (p: Partial<AlertRow> & Pick<AlertRow, 'id'>): AlertRow => ({ severity: 'warn', kind: 'fraud', title: 'Something odd', detail: 'Details.', related_ids: [], acknowledged_by: '', created_at: '2026-11-06T10:00:00Z', ...p });

/** The small household plus a card-testing burst, a gift-card payment, a duplicate and an overnight new-payee transfer, all in the last two weeks. */
function householdWithSignals(): HouseholdData {
  const base = smallHousehold();
  const extra = [
    ...Array.from({ length: 6 }, (_v, i) => txn({ id: `ct${i}`, date: '2026-11-03', amount: -(0.5 + i * 0.1), merchant: `Tiny Shop ${i}`, account_id: 'card', category: 'shopping' })),
    txn({ id: 'gift1', date: '2026-11-04', amount: -500, merchant: 'CVS Pharmacy', category: 'gift_cards', description: 'GIFT CARD 13:04' }),
    txn({ id: 'dup1', date: '2026-11-05', amount: -42.5, merchant: 'Pizza Place', category: 'dining' }),
    txn({ id: 'dup2', date: '2026-11-05', amount: -42.5, merchant: 'Pizza Place', category: 'dining' }),
    txn({ id: 'tk1', date: '2026-11-02', amount: -2400, merchant: 'Online Transfer', category: 'transfer', description: 'new payee added 02:41 Zelle' }),
  ];
  return { ...base, txns: [...base.txns, ...extra] };
}

function setup(data: HouseholdData = smallHousehold(), alerts: AlertRow[] = [], over: Partial<PhoneDeps> = {}) {
  const sink = new MemorySink();
  let job = 7n;
  const deps: PhoneDeps = {
    sink,
    registry: buildRegistry(),
    external: new FixedExternalApis(),
    llm: buildLLMClient(loadConfig({})),
    loadData: async (id) => {
      if (id !== data.household.id) throw new Error(`unknown household ${id}`);
      return data;
    },
    enqueueJob: async () => job++,
    cfg: cfg(),
    alerts: new StaticAlertSource({ hh_test: alerts }),
    log: () => undefined,
    ...over,
  };
  return { svc: new PhoneService(deps), sink };
}

describe('buildAlertCandidates', () => {
  it('rule hits: card testing, scam payment, new-payee transfer and duplicate, with plain facts and the right alert kinds', () => {
    const data = householdWithSignals();
    const findings = [
      { txn_id: 'gift1', rule: 'scam_payment', severity: 'critical', kind: 'scam', score: 9.1, date: '2026-11-04', amount: -500, merchant: 'CVS Pharmacy', reason: '$500 to CVS' },
      ...Array.from({ length: 6 }, (_v, i) => ({ txn_id: `ct${i}`, rule: 'card_testing', severity: 'critical', kind: 'fraud', score: 8, date: '2026-11-03', amount: -0.5, merchant: `Tiny Shop ${i}`, reason: '6 charges under $2' })),
      { txn_id: 'tk1', rule: 'account_takeover', severity: 'critical', kind: 'fraud', score: 8.5, date: '2026-11-02', amount: -2400, merchant: 'Online Transfer', reason: 'new payee' },
      { txn_id: 'dup2', rule: 'duplicate', severity: 'warn', kind: 'data_quality', score: 5, date: '2026-11-05', amount: -42.5, merchant: 'Pizza Place', reason: 'twice' },
    ];
    const { candidates, context } = buildAlertCandidates(data, [], findings, 'Test family');
    expect(candidates.map((c) => c.type)).toEqual(['scam_payment', 'card_testing', 'new_payee_transfer', 'duplicate']);
    const [scam, ct, payee, dup] = candidates;
    expect(scam).toMatchObject({ kind: 'scam', severity: 'critical', source: 'rule', facts: { amount: 500, merchant: 'CVS Pharmacy' } });
    expect(ct).toMatchObject({ kind: 'fraud', facts: { count: 6, last4: last4('card'), account: 'Visa' } });
    expect(ct!.related_ids).toHaveLength(6);
    expect(payee).toMatchObject({ kind: 'fraud', facts: { amount: 2400, overnight: true } });
    expect(dup).toMatchObject({ kind: 'data_quality', severity: 'warn', facts: { amount: 43 } });
    expect(context).toMatchObject({ household_id: 'hh_test', family: 'Test family', as_of: '2026-11-07', city: 'Dallas', checking_balance: 20000 });
    expect(context.accounts.map((a) => a.type).sort()).toEqual(['checking', 'credit_card', 'savings']);
    expect(context.accounts.every((a) => /^\d{4}$/.test(a.last4))).toBe(true);
    expect(last4('card')).toBe(last4('card'));
  });

  it('open critical and warn alerts come first; acknowledged ones, info ones and earlier callback alerts are never offered', () => {
    const alerts = [
      alertRow({ id: 'rule:hh_test:ct', severity: 'critical', title: 'Card testing on Visa', related_ids: ['ct0'] }),
      alertRow({ id: 'agent:hh_test:x', severity: 'warn', kind: 'scam', title: 'Gift cards' }),
      alertRow({ id: 'acked', severity: 'critical', acknowledged_by: 'Maria' }),
      alertRow({ id: 'infoonly', severity: 'info' }),
      alertRow({ id: 'callback:hh_test:tel-CA1', severity: 'critical', title: 'an earlier callback' }),
      alertRow({ id: 'rule:hh_test:credit', severity: 'warn', kind: 'credit', title: 'Credit score dropped 28 points' }),
    ];
    const { candidates } = buildAlertCandidates(householdWithSignals(), alerts, [
      { txn_id: 'ct0', rule: 'card_testing', severity: 'critical', kind: 'fraud', score: 8, date: '2026-11-03', amount: -0.5, merchant: 'Tiny Shop 0', reason: 'burst' },
    ], 'Test family');
    expect(candidates.map((c) => c.id)).toEqual(['alert:rule:hh_test:ct', 'alert:rule:hh_test:credit', 'alert:agent:hh_test:x']);
    expect(candidates[0]).toMatchObject({ type: 'open_alert', severity: 'critical', alert_id: 'rule:hh_test:ct', priority: 90 });
    expect(candidates[1]).toMatchObject({ type: 'credit_drop', alert_id: 'rule:hh_test:credit' });
    // the finding for ct0 is already covered by the open alert that cites it, so it is not offered twice
    expect(candidates.some((c) => c.type === 'card_testing')).toBe(false);
  });

  it('a forecast that goes below zero becomes an overdraft candidate with the date; a healthy one does not', () => {
    const data = smallHousehold();
    expect(buildAlertCandidates(data, [], [], 'Test family').candidates).toEqual([]);
    const forecast = data.forecast.map((p, i) => (i === 6 ? { ...p, balance: -340, obligations_due: 1800 } : i === 5 ? { ...p, balance: 120 } : p));
    const { candidates } = buildAlertCandidates({ ...data, forecast }, [], [], 'Test family');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ type: 'overdraft', kind: 'obligation', severity: 'critical', source: 'forecast', facts: { date: '2026-11-13', shortfall: 340, bills_due: 1800, in_days: 6 }, priority: 75 });
  });

  it('old findings (past 60 days) are ignored', () => {
    const { candidates } = buildAlertCandidates(smallHousehold(), [], [{ txn_id: 'x', rule: 'scam_payment', severity: 'critical', kind: 'scam', score: 9, date: '2026-08-01', amount: -500, merchant: 'Old', reason: 'old' }], 'Test family');
    expect(candidates).toEqual([]);
  });
});

describe('PhoneService: callback', () => {
  it('alertCandidates runs the anomaly scan on the household and merges its open alerts', async () => {
    const { svc } = setup(householdWithSignals(), [alertRow({ id: 'rule:hh_test:open', severity: 'critical', title: 'Open one' })]);
    const r = (await svc.alertCandidates('hh_test')) as { household_id: string; family: string; as_of: string; candidates: { id: string; type: string }[]; context: { accounts: unknown[] } };
    expect(r).toMatchObject({ household_id: 'hh_test', family: 'Test family', as_of: '2026-11-07' });
    expect(r.candidates[0]!.id).toBe('alert:rule:hh_test:open');
    expect(r.candidates.map((c) => c.type)).toEqual(expect.arrayContaining(['card_testing', 'scam_payment']));
    expect(r.context.accounts.length).toBeGreaterThan(0);
    await expect(svc.alertCandidates('hh_nope')).rejects.toMatchObject({ status: 404, code: 'unknown_household' });
    await expect(svc.alertCandidates('bad id!')).rejects.toMatchObject({ status: 400 });
  });

  it('works without an alert source (rule hits and templates only)', async () => {
    const { svc } = setup(householdWithSignals(), [], { alerts: undefined });
    const r = (await svc.alertCandidates('hh_test')) as { candidates: unknown[] };
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it('a callback run is titled as a callback; callback_alert writes ONE critical alert row and traces it', async () => {
    const { svc, sink } = setup();
    const { run_id } = await svc.start({ call_id: 'tel-CA9', household_id: 'hh_test', transport: 'signalwire', caller: 'callback', callback: true });
    const out = await svc.callbackAlert({ run_id, alert: { kind: 'fraud', title: 'Charge in Miami on card ending 4417', detail: 'A $412 charge.', related_ids: ['t1', 't2'], origin: 'template: card_other_city' } });
    expect(out).toEqual({ ok: true, alert_id: 'callback:hh_test:tel-CA9', written: true, reused: false });
    const [alert] = sink.of('createAlert').map((a) => a[0]);
    expect(alert).toEqual({ id: 'callback:hh_test:tel-CA9', household_id: 'hh_test', severity: 'critical', kind: 'fraud', title: 'Charge in Miami on card ending 4417', detail: 'A $412 charge.', related_ids: ['t1', 't2'] });
    // idempotent id: a retry replaces the row instead of adding one
    await svc.callbackAlert({ run_id, alert: { kind: 'fraud', title: 'Charge in Miami on card ending 4417' } });
    expect((sink.of('createAlert').map((a) => a[0]) as { id: string }[]).every((a) => a.id === 'callback:hh_test:tel-CA9')).toBe(true);
    await svc.end({ run_id, reason: 'hangup' });
    const t = sink.traces;
    expect(t[0]).toMatchObject({ type: 'run_started', workflow: 'phone', title: 'Voice callback connected (Test family)' });
    expect(t[1]).toMatchObject({ type: 'plan', title: 'Callback with a critical alert' });
    expect(t.map((e) => e.type)).toEqual(expect.arrayContaining(['thought', 'tool_call', 'tool_result', 'final']));
    expect(t.find((e) => e.type === 'tool_result' && e.title.startsWith('Critical alert on the dashboard'))).toBeTruthy();
    expect(JSON.parse(t[0]!.dataJson)).toMatchObject({ callback: true, caller: 'callback', disclosure_spoken: false });
  });

  it('an open critical alert that is already on the dashboard is reused, not written again', async () => {
    const { svc, sink } = setup();
    const { run_id } = await svc.start({ call_id: 'tel-CA1', household_id: 'hh_test', callback: true });
    const out = await svc.callbackAlert({ run_id, alert: { kind: 'fraud', title: 'Card testing on Visa', existing_alert_id: 'rule:hh_test:ct' } });
    expect(out).toEqual({ ok: true, alert_id: 'rule:hh_test:ct', written: false, reused: true });
    expect(sink.of('createAlert')).toHaveLength(0);
  });

  it('refuses: a normal (non-callback) call, an empty title; an unknown kind falls back to fraud; a failed write is reported, not thrown', async () => {
    const { svc, sink } = setup();
    const normal = await svc.start({ call_id: 'c-normal', household_id: 'hh_test' });
    await expect(svc.callbackAlert({ run_id: normal.run_id, alert: { title: 'x' } })).rejects.toMatchObject({ status: 409, code: 'not_a_callback' });
    const cb = await svc.start({ call_id: 'c-cb', household_id: 'hh_test', callback: true });
    await expect(svc.callbackAlert({ run_id: cb.run_id, alert: { title: '   ' } })).rejects.toMatchObject({ status: 400 });
    await expect(svc.callbackAlert({ run_id: 'run_nope', alert: { title: 'x' } })).rejects.toMatchObject({ status: 404, code: 'unknown_run' });
    await svc.callbackAlert({ run_id: cb.run_id, alert: { title: 'Odd', kind: 'gossip' } });
    expect((sink.of('createAlert')[0]![0] as { kind: string; severity: string }).kind).toBe('fraud');
    const failing = setup();
    failing.sink.createAlert = () => Promise.reject(new Error('kind must be one of'));
    const s2 = await failing.svc.start({ call_id: 'c-fail', household_id: 'hh_test', callback: true });
    expect(await failing.svc.callbackAlert({ run_id: s2.run_id, alert: { title: 'Odd', kind: 'fraud' } })).toMatchObject({ ok: false, written: false });
  });
});

describe('HTTP routes for the callback', () => {
  function build() {
    const { svc, sink } = setup(householdWithSignals(), [alertRow({ id: 'rule:hh_test:open', severity: 'critical', title: 'Open one' })]);
    const rt: PhoneRuntime = { cfg: cfg(), service: svc };
    const router = new Router();
    registerPhoneRoutes(router, () => rt);
    const call = async (method: string, path: string, body?: unknown, query = '', headers: Record<string, string> = { 'x-voice-secret': SECRET }) => {
      const h = router.find(method, path);
      if (!h) return { status: 404, body: { error: 'not_found' } as any };
      const req: HttpRequest = { method, path, query: new URLSearchParams(query), headers, body: async () => Buffer.from(body === undefined ? '' : JSON.stringify(body)) };
      const r = await h(req);
      return { status: r.status, body: r.body as any };
    };
    return { call, sink };
  }

  it('both routes sit behind the voice secret', async () => {
    const { call } = build();
    expect((await call('GET', '/phone/alert_candidates', undefined, 'household_id=hh_test', {})).status).toBe(401);
    expect((await call('POST', '/phone/callback_alert', {}, '', { 'x-voice-secret': 'wrong' })).status).toBe(401);
  });

  it('GET /phone/alert_candidates?household_id= and POST /phone/callback_alert over HTTP', async () => {
    const { call, sink } = build();
    const c = await call('GET', '/phone/alert_candidates', undefined, 'household_id=hh_test');
    expect(c.status).toBe(200);
    expect(c.body.candidates[0]).toMatchObject({ id: 'alert:rule:hh_test:open', priority: 90 });
    expect((await call('GET', '/phone/alert_candidates', undefined, 'household_id=hh_nope')).status).toBe(404);
    expect((await call('GET', '/phone/alert_candidates')).status).toBe(400);
    const start = await call('POST', '/phone/start', { call_id: 'tel-CAx', household_id: 'hh_test', transport: 'signalwire', caller: 'callback', callback: true });
    expect(start.status).toBe(200);
    const w = await call('POST', '/phone/callback_alert', { run_id: start.body.run_id, alert: { kind: 'scam', title: 'Gift card pattern', detail: 'Three purchases.' } });
    expect(w.body).toMatchObject({ ok: true, written: true });
    expect(sink.of('createAlert')).toHaveLength(1);
    expect((await call('POST', '/phone/callback_alert', { run_id: start.body.run_id })).status).toBe(400); // no alert
  });
});

