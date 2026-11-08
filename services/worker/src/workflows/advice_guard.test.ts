import { describe, expect, it } from 'vitest';
import { RunContext } from '../agent/run.js';
import { MemorySink } from '../agent/sink.js';
import { loadConfig } from '../config.js';
import { buildLLMClient } from '../llm/client.js';
import type { ChatRequest, ChatResult } from '../llm/types.js';
import { smallHousehold } from '../testing/fixtures.js';
import { FixedExternalApis } from '../tools/external.js';
import { buildRegistry } from '../tools/index.js';
import { adviceFacts, adviceGuard, adviceViolations } from './advice_guard.js';

const BAD = 'Your biggest gap is $188.45. Next, move that $188.45 into your $500 crypto purchase plan this month.';
const FALLBACK = 'Found 1 goal(s).';

function ctx(llm?: { chat(req: ChatRequest): Promise<ChatResult>; hasProvider?(id: string): boolean }, chat?: { role: string; author: string; text: string; created_at: string }[]) {
  const sink = new MemorySink();
  const data = smallHousehold(chat ? { chat } : {});
  const run = new RunContext({ runId: 'r1', workflow: 'huddle', householdId: 'hh_test', subjectId: 'x' }, { sink, llm: (llm ? { hasProvider: () => true, ...llm } : buildLLMClient(loadConfig({}))) as never, registry: buildRegistry(), toolContext: { data, external: new FixedExternalApis() }, primary: { provider: 'local', model: 'm' } });
  return Object.assign(run, { sink });
}
const reply = (content: string): ChatResult => ({ content, toolCalls: [], provider: 'nvidia', model: 'nemotron-test', latencyMs: 1, tokensIn: 1, tokensOut: 1 });

describe('adviceViolations (offline rules)', () => {
  it('catches telling the family to move money into crypto', () => {
    expect(adviceViolations(BAD)).toEqual([expect.stringContaining('move or transfer money')]);
  });
  it('allows warnings about the same things', () => {
    expect(adviceViolations('Crypto can lose value fast, so talk to a licensed advisor before buying any. Do not move your emergency fund.')).toEqual([]);
  });
  it('allows ordinary feasible advice', () => {
    expect(adviceViolations('Set aside $400 a month and the van fits by spring. Your savings cover the down payment.')).toEqual([]);
  });
  it('flags guarantees but not "no guarantee"', () => {
    expect(adviceViolations('This plan is guaranteed to work.').length).toBe(1);
    expect(adviceViolations('There is no guarantee the rate stays low.')).toEqual([]);
  });
});

describe('adviceGuard', () => {
  it('passes clean advice through untouched (offline provider: the rules are the whole check)', async () => {
    const run = ctx();
    expect(await adviceGuard(run, { agent: 'reconciler', kind: 'closing note', text: 'Set aside $50 a month toward the trip.', fallback: FALLBACK })).toBe('Set aside $50 a month toward the trip.');
  });

  it('replaces bad advice with the deterministic fallback when nothing safe can be written', async () => {
    const run = ctx();
    expect(await adviceGuard(run, { agent: 'reconciler', kind: 'closing note', text: BAD, fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('uses the reviewer\'s feasible revision when it passes the rules, and traces the check', async () => {
    const llm = { chat: async (req: ChatRequest) => reply(req.task === 'advice.review' ? JSON.stringify({ ok: false, problems: ['moves money into crypto'], revised: 'Your monthly surplus is small, so keep the $188.45 for the card and talk bigger ideas over with an advisor.' }) : 'x') };
    const run = ctx(llm);
    const out = await adviceGuard(run, { agent: 'reconciler', kind: 'closing note', text: BAD, fallback: FALLBACK });
    expect(out).toContain('talk bigger ideas over with an advisor');
    await run.drain();
    expect(run.sink.traces.some((t) => t.title.includes('Advice revised') && t.provider === 'nvidia')).toBe(true);
  });

  it('rejects a revision that is itself unsafe', async () => {
    const llm = { chat: async () => reply(JSON.stringify({ ok: false, problems: ['x'], revised: 'Move $200 into crypto and double it this month.' })) };
    expect(await adviceGuard(ctx(llm), { agent: 'reconciler', kind: 'closing note', text: BAD, fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('survives a reviewer outage and still enforces the rules', async () => {
    const llm = { chat: async () => { throw new Error('rate limited'); } };
    expect(await adviceGuard(ctx(llm), { agent: 'reconciler', kind: 'closing note', text: BAD, fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('flags figures that are not in the data when asked to', async () => {
    const run = ctx();
    expect(await adviceGuard(run, { agent: 'reconciler', kind: 'closing note', text: 'You will save $123,456 a month.', figures: true, fallback: FALLBACK })).toBe(FALLBACK);
  });
});

describe('adviceFacts (memory of earlier chats and goals)', () => {
  it('carries the recent chat and the numbers a plan must fit inside', () => {
    const facts = adviceFacts(ctx(undefined, [{ role: 'user', author: 'Ana', text: 'Can we afford a van?', created_at: '2026-11-01T00:00:00Z' }]));
    expect(facts.recent_chat).toEqual([{ role: 'user', text: 'Can we afford a van?' }]);
    expect(typeof facts.monthly_surplus).toBe('number');
    expect(typeof facts.savings_balance).toBe('number');
  });
});
