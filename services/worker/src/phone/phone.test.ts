import { describe, expect, it } from 'vitest';
import { MemorySink } from '../agent/sink.js';
import { buildLLMClient } from '../llm/client.js';
import { loadConfig } from '../config.js';
import { Router } from '../http.js';
import type { HttpRequest } from '../http.js';
import { smallHousehold } from '../testing/fixtures.js';
import { FixedExternalApis } from '../tools/external.js';
import { buildRegistry } from '../tools/index.js';
import type { HouseholdData } from '../types.js';
import { familyLabel } from './brief.js';
import { loadPhoneConfig, parsePins, type PhoneConfig } from './config.js';
import { PinChecker } from './identity.js';
import { registerPhoneRoutes, type PhoneRuntime } from './routes.js';
import { PhoneError, PhoneService, percentile, type PhoneDeps } from './session.js';
import { PHONE_TOOLS, VOICE_VIEW_MAX_CHARS, voiceView } from './voice_view.js';

const SECRET = 'test-voice-secret-0123456789';

function cfg(over: Partial<PhoneConfig> = {}): PhoneConfig {
  return { ...loadPhoneConfig({ VOICE_SHARED_SECRET: SECRET, PHONE_PINS: '1234:hh_test,5678:hh_test:m1' }), ...over };
}

function setup(over: Partial<PhoneDeps> = {}, data: HouseholdData = smallHousehold()) {
  const sink = new MemorySink();
  let nextJob = 41n;
  const enqueued: { workflow: string; householdId: string; subjectId: string; input: Record<string, unknown> }[] = [];
  const clock = { t: 1_000_000 };
  const deps: PhoneDeps = {
    sink,
    registry: buildRegistry(),
    external: new FixedExternalApis(),
    llm: buildLLMClient(loadConfig({})),
    loadData: async (id) => {
      if (id !== data.household.id) throw new Error(`unknown household ${id}`);
      return data;
    },
    enqueueJob: async (workflow, householdId, subjectId, input) => {
      enqueued.push({ workflow, householdId, subjectId, input });
      return nextJob++;
    },
    cfg: cfg(),
    now: () => clock.t,
    log: () => undefined,
    ...over,
  };
  return { svc: new PhoneService(deps), sink, enqueued, clock, deps };
}

describe('config', () => {
  it('parses PHONE_PINS and skips junk', () => {
    const m = parsePins('1234:hh_rivera, 5678:hh_nguyen:mem_x;abc:hh_x 12:hh_y 9999: 4321:bad/id 1234:hh_other');
    expect([...m.keys()]).toEqual(['1234', '5678']);
    expect(m.get('1234')).toEqual({ householdId: 'hh_rivera', memberId: '' });
    expect(m.get('5678')).toEqual({ householdId: 'hh_nguyen', memberId: 'mem_x' });
    expect(parsePins(undefined).size).toBe(0);
  });
  it('VOICE_ENABLED=0 is the kill switch; limits have sane defaults', () => {
    expect(loadPhoneConfig({ VOICE_ENABLED: '0' }).enabled).toBe(false);
    const c = loadPhoneConfig({});
    expect(c).toMatchObject({ enabled: true, secret: '', pinTries: 3, maxSessions: 4, idleReapMs: 600_000 });
  });
});

describe('PIN check', () => {
  const pins = parsePins('1234:hh_rivera:mem_a');
  it('accepts the right PIN and resets the counter', () => {
    const c = new PinChecker(pins, 3);
    expect(c.check('call1', '', '0000')).toMatchObject({ ok: false, triesLeft: 2, locked: false });
    expect(c.check('call1', '', '1234')).toEqual({ ok: true, entry: { householdId: 'hh_rivera', memberId: 'mem_a' } });
    expect(c.check('call1', '', '0000')).toMatchObject({ triesLeft: 2 });
  });
  it('locks the call after 3 wrong tries, even for the right PIN', () => {
    const c = new PinChecker(pins, 3);
    expect(c.check('call2', '', '1111')).toMatchObject({ triesLeft: 2 });
    expect(c.check('call2', '', '2222')).toMatchObject({ triesLeft: 1 });
    expect(c.check('call2', '', '3333')).toMatchObject({ triesLeft: 0, locked: true });
    expect(c.check('call2', '', '1234')).toEqual({ ok: false, triesLeft: 0, locked: true });
    expect(c.check('call3', '', '1234').ok).toBe(true); // another call is unaffected
  });
  it('a caller hash cannot buy fresh tries by hanging up', () => {
    let t = 0;
    const c = new PinChecker(pins, 3, () => t);
    for (let i = 0; i < 9; i++) c.check(`call_${i}`, 'h_abc', '0000');
    expect(c.check('call_new', 'h_abc', '1234')).toMatchObject({ ok: false, locked: true });
    t += 16 * 60_000;
    expect(c.check('call_later', 'h_abc', '1234').ok).toBe(true);
  });
  it('handles empty and non-string input', () => {
    const c = new PinChecker(pins, 3);
    expect(c.check('c', '', '').ok).toBe(false);
    expect(c.check('c2', '', undefined as never).ok).toBe(false);
  });
});

describe('voiceView', () => {
  const reg = buildRegistry();
  const ctx = { data: smallHousehold(), external: new FixedExternalApis() };
  const run = async (name: string, args: unknown) => {
    const out = await reg.execute(name, args, ctx);
    if (!out.ok) throw new Error(out.error);
    return out.result;
  };

  it('simulate_scenario keeps only what a voice needs, rounded to whole dollars', async () => {
    const full = await run('simulate_scenario', { kind: 'purchase', amount: 35000, financed: true, down_payment: 5000, apr_pct: 6.2, term_months: 60, label: 'Buy a $35,000 car' });
    const v = voiceView('simulate_scenario', full) as Record<string, any>;
    expect(Object.keys(v).sort()).toEqual(['assumptions', 'effect', 'ending', 'headline', 'lowest', 'months_of_spending_covered_at_low', 'verdict']);
    expect(v.assumptions.length).toBeLessThanOrEqual(2);
    expect(Number.isInteger(v.effect.monthly_payment)).toBe(true);
    expect(v.effect.monthly_payment).toBeGreaterThan(500);
    expect(JSON.stringify(v).length).toBeLessThanOrEqual(VOICE_VIEW_MAX_CHARS);
    expect(JSON.stringify(v).length).toBeLessThan(JSON.stringify(full).length / 2);
  });

  it('every phone tool result fits the voice budget', async () => {
    const calls: [string, unknown][] = [
      ['get_health_indicators', {}],
      ['get_forecast', {}],
      ['get_obligations', {}],
      ['get_accounts', {}],
      ['goal_feasibility', { target_amount: 60000, target_date: '2028-06-01', title: 'Second shop' }],
      ['detect_scam_signals', { text: 'Grandma: He said he was your grandson and needed bail money in gift cards right now. Do not tell your parents.' }],
    ];
    for (const [name, args] of calls) {
      const v = voiceView(name, await run(name, args));
      expect(JSON.stringify(v).length, name).toBeLessThanOrEqual(VOICE_VIEW_MAX_CHARS);
    }
    const f = voiceView('get_forecast', await run('get_forecast', {})) as Record<string, any>;
    expect(f).not.toHaveProperty('points');
    expect(Number.isInteger(f.lowest.balance)).toBe(true);
  });

  it('copes with empty or odd results and caps long lists', () => {
    expect(voiceView('get_forecast', { available: false, note: 'none' })).toEqual({ available: false, note: 'none' });
    expect(voiceView('get_obligations', null)).toMatchObject({ count: 0, biggest: [] });
    const many = { accounts: Array.from({ length: 30 }, (_v, i) => ({ nickname: `Acct ${i}`, type: 'savings', balance: i * 1000.4 })), totals: {} };
    expect((voiceView('get_accounts', many) as any).accounts).toHaveLength(8);
    const huge = voiceView('mystery_tool', { text: 'x'.repeat(5000), rows: Array.from({ length: 100 }, (_v, i) => i) });
    expect(JSON.stringify(huge).length).toBeLessThanOrEqual(VOICE_VIEW_MAX_CHARS);
  });
});

describe('brief', () => {
  it('familyLabel', () => {
    expect(familyLabel('Rivera Family')).toBe('Rivera family');
    expect(familyLabel('Okafor Household')).toBe('Okafor household');
    expect(familyLabel('')).toBe('the family');
  });
});

describe('PhoneService: one call = one traced agent_run', () => {
  it('start: enqueue, claim, start_run, run_started, plan, briefing tool calls; returns a short brief', async () => {
    const { svc, sink, enqueued } = setup();
    const r = await svc.start({ call_id: 'call-1', household_id: 'hh_test', transport: 'webrtc', display_name: 'Alex T', llm: { provider: 'nvidia', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' } });
    expect(enqueued).toEqual([{ workflow: 'phone', householdId: 'hh_test', subjectId: 'call-1', input: { transport: 'webrtc', caller: 'new' } }]);
    expect(sink.of('claimJob')).toEqual([[41n]]);
    expect(sink.of('startRun')).toEqual([[r.run_id, 41n]]);
    expect(r.run_id).toMatch(/^run_41_/);
    expect(r).toMatchObject({ household_id: 'hh_test', family: 'Test family', first_name: 'Alex' });
    expect(r.brief.length).toBeGreaterThanOrEqual(4);
    expect(r.brief.length).toBeLessThanOrEqual(12);
    expect(r.brief[0]).toMatch(/Test family/);
    expect(svc.activeCalls).toBe(1);

    await svc.end({ run_id: r.run_id, reason: 'hangup' });
    const t = sink.traces;
    expect(t.map((e) => e.type)).toEqual(['run_started', 'plan', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'final']);
    expect(t[0]).toMatchObject({ workflow: 'phone', agent: 'voice_agent', title: 'Voice call connected (Test family)', provider: 'nvidia', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' });
    expect(t.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(t.every((e) => e.runId === r.run_id && e.dataJson.length <= 4096)).toBe(true);
    expect(JSON.stringify(t)).not.toMatch(/1234|5678|pin/i);
  });

  it('start is idempotent per call_id and validates its input', async () => {
    const { svc, enqueued } = setup();
    const a = await svc.start({ call_id: 'c1', household_id: 'hh_test' });
    const b = await svc.start({ call_id: 'c1', household_id: 'hh_test' });
    expect(b).toMatchObject({ run_id: a.run_id, resumed: true });
    expect(enqueued).toHaveLength(1);
    await expect(svc.start({ call_id: 'bad id!', household_id: 'hh_test' })).rejects.toMatchObject({ status: 400, code: 'bad_call_id' });
    await expect(svc.start({ call_id: 'c2', household_id: '' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.start({ call_id: 'c3', household_id: 'hh_nope' })).rejects.toMatchObject({ status: 404, code: 'unknown_household' });
    expect(enqueued).toHaveLength(1); // nothing is queued for a call that cannot start
  });

  it('limits concurrent calls', async () => {
    const { svc } = setup({ cfg: cfg({ maxSessions: 2 }) });
    await svc.start({ call_id: 'a', household_id: 'hh_test' });
    await svc.start({ call_id: 'b', household_id: 'hh_test' });
    await expect(svc.start({ call_id: 'c', household_id: 'hh_test' })).rejects.toMatchObject({ status: 429, code: 'too_many_calls' });
  });

  it('tool: runs through run.tool (tool_call + tool_result) and hands back the voiceView; only phone tools are allowed', async () => {
    const { svc, sink } = setup();
    const { run_id } = await svc.start({ call_id: 'c1', household_id: 'hh_test' });
    const before = sink.traces.length;
    const out = (await svc.tool({ run_id, name: 'simulate_scenario', args: { kind: 'purchase', amount: 35000, label: 'Buy a $35k car' } })) as { ok: boolean; result: Record<string, any>; summary: string; ms: number };
    expect(out.ok).toBe(true);
    expect(out.result.headline).toMatch(/car/);
    expect(out.result.reply_hint).toMatch(/two short sentences/);
    expect(JSON.stringify(out.result).length).toBeLessThanOrEqual(VOICE_VIEW_MAX_CHARS);
    const added = sink.traces.slice(before);
    expect(added.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
    expect(added[1]!.dataJson).toContain('"tool":"simulate_scenario"'); // the trace keeps the full result; only the model's copy is trimmed
    expect(added.every((e) => e.agent === 'voice_agent')).toBe(true);

    await expect(svc.tool({ run_id, name: 'detect_transaction_anomalies', args: {} })).rejects.toMatchObject({ status: 400, code: 'tool_not_allowed' });
    await expect(svc.tool({ run_id: 'run_nope', name: 'get_forecast', args: {} })).rejects.toMatchObject({ status: 404, code: 'unknown_run' });
    const bad = (await svc.tool({ run_id, name: 'simulate_scenario', args: { kind: 'teleport' } })) as { ok: boolean; error: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/invalid arguments/);
  });

  it('tools(): the seven phone tools, in order, with a slim simulate_scenario', () => {
    const { svc } = setup();
    const tools = svc.tools();
    expect(tools.map((t) => t.name)).toEqual([...PHONE_TOOLS]);
    const sim = tools.find((t) => t.name === 'simulate_scenario')!;
    const props = Object.keys((sim.parameters as { properties: Record<string, unknown> }).properties);
    expect(props).toContain('amount');
    expect(props).not.toContain('proceeds_to_cash');
    expect(props).not.toContain('start_month');
    // read-only lookups take no arguments (an optional filter sent Lightning in a loop over every obligation kind)
    for (const n of ['get_obligations', 'get_accounts', 'get_forecast', 'get_health_indicators']) {
      expect(Object.keys((tools.find((t) => t.name === n)!.parameters as { properties: Record<string, unknown> }).properties), n).toEqual([]);
    }
    expect((tools.find((t) => t.name === 'goal_feasibility')!.parameters as { required: string[] }).required).toEqual(['target_amount', 'target_date']);
  });

  it('trace: heard / said / note become message events with model, provider and latency; then end writes the final', async () => {
    const { svc, sink, clock } = setup();
    const { run_id } = await svc.start({ call_id: 'c1', household_id: 'hh_test', llm: { provider: 'nvidia', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' } });
    clock.t += 42_000;
    const r = svc.trace({
      run_id,
      events: [
        { kind: 'heard', text: 'What if we buy a thirty five thousand dollar car?', asr_ms: 210 },
        { kind: 'note', title: 'Filler line while tools ran' },
        { kind: 'said', text: 'Sure, let me run that. A car like that would cost about six hundred a month.', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', asr_ms: 240, llm_ms: 190, tts_ms: 180, v2v_ms: 1400, tokens_in: 800, tokens_out: 40, tts_voice: 'Magpie-Multilingual.EN-US.Mia.Calm' },
        { kind: 'heard', text: 'Thanks.', asr_ms: 150 },
        { kind: 'said', text: "You're welcome.", llm_ms: 150, tts_ms: 170, v2v_ms: 1100, interrupted: true },
        { kind: 'mystery' } as never,
        { kind: 'heard', text: '   ' },
      ],
    });
    expect(r).toEqual({ ok: true, accepted: 5, dropped: 2 });
    const end = await svc.end({ run_id, reason: 'hangup', stats: { barge_ins: 1 } });
    expect(end).toMatchObject({ ok: true, turns: 2, tool_calls: 0, p50_ms: 1100, p95_ms: 1400, duration_s: 42 });

    const msgs = sink.traces.filter((e) => e.type === 'message');
    expect(msgs.map((e) => e.title)).toEqual([
      'Heard: “What if we buy a thirty five thousand dollar car?”',
      'Filler line while tools ran',
      'Said: “Sure, let me run that.”',
      'Heard: “Thanks.”',
      'Said: “You\'re welcome.” (caller interrupted)',
    ]);
    expect(msgs[0]).toMatchObject({ model: 'nemotron-asr-streaming', provider: 'nvidia', latencyMs: 210 });
    expect(msgs[2]).toMatchObject({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', provider: 'nvidia', latencyMs: 190, tokensIn: 800, tokensOut: 40 });
    expect(JSON.parse(msgs[2]!.dataJson)).toMatchObject({ asr_final_ms: 240, voice_to_voice_ms: 1400, tts_first_audio_ms: 180, tts: { model: 'magpie-tts-multilingual', voice: 'Magpie-Multilingual.EN-US.Mia.Calm' } });
    const last = sink.traces[sink.traces.length - 1]!;
    expect(last.type).toBe('final');
    expect(last.title).toMatch(/2 turns, 0 tool calls, median 1100 ms voice-to-voice/);

    const [runId, status, providers, result] = sink.of('finishRun')[0] as [string, string, string, string];
    expect(runId).toBe(run_id);
    expect(status).toBe('done');
    expect(JSON.parse(providers)[0]).toMatchObject({ provider: 'nvidia', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', calls: 2 });
    expect(JSON.parse(result)).toMatchObject({ turns: 2, reason: 'hangup', voice_to_voice_ms: { p50: 1100, p95: 1400, samples: 2 }, client_stats: { barge_ins: 1 } });
    expect(svc.activeCalls).toBe(0);
  });

  it('end is idempotent (hang-up and disconnect handlers both fire), and an ended call refuses more trace and tools', async () => {
    const { svc, sink } = setup();
    const { run_id } = await svc.start({ call_id: 'c1', household_id: 'hh_test' });
    const [a, b] = await Promise.all([svc.end({ run_id, reason: 'hangup' }), svc.end({ run_id, reason: 'client_left' })]);
    expect(a).toMatchObject({ ok: true, reason: 'hangup' });
    expect(b).toMatchObject({ ok: true, already: true });
    expect(await svc.end({ run_id, reason: 'hangup' })).toMatchObject({ ok: true, already: true });
    expect(sink.of('finishRun')).toHaveLength(1);
    expect(() => svc.trace({ run_id, events: [] })).toThrow(PhoneError);
    await expect(svc.tool({ run_id, name: 'get_forecast' })).rejects.toMatchObject({ status: 404 });
    // the same call_id can be started again afterwards (a redial) as a new run
    const again = await svc.start({ call_id: 'c1', household_id: 'hh_test' });
    expect(again.run_id).not.toBe(run_id);
  });

  it('an errored call finishes as error', async () => {
    const { svc, sink } = setup();
    const { run_id } = await svc.start({ call_id: 'c1', household_id: 'hh_test' });
    await svc.end({ run_id, reason: 'error: asr stream dropped' });
    expect(sink.of('finishRun')[0]![1]).toBe('error');
    expect(sink.traces[sink.traces.length - 1]!.type).toBe('error');
  });

  it('the reaper finishes idle calls as error "abandoned" and over-long calls too; busy calls survive', async () => {
    const { svc, sink, clock } = setup({ cfg: cfg({ idleReapMs: 600_000, maxCallMs: 900_000 }) });
    const idle = await svc.start({ call_id: 'idle', household_id: 'hh_test' });
    const busy = await svc.start({ call_id: 'busy', household_id: 'hh_test' });
    clock.t += 400_000;
    await svc.tool({ run_id: busy.run_id, name: 'get_forecast', args: {} }); // traffic refreshes lastSeen
    clock.t += 300_000;
    expect(await svc.reap()).toEqual([idle.run_id]);
    expect(svc.activeCalls).toBe(1);
    const fin = sink.of('finishRun')[0]!;
    expect(fin[0]).toBe(idle.run_id);
    expect(fin[1]).toBe('error');
    expect(JSON.parse(String(fin[3])).reason).toBe('error: abandoned');
    clock.t += 300_000;
    svc.trace({ run_id: busy.run_id, events: [{ kind: 'note', title: 'still here' }] });
    clock.t += 100_000; // 1,100 s since start: over maxCallMs
    expect(await svc.reap()).toEqual([busy.run_id]);
    expect(JSON.parse(String(sink.of('finishRun')[1]![3])).reason).toMatch(/maximum call length/);
  });

  it('identify: right PIN gives the household (and member first name), wrong PINs run out after three', async () => {
    const { svc } = setup();
    expect(await svc.identify({ call_id: 'p1', caller_hash: 'h', pin: '0000' })).toEqual({ ok: false, tries_left: 2, locked: false });
    const ok = await svc.identify({ call_id: 'p1', caller_hash: 'h', pin: '5678' });
    expect(ok).toMatchObject({ ok: true, household_id: 'hh_test', member_id: 'm1', first_name: 'Alex', family: 'Test family' });
    const plain = await svc.identify({ call_id: 'p2', pin: '1234' });
    expect(plain).toMatchObject({ ok: true, household_id: 'hh_test', first_name: '' });
    for (let i = 0; i < 2; i++) await svc.identify({ call_id: 'p3', pin: '9999' });
    expect(await svc.identify({ call_id: 'p3', pin: '9999' })).toEqual({ ok: false, tries_left: 0, locked: true });
    expect(await svc.identify({ call_id: 'p3', pin: '1234' })).toMatchObject({ ok: false, locked: true });
    await expect(svc.identify({ call_id: '', pin: '1234' })).rejects.toBeInstanceOf(PhoneError);
  });
});

describe('percentile', () => {
  it('nearest rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });
});

describe('HTTP routes', () => {
  function build(over: Partial<PhoneRuntime> = {}) {
    const { svc, sink } = setup();
    const rt: PhoneRuntime = { cfg: cfg(), service: svc, ...over };
    const router = new Router();
    registerPhoneRoutes(router, () => rt);
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-voice-secret': SECRET }) => {
      const h = router.find(method, path);
      if (!h) return { status: 404, body: { error: 'not_found' } as any };
      const req: HttpRequest = { method, path, query: new URLSearchParams(), headers, body: async () => Buffer.from(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)) };
      const r = await h(req);
      return { status: r.status, body: r.body as any };
    };
    return { call, sink, svc, rt };
  }

  it('requires the x-voice-secret header on every route', async () => {
    const { call } = build();
    for (const [m, p] of [['POST', '/phone/identify'], ['POST', '/phone/start'], ['GET', '/phone/tools'], ['POST', '/phone/tool'], ['POST', '/phone/trace'], ['POST', '/phone/end']] as const) {
      expect((await call(m, p, {}, {})).status, `${p} without header`).toBe(401);
      expect((await call(m, p, {}, { 'x-voice-secret': 'wrong' })).status, `${p} wrong`).toBe(401);
    }
  });

  it('503s when disabled, unconfigured, or not yet connected', async () => {
    expect((await build({ cfg: cfg({ enabled: false }) }).call('GET', '/phone/tools')).body.error).toBe('voice_disabled');
    expect((await build({ cfg: cfg({ secret: '' }) }).call('GET', '/phone/tools')).body.error).toBe('voice_unconfigured');
    const r = await build({ service: null }).call('GET', '/phone/tools');
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('spacetime_unavailable');
  });

  it('runs a whole call over HTTP', async () => {
    const { call, sink } = build();
    const id = await call('POST', '/phone/identify', { call_id: 'twilio-CA1', caller_hash: 'abc', pin: '1234' });
    expect(id.body).toMatchObject({ ok: true, household_id: 'hh_test' });
    const tools = await call('GET', '/phone/tools');
    expect(tools.status).toBe(200);
    expect(tools.body.map((t: { name: string }) => t.name)).toEqual([...PHONE_TOOLS]);
    const start = await call('POST', '/phone/start', { call_id: 'twilio-CA1', household_id: id.body.household_id, transport: 'twilio', caller: 'known' });
    expect(start.status).toBe(200);
    const run_id = start.body.run_id as string;
    const tool = await call('POST', '/phone/tool', { run_id, name: 'get_forecast', args: {} });
    expect(tool.body.ok).toBe(true);
    expect(tool.body.result.lowest).toBeDefined();
    expect((await call('POST', '/phone/trace', { run_id, events: [{ kind: 'heard', text: 'hello there', asr_ms: 120 }] })).body.accepted).toBe(1);
    const end = await call('POST', '/phone/end', { run_id, reason: 'hangup' });
    expect(end.body).toMatchObject({ ok: true, turns: 1, tool_calls: 1 });
    expect(sink.traces.some((e) => e.type === 'final')).toBe(true);
  });

  it('maps errors to JSON statuses', async () => {
    const { call } = build();
    expect((await call('POST', '/phone/start', 'not json')).status).toBe(400);
    expect((await call('POST', '/phone/start', '[1]')).status).toBe(400);
    expect((await call('POST', '/phone/start', { call_id: 'x', household_id: 'hh_nope' })).status).toBe(404);
    expect((await call('POST', '/phone/tool', { run_id: 'run_x', name: 'get_forecast' })).status).toBe(404);
  });
});
