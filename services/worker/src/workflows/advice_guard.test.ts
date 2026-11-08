import { describe, expect, it } from 'vitest';
import { RunContext } from '../agent/run.js';
import { MemorySink } from '../agent/sink.js';
import { loadConfig } from '../config.js';
import { buildLLMClient } from '../llm/client.js';
import type { ChatRequest, ChatResult } from '../llm/types.js';
import { smallHousehold } from '../testing/fixtures.js';
import { FixedExternalApis } from '../tools/external.js';
import { buildRegistry } from '../tools/index.js';
import { adviceFacts, adviceGuard, adviceViolations, parseVerdict } from './advice_guard.js';

const BAD = 'Your biggest gap is $188.45. Next, move that $188.45 into your $500 crypto purchase plan this month.';
const FALLBACK = 'Found 1 goal(s).';

function ctx(llm?: { chat(req: ChatRequest): Promise<ChatResult>; hasProvider?(id: string): boolean }, chat?: { role: string; author: string; text: string; created_at: string }[]) {
  const sink = new MemorySink();
  const data = smallHousehold(chat ? { chat } : {});
  const run = new RunContext({ runId: 'r1', workflow: 'huddle', householdId: 'hh_test', subjectId: 'x' }, { sink, llm: (llm ? { hasProvider: () => true, ...llm } : buildLLMClient(loadConfig({}))) as never, registry: buildRegistry(), toolContext: { data, external: new FixedExternalApis() }, primary: { provider: 'local', model: 'm' } });
  return Object.assign(run, { sink });
}
const reply = (content: string): ChatResult => ({ content, toolCalls: [], provider: 'nvidia', model: 'nemotron-test', latencyMs: 1, tokensIn: 1, tokensOut: 1 });

const MUST_BLOCK = [
  'Next, move that $188.45 into your $500 crypto purchase plan this month.',
  'Send $300 to your brother.', 'Pull $1,000 out of savings.', 'Moving your savings to a CD pays 4%.', 'Go all-in on Tesla.',
  'Put $2,000 in Dogecoin.', 'Put it into Solana.', 'Cash out your 401k to buy gold.', 'Use your savings to day trade.',
  'Take out a loan to invest in the market.', 'Open a margin account and buy stocks.', 'Here are some stock tips: buy NVDA.',
  'Bet on the Cowboys this week.', 'Try your luck at the casino.', 'You will definitely double your money.', 'This is a sure bet.', 'Returns are certain.',
  'Crypto can be volatile, but you should still buy Bitcoin with your savings.', 'Avoid fees and put your savings into Bitcoin.',
  'Reallocate $500 from your checking into a brokerage account.', 'Redirect your monthly surplus into Bitcoin.', 'Cash in your 401k to fund the second bakery.', 'Consider cashing out your IRA to pay for the equipment.', 'Dip into your retirement account to cover the lease.', 'Load up on Solana and Cardano.', 'Try forex trading to grow your savings faster.', 'Place a few sports bets on the game this weekend.', 'Hand over $500 to the caller to settle it.', 'Pay the $2,000 in gift cards the caller asked for.', 'Why not put $2,000 into Dogecoin?', 'Why not move $500 from checking into savings?', "Don't wait, buy Bitcoin today.", 'Not buying Bitcoin now would be a mistake.', "You'd be foolish not to buy Bitcoin.", 'I would invest in Nvidia.', 'Put your tax refund toward Dogecoin.', 'Allocate 20% of your savings to crypto.', 'Open a margin account and buy more Tesla.', "You can't go wrong with Bitcoin.", 'Gold is a sure winner, so stock up on it.', 'Convert your savings to USDT and trade on Binance.',
  "It's a no-brainer: buy Tesla.", 'Buy some GME before Friday.',
  'This plan is guaranteed to work.', 'You should transfer $500 from savings to checking.', 'The next step is to move your emergency fund into stocks.',
];
const MUST_PASS = [
  'Crypto can lose value fast, so talk to a licensed advisor before buying any. Do not move your emergency fund.',
  'Set aside $400 a month and the van fits by spring. Your savings cover the down payment.',
  'There is no guarantee the rate stays low.', "We can't guarantee returns.", 'The guarantee on this CD is FDIC insured.',
  'A wire transfer fee of $15 applies.', 'If you shift your budget, you could save $200.', 'Move on to the next goal: savings of $5,000.',
  'Putting money into crypto is risky and not advised.', 'I would not recommend buying Bitcoin with your savings.', "Don't put your savings into crypto.",
  'Gambling is risky, so we would not back it.', 'Pay down the Rewards Visa first; it costs you the most in interest.',
  'Your savings account holds $12,000, which covers about three months of bills.', 'Talk it over with a licensed advisor before deciding.',
  'Wire transfers usually cost $25 to send, while ACH transfers are often free.', 'The payment is guaranteed to post on the due date if you schedule it by the 10th.', 'Auto-pay guarantees you will never miss a due date.', 'Your deposit is guaranteed by the FDIC up to $250,000.', 'Paying the card in full is risk-free in the sense that it avoids interest.', "You can't lose your rate lock if you close by the 30th.", "It's a sure thing that the Visa interest will keep growing if you only pay the minimum.", 'Go all in on the debt snowball: smallest balance first.', 'A day trading platform is not a fit; the numbers say to focus on the Visa first.', 'Investing in an index fund is a long-term choice; talk to a licensed advisor first.', 'You should withdraw nothing from the emergency fund unless it is a true emergency.', 'Rather than buying crypto, pay down the Visa.', 'It is not safe to put the whole fund into one stock.', 'Nobody can guarantee returns on crypto.', 'No investment is risk-free.', 'There is no such thing as a guaranteed return.', 'Transfer fees at your bank are $3 per transfer.', 'Send the $180 payment to the electric company by Friday.', 'Betting on a sure thing is how people lose savings.', "You can't lose your coverage if you pay on time.", 'A guaranteed-issue life policy has higher premiums.', 'A bet on the second location is a big commitment, so check the numbers first.',
  'Buy the Visa payoff first, then the rest.', 'Pay off the VISA before the March due date.',
  'Pause and call the bank on a number you already know before paying anyone.', 'Check whether the loan payment fits your monthly surplus.',
];

describe('adviceViolations (offline rules)', () => {
  it.each(MUST_BLOCK)('blocks: %#', (t) => expect(adviceViolations(t).length).toBeGreaterThan(0));
  it.each(MUST_PASS)('allows: %#', (t) => expect(adviceViolations(t)).toEqual([]));
});

describe('parseVerdict (strict)', () => {
  it('reads a clean verdict and one with trailing prose containing braces', () => {
    expect(parseVerdict('{"ok":false,"problems":["x"],"revised":"y"} (note {see})')).toEqual({ ok: false, problems: ['x'], revised: 'y' });
    expect(parseVerdict('Sure! {"ok":true,"problems":[],"revised":""}')).toMatchObject({ ok: true });
  });
  it('never treats a malformed or ambiguous verdict as a pass', () => {
    for (const bad of ['{"ok":"false"}', '{"ok":null}', '{"problems":["bad"]}', '{"ok":false', 'no json here', '']) expect(parseVerdict(bad)).toBeNull();
    expect(parseVerdict('{"ok":true,"problems":["but this is wrong"],"revised":""}')).toMatchObject({ ok: false });
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
    const out = await adviceGuard(run, { agent: 'reconciler', kind: 'closing note', text: BAD, sources: [{ gap: 188.45 }], fallback: FALLBACK });
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

describe('adviceGuard: fail-closed behaviour', () => {
  it('retries a malformed verdict once, then says honestly that only the rules ran', async () => {
    let calls = 0;
    const llm = { chat: async () => { calls++; return reply('I think it is fine {maybe}'); } };
    const run = ctx(llm);
    expect(await adviceGuard(run, { agent: 'reconciler', kind: 'closing note', text: 'Set aside $50 a month toward the trip.', fallback: FALLBACK })).toBe('Set aside $50 a month toward the trip.');
    await run.drain();
    expect(calls).toBe(2);
    expect(run.sink.traces.some((t) => t.title.includes('reviewer unavailable') && !t.title.includes('passed'))).toBe(true);
  });

  it('a malformed verdict does not rescue bad advice: the rules still replace it', async () => {
    const llm = { chat: async () => reply('{"ok":"false"}') };
    expect(await adviceGuard(ctx(llm), { agent: 'reconciler', kind: 'closing note', text: BAD, fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('a rewrite that comes back unchanged is not shipped as "revised"', async () => {
    const llm = { chat: async (req: ChatRequest) => reply(req.task === 'advice.review' ? JSON.stringify({ ok: false, problems: ['bad'], revised: '' }) : BAD) };
    expect(await adviceGuard(ctx(llm), { agent: 'reconciler', kind: 'closing note', text: BAD, fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('a revision with a figure nobody has is rejected even when figures:false', async () => {
    const llm = { chat: async (req: ChatRequest) => reply(req.task === 'advice.review' ? JSON.stringify({ ok: false, problems: ['bad'], revised: 'Save $123,456 a month and you are fine.' }) : 'Save $123,456 a month and you are fine.') };
    expect(await adviceGuard(ctx(llm), { agent: 'coach', kind: 'answer', text: BAD, fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('the reviewer sees the sources it is given (tool results), so correct figures are not "unsupported"', async () => {
    let seen = '';
    const llm = { chat: async (req: ChatRequest) => { seen = JSON.stringify(req.messages); return reply('{"ok":true,"problems":[],"revised":""}'); } };
    await adviceGuard(ctx(llm), { agent: 'coach', kind: 'answer', text: 'Your Rewards Visa owes $1,558.81.', sources: [{ accounts: [{ nickname: 'Rewards Visa', balance: 1558.81 }] }], fallback: FALLBACK });
    expect(seen).toContain('1558.81');
  });
});

