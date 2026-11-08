// Brian's writes through a real PhoneService session: the question comes back first, the yes only counts 2.5 s later, and the write lands in the
// call's own household with Brian's name on it. (The tools themselves: tools/actions.test.ts and tools/kids.test.ts.)
import { describe, expect, it } from 'vitest';
import { MemorySink } from '../agent/sink.js';
import { loadConfig } from '../config.js';
import { buildLLMClient } from '../llm/client.js';
import { smallHousehold } from '../testing/fixtures.js';
import { FixedExternalApis } from '../tools/external.js';
import { buildRegistry } from '../tools/index.js';
import { loadPhoneConfig } from './config.js';
import { PhoneService } from './session.js';
import { PHONE_TOOLS } from './voice_view.js';

const data = smallHousehold({
  members: [
    { id: 'm1', household_id: 'hh_test', name: 'Alex Test', age: 40, role: 'parent', income_annual: 60000 },
    { id: 'kid1', household_id: 'hh_test', name: 'Sofia Test', age: 11, role: 'child', income_annual: 0 },
  ],
  kid_tasks: [{ id: 'kt9', member_id: 'kid1', title: 'Clean your room', reward: 6, status: 'done' }],
  kid_jars: [],
  goals: [{ id: 'goal_x', title: 'Family trip to Hawaii', target_amount: 8000, target_date: '2027-08-01', priority: 2, feasibility: 'stretch', evidence_quote: 'We keep saying Hawaii', source: 'huddle' }],
  alerts: [{ id: 'al1', severity: 'warn', kind: 'data_quality', title: 'Possible double charge at Home Depot', detail: '', acknowledged_by: '', created_at: '2026-11-04T10:00:00.000Z' }],
  proposals: [],
  votes: [],
});

async function call() {
  const sink = new MemorySink();
  const clock = { t: 1_000_000 };
  const svc = new PhoneService({
    sink,
    registry: buildRegistry(),
    external: new FixedExternalApis(),
    llm: buildLLMClient(loadConfig({})),
    loadData: async () => data,
    enqueueJob: async () => 7n,
    cfg: loadPhoneConfig({ VOICE_SHARED_SECRET: 'test-voice-secret-0123456789', PHONE_PINS: '1234:hh_test' }),
    now: () => clock.t,
    log: () => undefined,
  });
  const { run_id } = await svc.start({ call_id: 'c1', household_id: 'hh_test' });
  const tool = async (name: string, args: Record<string, unknown>) => (await svc.tool({ run_id, name, args })) as { ok: boolean; result: Record<string, any>; error?: string };
  /** Brian asks, the caller thinks for 3 s and says yes, Brian calls again with confirmed true. */
  const askThenYes = async (name: string, args: Record<string, unknown>) => {
    const first = await tool(name, { ...args, confirmed: false });
    clock.t += 3000;
    const second = await tool(name, { ...args, confirmed: true });
    return { first, second };
  };
  return { svc, sink, clock, tool, askThenYes };
}

describe('Brian acts for the family on a call', () => {
  it('offers every tool, and the write tools keep their confirmed flag in the model-facing schema', async () => {
    const { svc } = await call();
    const tools = svc.tools();
    expect(tools.map((t) => t.name)).toEqual([...PHONE_TOOLS]);
    for (const n of ['add_kid_chore', 'add_to_kid_jar', 'approve_kid_chore', 'set_kid_goal', 'change_goal', 'save_what_if', 'mark_alert_handled', 'create_proposal']) {
      const t = tools.find((x) => x.name === n)!;
      expect((t.parameters as { required: string[] }).required, n).toContain('confirmed');
    }
  });

  it('a goal: nothing is written on the question, or on a yes that comes too fast; the write goes to this household as a manual goal with its verdict', async () => {
    const { sink, tool, clock, askThenYes } = await call();
    const args = { action: 'add', goal: 'New couch', target_amount: 600, target_date: '2027-03-01' };
    const q = await tool('change_goal', { ...args, confirmed: false });
    expect(q.result.ask).toBe('Add the goal "New couch", $600 by March 1, 2027?');
    clock.t += 500; // the model rushed the yes: under 2.5 s since the question
    expect((await tool('change_goal', { ...args, confirmed: true })).result.done).toBe(false);
    expect(sink.of('upsertGoal')).toEqual([]);
    clock.t += 3000;
    const done = await tool('change_goal', { ...args, confirmed: true });
    expect(done.result).toMatchObject({ done: true, check: 'on track' });
    expect(sink.of('upsertGoal')).toHaveLength(1);
    expect(sink.of('upsertGoal')[0]![0]).toMatchObject({ household_id: 'hh_test', title: 'New couch', target_amount: 600, source: 'manual', feasibility: 'on_track' });

    const upd = await askThenYes('change_goal', { action: 'update', goal: 'hawaii', target_amount: 9000 });
    expect(upd.second.result.done).toBe(true);
    expect(sink.of('upsertGoal')[1]![0]).toMatchObject({ id: 'goal_x', household_id: 'hh_test', target_amount: 9000, evidence_quote: 'We keep saying Hawaii', source: 'huddle' });
    const del = await askThenYes('change_goal', { action: 'delete', goal: 'hawaii' });
    expect(del.second.result.done).toBe(true);
    expect(sink.of('deleteGoal')).toEqual([['goal_x']]);
  });

  it('the other writes land through the sink under Brian\'s name', async () => {
    const { sink, askThenYes } = await call();
    expect((await askThenYes('save_what_if', { question: 'Buy an $18,000 truck, financed over 60 months' })).second.result.done).toBe(true);
    expect(sink.of('requestSimulation')).toEqual([[{ household_id: 'hh_test', prompt: 'Buy an $18,000 truck, financed over 60 months', requested_by_name: 'Brian (AI)' }]]);

    expect((await askThenYes('create_proposal', { title: 'Replace the fridge', amount: 1800, days_open: 3 })).second.result.done).toBe(true);
    expect(sink.of('createProposal')).toEqual([[{ household_id: 'hh_test', title: 'Replace the fridge', amount: 1800, details: {}, closes_in_days: 3, author_name: 'Brian (AI)' }]]);

    expect((await askThenYes('mark_alert_handled', { alert: 'double charge' })).second.result.done).toBe(true);
    expect(sink.of('ackAlert')).toEqual([['al1', 'Brian (AI)']]);

    expect((await askThenYes('approve_kid_chore', { kid_name: 'Sofia' })).second.result.done).toBe(true);
    expect(sink.of('approveKidTask')).toEqual([['kt9']]);

    expect((await askThenYes('set_kid_goal', { kid_name: 'sofia', goal: 'Lego set', target: 60 })).second.result.done).toBe(true);
    expect(sink.of('setKidGoal')).toEqual([[{ household_id: 'hh_test', member_id: 'kid1', title: 'Lego set', target: 60 }]]);
  });

  it('a yes is used once: asking again after the write asks again instead of writing twice', async () => {
    const { sink, tool, askThenYes, clock } = await call();
    const args = { alert: 'double charge' };
    await askThenYes('mark_alert_handled', args);
    clock.t += 3000;
    expect((await tool('mark_alert_handled', { ...args, confirmed: true })).result.done).toBe(false);
    expect(sink.of('ackAlert')).toHaveLength(1);
  });

  it('the read tools reach the model with a trimmed, scrubbed view', async () => {
    const { tool } = await call();
    const goals = await tool('get_goals', {});
    expect(goals.result).toMatchObject({ count: 1, goals: [{ goal: 'Family trip to Hawaii', target: 8000, by: 'August 1, 2027', status: 'a stretch' }] });
    expect(goals.result.reply_hint).toMatch(/two short sentences/);
    expect((await tool('get_alerts', {})).result).toMatchObject({ open: 1 });
    expect((await tool('get_proposals', {})).result).toMatchObject({ count: 0, proposals: [] });
  });
});
