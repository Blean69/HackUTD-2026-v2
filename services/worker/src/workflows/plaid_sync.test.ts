import { describe, expect, it } from 'vitest';
import { MemorySink } from '../agent/sink.js';
import { RunContext } from '../agent/run.js';
import { loadConfig } from '../config.js';
import { buildLLMClient, LLMClient } from '../llm/client.js';
import type { ChatRequest, ChatResult, LLMProvider } from '../llm/types.js';
import { MemoryPlaidStore } from '../plaid/store.js';
import type { PlaidRuntime } from '../plaid/runtime.js';
import { PlaidApiError } from '../plaid/types.js';
import { smallHousehold } from '../testing/fixtures.js';
import { CONFIG, FakePlaid, notReady, page, pAcct, ptxn } from '../testing/plaid_fake.js';
import { FixedExternalApis } from '../tools/external.js';
import { buildRegistry } from '../tools/index.js';
import { createPlaidSyncWorkflow } from './plaid_sync.js';
import type { JobInfo } from './types.js';

const HH = 'hh_test';
const job: JobInfo = { id: 7n, workflow: 'plaid_sync', householdId: HH, subjectId: HH, input: {} };

function setup(over: { llm?: LLMClient; pollAttempts?: number } = {}) {
  const store = new MemoryPlaidStore();
  const client = new FakePlaid();
  const sleeps: number[] = [];
  const rt: PlaidRuntime = { config: CONFIG, client, store, sleep: async (ms) => void sleeps.push(ms), pollAttempts: over.pollAttempts ?? 4, pollMs: 1000 };
  const sink = new MemorySink();
  const run = new RunContext({ runId: 'run_7', workflow: 'plaid_sync', householdId: HH, subjectId: HH }, { sink, llm: over.llm ?? buildLLMClient(loadConfig({})), registry: buildRegistry(), toolContext: { data: smallHousehold(), external: new FixedExternalApis() }, primary: { provider: 'local', model: 'keystone-rules-v1' } });
  const wf = createPlaidSyncWorkflow(() => rt);
  const exec = async () => {
    const out = await wf.run(run, job, { transcript: async () => [] });
    await run.drain();
    return out;
  };
  return { store, client, sink, run, exec, rt, sleeps };
}

const addItem = (store: MemoryPlaidStore, cursor = '') => store.itemsById.set('item_fake_1', { itemId: 'item_fake_1', householdId: HH, accessToken: 'access-sandbox-SECRET-TOKEN', institutionId: 'ins_109508', institutionName: 'First Platypus Bank', cursor });

const types = (sink: MemorySink) => sink.traces.map((t) => t.type);

function manyTxns(n: number) {
  return Array.from({ length: n }, (_v, i) => ptxn(`t${i}`, 'chk00000', 5 + (i % 7), `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, `MERCHANT ${i}`, ['GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE']));
}

describe('plaid_sync workflow', () => {
  it('first sync: plan, a tool_call/tool_result per Plaid call, mapping, batched writes, recompute, ok + final summary', async () => {
    const t = setup();
    addItem(t.store);
    t.client.syncScript = [
      page({ added: manyTxns(450).slice(0, 300), next_cursor: 'c1', has_more: true }),
      page({ added: manyTxns(450).slice(300), next_cursor: 'c2', has_more: false }),
    ];
    const out = await t.exec();

    // trace shape
    const ty = types(t.sink);
    expect(ty[0]).toBe('plan'); // run_started is emitted by the runner before the workflow
    expect(ty.at(-1)).toBe('final');
    const calls = t.sink.traces.filter((e) => e.type === 'tool_call').map((e) => JSON.parse(e.dataJson).tool as string);
    expect(calls).toEqual(['plaid_accounts_get', 'plaid_liabilities_get', 'plaid_transactions_sync', 'plaid_transactions_sync', 'agent_upsert_accounts', 'agent_upsert_txns', 'agent_upsert_txns', 'agent_upsert_txns', 'agent_save_plaid_item', 'recompute_household']);
    expect(t.sink.traces.filter((e) => e.type === 'tool_call').length).toBe(t.sink.traces.filter((e) => e.type === 'tool_result').length);
    // every call is immediately followed by its result
    t.sink.traces.forEach((e, i) => {
      if (e.type === 'tool_call') expect(t.sink.traces[i + 1]!.type).toBe('tool_result');
    });
    expect(t.sink.traces.map((e) => e.seq)).toEqual(t.sink.traces.map((_e, i) => i));
    for (const e of t.sink.traces) {
      expect(e.dataJson.length).toBeLessThanOrEqual(4096);
      expect(e.dataJson).not.toContain('SECRET-TOKEN');
      expect(e.title).not.toContain('SECRET-TOKEN');
      expect(e.provider).toBeTruthy();
    }
    expect(t.sink.traces.at(-1)!.title).toBe('Linked First Platypus Bank: 10 accounts, 450 transactions');
    expect(out).toMatchObject({ items: 1, accounts: 10, txns: 450 });

    // pages followed the cursor, starting from the beginning
    expect(t.client.syncCursors).toEqual(['', 'c1']);
    // accounts mapped to our 8 types with the right ids
    const byId = (id: string) => t.store.accounts.get(`acct_plaid_${id}`)!;
    expect(byId('chk00000').type).toBe('checking');
    expect(byId('sav00000').type).toBe('savings');
    expect(byId('cd000000').type).toBe('cd');
    expect(byId('mm000000').type).toBe('savings');
    expect(byId('cc000000')).toMatchObject({ type: 'credit_card', balance: 410, credit_limit: 2000, rate_pct: 27.95 });
    expect(byId('k4010000').type).toBe('ira');
    expect(byId('ira00000').type).toBe('ira');
    expect(byId('brk00000').type).toBe('savings'); // ambiguous: local fallback keeps the default
    expect(byId('mtg00000')).toMatchObject({ type: 'mortgage', balance: 56302.06, monthly_payment: 3141.54 });
    expect(byId('stu00000')).toMatchObject({ type: 'personal_loan', balance: 65262 });
    expect(t.store.accounts.size).toBe(10);
    // 450 txns in batches of 200
    expect(t.store.upsertTxnBatches).toEqual([200, 200, 50]);
    expect(t.store.txns.size).toBe(450);
    const first = [...t.store.txns.values()][0]!;
    expect(first.id.startsWith('txn_plaid_')).toBe(true);
    expect(first.amount).toBeLessThan(0);
    // cursor saved last (after the data), token untouched, then recompute
    expect(t.store.itemsById.get('item_fake_1')).toMatchObject({ cursor: 'c2', accessToken: 'access-sandbox-SECRET-TOKEN', institutionName: 'First Platypus Bank' });
    expect(t.store.calls.indexOf('saveItem')).toBeGreaterThan(t.store.calls.lastIndexOf('upsertTxns'));
    expect(t.store.recomputed).toEqual([HH]);
    // bank_connection: syncing, then ok with counts
    expect(t.store.connectionLog.map((c) => c.status)).toEqual(['syncing', 'ok']);
    expect(t.store.connections.get('item_fake_1')).toMatchObject({ status: 'ok', accountsCount: 10, txnsCount: 450, institutionName: 'First Platypus Bank' });
  });

  it('polls a fresh item until Plaid has loaded the history, then continues from the cursor it got', async () => {
    const t = setup();
    addItem(t.store);
    t.client.syncScript = [
      page({ next_cursor: '', transactions_update_status: 'NOT_READY' }),
      page({ added: manyTxns(5).slice(0, 2), next_cursor: 'c1', transactions_update_status: 'INITIAL_UPDATE_COMPLETE' }),
      page({ added: manyTxns(5).slice(2), next_cursor: 'c2', transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' }),
    ];
    await t.exec();
    expect(t.client.syncCursors).toEqual(['', '', 'c1']);
    expect(t.sleeps).toEqual([1000, 1000]);
    expect(t.store.txns.size).toBe(5);
    expect(t.store.itemsById.get('item_fake_1')!.cursor).toBe('c2');
    expect(t.sink.traces.filter((e) => e.type === 'message' && /still loading/.test(e.title)).length).toBe(2);
  });

  it('keeps polling a fresh item whose status says complete but which has produced no cursor yet (seen on the live sandbox)', async () => {
    const t = setup();
    addItem(t.store);
    t.client.syncScript = [
      page({ next_cursor: '', transactions_update_status: 'NOT_READY' }),
      page({ next_cursor: '', transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' }), // 0 added, no cursor: Plaid is still generating
      page({ added: manyTxns(5), next_cursor: 'c1', transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' }),
    ];
    await t.exec();
    expect(t.client.count('transactionsSync')).toBe(3);
    expect(t.store.txns.size).toBe(5);
    expect(t.store.itemsById.get('item_fake_1')!.cursor).toBe('c1');
  });

  it('treats PRODUCT_NOT_READY on a fresh item as "wait and retry", and gives up gracefully after the poll limit', async () => {
    const t = setup({ pollAttempts: 3 });
    addItem(t.store);
    t.client.syncScript = [notReady()];
    const out = await t.exec();
    expect(t.client.count('transactionsSync')).toBe(3);
    expect(t.store.accounts.size).toBe(10); // accounts still arrive
    expect(t.store.txns.size).toBe(0);
    expect(t.store.connections.get('item_fake_1')).toMatchObject({ status: 'ok', accountsCount: 10, txnsCount: 0 });
    expect(t.store.itemsById.get('item_fake_1')!.cursor).toBe(''); // not advanced: next sync starts over
    expect(out).toMatchObject({ items: 1 });
    expect(t.sink.traces.some((e) => /not available.*PRODUCT_NOT_READY/.test(e.title))).toBe(true);
  });

  it('tolerates /liabilities/get failing (PRODUCT_NOT_READY / not supported)', async () => {
    const t = setup();
    addItem(t.store);
    t.client.liab = new PlaidApiError('not supported', 'PRODUCTS_NOT_SUPPORTED', 'ITEM_ERROR', 400);
    t.client.syncScript = [page({ added: manyTxns(3), next_cursor: 'c1' })];
    await t.exec();
    const res = t.sink.traces.filter((e) => e.type === 'tool_result').map((e) => JSON.parse(e.dataJson));
    expect(res.find((r) => r.tool === 'plaid_liabilities_get')).toMatchObject({ ok: false, code: 'PRODUCTS_NOT_SUPPORTED' });
    expect(t.store.accounts.get('acct_plaid_mtg00000')).toMatchObject({ type: 'mortgage', balance: 56302.06 });
    expect(t.store.accounts.get('acct_plaid_mtg00000')!.rate_pct).toBeUndefined();
    expect(t.store.connections.get('item_fake_1')!.status).toBe('ok');
  });

  it('incremental sync: starts from the saved cursor, upserts modified, removes removed, reports deltas', async () => {
    const t = setup();
    addItem(t.store, 'saved-cursor');
    // pre-existing rows from an earlier sync
    for (const id of ['old1', 'old2']) t.store.txns.set(`txn_plaid_${id}`, { id: `txn_plaid_${id}`, household_id: HH, account_id: 'acct_plaid_chk00000', date: '2026-10-01', amount: -5, merchant: 'x', category: 'other', description: '', is_recurring: false });
    t.client.syncScript = [page({ added: [ptxn('new1', 'chk00000', 12.5, '2026-11-03', 'COFFEE')], modified: [ptxn('old1', 'chk00000', 6, '2026-10-01', 'x')], removed: [{ transaction_id: 'old2' }], next_cursor: 'next-cursor' })];
    await t.exec();
    expect(t.client.syncCursors).toEqual(['saved-cursor']);
    expect(t.store.txns.has('txn_plaid_old2')).toBe(false);
    expect(t.store.txns.get('txn_plaid_old1')!.amount).toBe(-6);
    expect(t.store.txns.get('txn_plaid_new1')!.amount).toBe(-12.5);
    expect(t.store.removeBatches).toEqual([['txn_plaid_old2']]);
    expect(t.store.itemsById.get('item_fake_1')!.cursor).toBe('next-cursor');
    expect(t.store.connectionLog.map((c) => c.status)).toEqual(['ok']); // request_bank_sync already flipped it to syncing
    expect(t.store.connections.get('item_fake_1')).toMatchObject({ txnsCount: 2 });
    expect(t.sink.traces.at(-1)!.title).toBe('Synced First Platypus Bank: 10 accounts, 2 transactions (+1 new, 1 changed, -1 removed)');
  });

  it('restarts paging when Plaid reports a mutation during pagination', async () => {
    const t = setup();
    addItem(t.store, 'cur0');
    t.client.syncScript = [
      page({ added: manyTxns(2), next_cursor: 'p1', has_more: true }),
      new PlaidApiError('mutation', 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'TRANSACTIONS_ERROR', 400),
      page({ added: manyTxns(4), next_cursor: 'final' }),
    ];
    await t.exec();
    expect(t.client.syncCursors).toEqual(['cur0', 'p1', 'cur0']);
    expect(t.store.txns.size).toBe(4); // nothing from the aborted attempt leaked in
    expect(t.store.itemsById.get('item_fake_1')!.cursor).toBe('final');
  });

  it('skips transactions on accounts Plaid does not list (the reducer would reject the whole batch)', async () => {
    const t = setup();
    addItem(t.store);
    t.client.accounts = [pAcct('chk00000', 'depository', 'checking', 100)];
    t.client.syncScript = [page({ added: [ptxn('a', 'chk00000', 1, '2026-11-01', 'ok'), ptxn('b', 'gone0000', 1, '2026-11-01', 'orphan')], next_cursor: 'c' })];
    await t.exec();
    expect([...t.store.txns.keys()]).toEqual(['txn_plaid_a']);
  });

  it('asks the fast model only about ambiguous accounts, and never lets it turn a debt into an asset', async () => {
    const asked: ChatRequest[] = [];
    const scripted: LLMProvider = {
      id: 'nvidia',
      modelFor: () => 'nvidia/nemotron-3.5-lightning-30b-a3b',
      async call(req: ChatRequest): Promise<ChatResult> {
        const base = { provider: 'nvidia' as const, model: req.role === 'fast' ? 'nvidia/nemotron-3.5-lightning-30b-a3b' : 'nvidia/nemotron-3-super-120b-a12b', latencyMs: 80, tokensIn: 40, tokensOut: 20 };
        if (req.task === 'plaid_sync.plan') return { ...base, content: '1. Fetch accounts (Plaid /accounts/get)\n2. Map types\n3. Save', toolCalls: [] };
        asked.push(req);
        return {
          ...base,
          content: '',
          toolCalls: [{ id: 'c1', name: 'classify_accounts', arguments: JSON.stringify({ items: [{ account_id: 'hsa00000', type: 'savings', reason: 'An HSA is a tax-advantaged savings account.' }, { account_id: 'heloc000', type: 'checking', reason: 'wrongly an asset' }, { account_id: 'chk00000', type: 'cd', reason: 'not asked about' }] }) }],
        };
      },
    };
    const t = setup({ llm: new LLMClient([scripted]) });
    addItem(t.store);
    t.client.accounts = [pAcct('chk00000', 'depository', 'checking', 100), pAcct('hsa00000', 'depository', 'hsa', 900), pAcct('heloc000', 'loan', 'home equity', 40000)];
    t.client.syncScript = [page({ next_cursor: 'c' })];
    await t.exec();
    expect(asked.length).toBe(1);
    expect(asked[0]!.role).toBe('fast');
    const prompt = asked[0]!.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('hsa00000');
    expect(prompt).toContain('heloc000');
    expect(prompt).not.toContain('"account_id":"chk00000"'); // unambiguous accounts are not sent
    expect(t.store.accounts.get('acct_plaid_hsa00000')!.type).toBe('savings');
    expect(t.store.accounts.get('acct_plaid_heloc000')!.type).toBe('mortgage'); // the invalid answer was ignored, default kept
    expect(t.store.accounts.get('acct_plaid_chk00000')!.type).toBe('checking');
    const msg = t.sink.traces.find((e) => e.agent === 'account_mapper' && /Nemotron placed/.test(e.title))!;
    expect(msg.provider).toBe('nvidia');
    expect(msg.model).toContain('lightning');
    expect(t.sink.traces[0]!.provider).toBe('nvidia'); // the plan comes from the model
  });

  it('a Plaid failure marks the connection error with the message and fails the run', async () => {
    const t = setup();
    addItem(t.store);
    t.client.accountsError = new PlaidApiError('the login details of this item have changed', 'ITEM_LOGIN_REQUIRED', 'ITEM_ERROR', 400);
    await expect(t.exec()).rejects.toThrow(/ITEM_LOGIN_REQUIRED/);
    expect(t.store.connections.get('item_fake_1')).toMatchObject({ status: 'error' });
    expect(t.store.connections.get('item_fake_1')!.error).toMatch(/login details.*ITEM_LOGIN_REQUIRED/);
    expect(t.store.accounts.size).toBe(0);
    expect(t.sink.traces.some((e) => e.type === 'tool_result' && !JSON.parse(e.dataJson).ok)).toBe(true);
  });

  it('a failed write leaves the cursor where it was so the next run retries the same changes', async () => {
    const t = setup();
    addItem(t.store);
    t.client.syncScript = [page({ added: manyTxns(3), next_cursor: 'c9' })];
    t.store.failOn = 'upsertTxns';
    await expect(t.exec()).rejects.toThrow(/upsertTxns failed/);
    expect(t.store.itemsById.get('item_fake_1')!.cursor).toBe('');
    expect(t.store.connections.get('item_fake_1')!.status).toBe('error');
  });

  it('finishes quietly when the household has no linked bank, and errors clearly when Plaid is unconfigured', async () => {
    const t = setup();
    const out = await t.exec();
    expect(out).toEqual({ items: 0 });
    expect(t.sink.traces.at(-1)).toMatchObject({ type: 'final' });

    const u = setup();
    addItem(u.store);
    u.rt.client = null;
    u.rt.config = null;
    await expect(u.exec()).rejects.toThrow(/not configured/);
    expect(u.store.connections.get('item_fake_1')).toMatchObject({ status: 'error' });
  });

  // ---- onboarding: only the accounts the family selected ----------------------------------------------------------------

  it('imports only the selected accounts and their transactions, and says what was left out', async () => {
    const t = setup();
    addItem(t.store);
    t.store.selection.set('item_fake_1', new Set(['chk00000', 'sav00000']));
    t.client.syncScript = [
      page({
        added: [
          ptxn('t1', 'chk00000', 12.5, '2026-10-01', 'Kroger', ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES']),
          ptxn('t2', 'sav00000', -50, '2026-10-02', 'Transfer in', ['TRANSFER_IN', 'TRANSFER_IN_SAVINGS']),
          ptxn('t3', 'cc000000', 30, '2026-10-03', 'Chipotle', ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT']),
          ptxn('t4', 'mm000000', 5, '2026-10-04', 'Fee', ['BANK_FEES', 'BANK_FEES_ATM_FEES']),
        ],
        next_cursor: 'c1',
      }),
    ];
    const out = await t.exec();
    expect([...t.store.accounts.keys()].sort()).toEqual(['acct_plaid_chk00000', 'acct_plaid_sav00000']);
    expect([...t.store.txns.keys()].sort()).toEqual(['txn_plaid_t1', 'txn_plaid_t2']);
    expect(out).toMatchObject({ items: 1, accounts: 2, txns: 2 });
    const titles = t.sink.traces.map((e) => e.title);
    expect(titles.some((x) => /Importing 2 of 10 accounts/.test(x))).toBe(true);
    expect(titles.some((x) => /left out 2 on accounts the family did not select/.test(x))).toBe(true);
    expect(t.store.connections.get('item_fake_1')).toMatchObject({ status: 'ok', accountsCount: 2 });
    // the mapping step only saw the two kept accounts
    expect(t.sink.traces.find((e) => /^Mapped 2 accounts/.test(e.title))).toBeTruthy();
  });

  it('without a selection every account is imported, as before', async () => {
    const t = setup();
    addItem(t.store);
    t.client.syncScript = [page({ added: [ptxn('t1', 'chk00000', 12.5, '2026-10-01', 'Kroger')], next_cursor: 'c1' })];
    await t.exec();
    expect(t.store.accounts.size).toBe(10);
    expect(t.sink.traces.some((e) => /Importing \d+ of/.test(e.title))).toBe(false);
  });

  it('fails clearly when none of the selected accounts exist at the bank any more', async () => {
    const t = setup();
    addItem(t.store);
    t.store.selection.set('item_fake_1', new Set(['gone0000']));
    await expect(t.exec()).rejects.toThrow(/none of the 1 selected account exist/);
    expect(t.store.connections.get('item_fake_1')).toMatchObject({ status: 'error' });
    expect(t.store.accounts.size).toBe(0);
  });

  it('quietPolls: a fresh item is polled until a poll brings nothing new, because "complete" can arrive with only the first rows', async () => {
    const t = setup();
    t.rt.quietPolls = 1;
    addItem(t.store);
    const all = manyTxns(225);
    t.client.syncScript = [
      page({ added: all.slice(0, 38), next_cursor: 'c1' }), // HISTORICAL_UPDATE_COMPLETE, but only the first 38 rows
      page({ added: all.slice(38), next_cursor: 'c2' }),
      page({ next_cursor: 'c2' }), // quiet
    ];
    const out = await t.exec();
    expect(t.client.syncCursors).toEqual(['', 'c1', 'c2']);
    expect(t.sleeps).toEqual([1000, 1000]);
    expect(t.store.txns.size).toBe(225);
    expect(out).toMatchObject({ txns: 225 });
    expect(t.sink.traces.some((e) => /history is complete but just sent 38 more row/.test(e.title))).toBe(true);
    expect(t.sink.traces.some((e) => /had not finished/.test(e.title))).toBe(false);
  });

  it('quietPolls never loops forever: after the last attempt the rows we have are imported and the next sync continues', async () => {
    const t = setup({ pollAttempts: 3 });
    t.rt.quietPolls = 1;
    addItem(t.store);
    t.client.syncScript = [page({ added: manyTxns(10), next_cursor: 'c1' }), page({ modified: manyTxns(2), next_cursor: 'c2' })]; // the last page repeats and is never quiet
    await t.exec();
    expect(t.client.count('transactionsSync')).toBe(3);
    expect(t.store.txns.size).toBe(10);
    expect(t.sink.traces.some((e) => /had not finished/.test(e.title))).toBe(true);
  });
});
