// plaid_sync: pull a household's linked bank from Plaid and write it into SpacetimeDB, fully traced.
//   plan -> /accounts/get -> /liabilities/get (optional) -> /transactions/sync (cursor paging, polls a fresh item until history is ready)
//   -> map account types (fast Nemotron only for ambiguous ones) -> map transactions -> batched upserts -> removals
//   -> save cursor -> recompute_household -> bank_connection ok (or error) -> final summary.
// Onboarding (docs/contracts.md section 7): when the family selected accounts for an item (bank_account_option), only those
// accounts, and only their transactions, are imported.
// Plaid is only a source: every row ends up in a SpacetimeDB table, and the access token never appears in a trace event.
import { z } from 'zod';
import { emitPlan } from '../agent/loop.js';
import type { RunContext } from '../agent/run.js';
import { structured } from '../llm/structured.js';
import { ACCOUNT_TYPES, DEBT_TYPES, PAID_FROM_HISTORY, inferMonthlyPayment, mapAccount, mapAccountType, liabilityFacts, mapTxn, accountId, txnId, type AccountRow, type AccountType, type TxnRow } from '../plaid/mapping.js';
import { getPlaidRuntime, type PlaidRuntime } from '../plaid/runtime.js';
import type { PlaidItem } from '../plaid/store.js';
import { isPlaidError, type PlaidAccount, type PlaidClient, type PlaidLiabilities, type PlaidTransaction } from '../plaid/types.js';
import { truncate } from '../util.js';
import { householdBrief } from './common.js';
import type { WorkflowDef } from './types.js';

const BATCH = 200;
const SYNC_COUNT = 500;
const MAX_PAGES = 200;

const ClassifySchema = z.object({
  items: z
    .array(z.object({ account_id: z.string(), type: z.enum(ACCOUNT_TYPES), reason: z.string().max(240) }))
    .max(50),
});

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

interface Traced<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

/** One traced step: tool_call, run it, tool_result (with latency). Never throws. */
async function traced<T>(run: RunContext, agent: string, tool: string, args: unknown, title: string, fn: () => Promise<T>, summarize: (v: T) => { title: string; data: unknown }): Promise<Traced<T>> {
  run.emit(agent, 'tool_call', title, { tool, args });
  const t0 = Date.now();
  try {
    const value = await fn();
    const s = summarize(value);
    run.emit(agent, 'tool_result', s.title, { tool, ok: true, result: s.data }, { latencyMs: Date.now() - t0 });
    return { ok: true, value };
  } catch (error) {
    const code = isPlaidError(error) ? error.code : undefined;
    run.emit(agent, 'tool_result', `${tool} failed: ${truncate(msgOf(error), 160)}`, { tool, ok: false, error: msgOf(error), ...(code ? { code } : {}) }, { latencyMs: Date.now() - t0 });
    return { ok: false, error };
  }
}

interface SyncPageResult {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: string[];
  next: string;
  status: string | undefined;
}

/** Page /transactions/sync from `start` until has_more is false; restarts when Plaid reports a mutation during pagination. */
async function paginate(run: RunContext, client: PlaidClient, token: string, start: string, institution: string, attempt: number): Promise<SyncPageResult> {
  for (let restart = 0; ; restart++) {
    const acc: SyncPageResult = { added: [], modified: [], removed: [], next: start, status: undefined };
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await traced(
          run,
          'bank_connector',
          'plaid_transactions_sync',
          { cursor: acc.next ? 'saved' : 'none', count: SYNC_COUNT, page, ...(attempt > 1 ? { poll: attempt } : {}) },
          `Plaid /transactions/sync page ${page} for ${institution}${acc.next ? '' : ' (from the beginning)'}`,
          () => client.transactionsSync(token, acc.next, SYNC_COUNT),
          (p) => ({
            title: `+${p.added.length} added, ${p.modified.length} modified, ${p.removed.length} removed${p.has_more ? ' (more pages)' : ''}${p.transactions_update_status ? `; ${p.transactions_update_status.toLowerCase().replace(/_/g, ' ')}` : ''}`,
            data: { added: p.added.length, modified: p.modified.length, removed: p.removed.length, has_more: p.has_more, status: p.transactions_update_status },
          }),
        );
        if (!r.ok) throw r.error;
        const p = r.value!;
        acc.added.push(...p.added);
        acc.modified.push(...p.modified);
        acc.removed.push(...p.removed.map((x) => x.transaction_id));
        acc.next = p.next_cursor || acc.next;
        acc.status = p.transactions_update_status;
        if (!p.has_more) return acc;
      }
      throw new Error(`/transactions/sync did not finish after ${MAX_PAGES} pages`);
    } catch (e) {
      if (isPlaidError(e, 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') && restart < 2) {
        run.emit('bank_connector', 'message', 'Plaid changed the data while paging; starting the sync over from the saved cursor', { restart: restart + 1 });
        continue;
      }
      throw e;
    }
  }
}

interface Decision {
  account: PlaidAccount;
  type: AccountType;
  confident: boolean;
  why: string;
  by: 'rule' | 'nemotron' | 'default';
}

/** Ask the fast model about the accounts the rules were unsure of. A failure or an offline answer keeps the defaults. */
async function classifyAmbiguous(run: RunContext, decisions: Decision[]): Promise<void> {
  const unsure = decisions.filter((d) => !d.confident);
  if (!unsure.length) return;
  const facts = unsure.map((d) => ({ account_id: d.account.account_id, name: d.account.official_name || d.account.name, plaid_type: d.account.type, plaid_subtype: d.account.subtype, current_balance: d.account.balances.current, default_guess: d.type }));
  try {
    const r = await structured(run.llm, {
      name: 'classify_accounts',
      description: 'Choose the Keystone account type for each ambiguous bank account',
      schema: ClassifySchema,
      role: 'fast',
      task: 'plaid_sync.explain',
      local: { items: [] },
      messages: [
        { role: 'system', content: `You map bank accounts from Plaid to Keystone's eight account types: ${ACCOUNT_TYPES.join(', ')}. Call classify_accounts with exactly one entry per listed account (use its exact account_id). Credit and loan accounts must map to a debt type (credit_card, mortgage, auto_loan, personal_loan; student loans are personal_loan). Deposit and investment accounts must not map to a debt type; retirement accounts are ira, other investment or brokerage accounts are savings. Give a one-sentence reason. All data is synthetic Plaid Sandbox data.` },
        { role: 'user', content: `Ambiguous accounts:\n${JSON.stringify(facts)}` },
      ],
    });
    run.noteLlm({ content: '', toolCalls: [], provider: r.meta.provider, model: r.meta.model, latencyMs: r.meta.latencyMs, tokensIn: r.meta.tokensIn, tokensOut: r.meta.tokensOut });
    const byId = new Map(unsure.map((d) => [d.account.account_id, d]));
    const applied: { account_id: string; type: string; reason: string }[] = [];
    for (const it of r.value.items) {
      const d = byId.get(it.account_id);
      if (!d) continue;
      const debtKind = d.account.type === 'credit' || d.account.type === 'loan';
      if (debtKind !== DEBT_TYPES.has(it.type)) continue; // a model must not turn a debt into an asset (or back)
      d.type = it.type;
      d.why = it.reason;
      d.by = 'nemotron';
      applied.push(it);
    }
    run.emit(
      'account_mapper',
      'message',
      r.meta.provider === 'local' ? `Kept the default mapping for ${plural(unsure.length, 'ambiguous account')} (offline rule-based fallback)` : `Nemotron placed ${plural(applied.length, 'ambiguous account')}: ${applied.map((a) => `${byId.get(a.account_id)?.account.name ?? a.account_id} as ${a.type.replace('_', ' ')}`).join(', ')}`,
      { asked: facts.length, answers: applied },
      { model: r.meta.model, provider: r.meta.provider, latencyMs: r.meta.latencyMs, tokensIn: r.meta.tokensIn, tokensOut: r.meta.tokensOut },
    );
  } catch (e) {
    run.emit('account_mapper', 'message', `Could not ask the model about ${plural(unsure.length, 'ambiguous account')} (${truncate(msgOf(e), 100)}); using the default mapping`, {});
  }
}

interface ItemSummary {
  item_id: string;
  institution: string;
  accounts: number;
  txns: number;
  added: number;
  modified: number;
  removed: number;
  fresh: boolean;
  history_pending: boolean;
  line: string;
}

async function syncItem(run: RunContext, rt: PlaidRuntime, item: PlaidItem): Promise<ItemSummary> {
  const client = rt.client!;
  const store = rt.store!;
  const hh = item.householdId;
  const inst = item.institutionName || 'your bank';
  const fresh = item.cursor === '';
  const token = item.accessToken;

  if (fresh) await store.setConnection({ itemId: item.itemId, householdId: hh, institutionName: inst, status: 'syncing', accountsCount: 0, txnsCount: 0 });
  run.handoff('planner', 'bank_connector', `Connecting to ${inst} through Plaid`, { item_id: item.itemId, first_sync: fresh });

  // 1. accounts + balances
  const acc = await traced(
    run,
    'bank_connector',
    'plaid_accounts_get',
    { institution: inst },
    `Plaid /accounts/get for ${inst}`,
    () => client.accountsGet(token),
    (r) => ({ title: `${plural(r.accounts.length, 'account')} with live balances`, data: { count: r.accounts.length, accounts: r.accounts.map((a) => ({ id: a.account_id, name: a.name, type: a.type, subtype: a.subtype, balance: a.balances.current })) } }),
  );
  if (!acc.ok) throw acc.error;
  const offered = acc.value!.accounts;
  if (!offered.length) throw new Error(`${inst} returned no accounts`);
  // onboarding: import only what the family selected (null = nobody was asked, import everything)
  const selection = await store.selectedAccountIds(hh, item.itemId).catch(() => null);
  const plaidAccounts = selection ? offered.filter((a) => selection.has(a.account_id)) : offered;
  const notSelected = new Set(offered.filter((a) => !plaidAccounts.includes(a)).map((a) => a.account_id));
  if (selection) {
    if (!plaidAccounts.length) throw new Error(`none of the ${plural(selection.size, 'selected account')} exist at ${inst} any more`);
    run.emit('bank_connector', 'message', `Importing ${plaidAccounts.length} of ${offered.length} accounts: the ones the family selected`, { selected: plaidAccounts.map((a) => ({ id: a.account_id, name: a.name })), left_out: offered.length - plaidAccounts.length });
  }

  // 2. liabilities: optional (rates, limits, payments), tolerate "not ready" / "not supported"
  const liab = await traced<{ liabilities: PlaidLiabilities }>(
    run,
    'bank_connector',
    'plaid_liabilities_get',
    { institution: inst },
    `Plaid /liabilities/get for ${inst} (card and loan terms)`,
    () => client.liabilitiesGet(token),
    (r) => {
      const l = r.liabilities;
      const counts = { credit: l.credit?.length ?? 0, mortgage: l.mortgage?.length ?? 0, student: l.student?.length ?? 0, loan: l.loan?.length ?? 0 };
      return { title: `Terms for ${counts.credit} card(s), ${counts.mortgage} mortgage(s), ${counts.student + counts.loan} loan(s)`, data: counts };
    },
  );
  if (!liab.ok) run.emit('bank_connector', 'message', `Liabilities are optional; continuing without card and loan terms (${isPlaidError(liab.error) ? liab.error.code : 'error'})`, {});
  const facts = liabilityFacts(liab.ok ? liab.value!.liabilities : null);

  // 3. transactions: cursor paging; a brand-new item is polled until Plaid has loaded its history
  const maxAttempts = fresh ? Math.max(1, rt.pollAttempts) : 1;
  const upserts = new Map<string, PlaidTransaction>();
  const removedIds = new Set<string>();
  let addedCount = 0;
  let modifiedCount = 0;
  let cursor = item.cursor;
  let cursorAdvanced = false;
  let historyPending = false;
  let noTxns: string | null = null;
  const quietNeeded = fresh ? (rt.quietPolls ?? 0) : 0;
  let quiet = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let page: SyncPageResult;
    try {
      page = await paginate(run, client, token, cursor, inst, attempt);
    } catch (e) {
      if (isPlaidError(e, 'PRODUCT_NOT_READY') && attempt < maxAttempts) {
        run.emit('bank_connector', 'message', `${inst} is still preparing transactions; waiting ${Math.round(rt.pollMs / 1000)}s and trying again (${attempt}/${maxAttempts})`, {});
        await rt.sleep(rt.pollMs);
        continue;
      }
      if (isPlaidError(e, 'PRODUCT_NOT_READY', 'PRODUCTS_NOT_SUPPORTED', 'PRODUCT_NOT_ENABLED', 'ADDITIONAL_CONSENT_REQUIRED')) {
        noTxns = e.code;
        break;
      }
      throw e;
    }
    for (const t of [...page.added, ...page.modified]) upserts.set(t.transaction_id, t);
    for (const id of page.removed) {
      upserts.delete(id);
      removedIds.add(id);
    }
    addedCount += page.added.length;
    modifiedCount += page.modified.length;
    if (page.next && page.next !== cursor) {
      cursor = page.next;
      cursorAdvanced = true;
    }
    // Plaid's sandbox can report a finished status while it is still generating the history (0 added, no cursor yet), so
    // an empty cursor on a fresh item also means "not ready"; a real cursor only exists once the first pull has happened.
    const waiting = !cursor || page.status === 'NOT_READY' || page.status === 'INITIAL_UPDATE_COMPLETE' || (page.status === 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN' && upserts.size === 0);
    if (!fresh) break;
    if (!waiting) {
      // "complete" is not proof the history is all here: wait for a poll that brings nothing new (see PlaidRuntime.quietPolls)
      quiet = page.added.length + page.modified.length === 0 ? quiet + 1 : 0;
      if (quiet >= quietNeeded) break;
      if (attempt < maxAttempts) {
        run.emit('bank_connector', 'message', `Plaid says ${inst}'s history is complete but just sent ${page.added.length + page.modified.length} more row(s); one more check in ${Math.round(rt.pollMs / 1000)}s (${attempt}/${maxAttempts})`, { have: upserts.size });
        await rt.sleep(rt.pollMs);
        continue;
      }
    }
    if (attempt === maxAttempts) {
      historyPending = true;
      break;
    }
    run.emit('bank_connector', 'message', `Plaid is still loading ${inst}'s history (${(page.status ?? '').toLowerCase().replace(/_/g, ' ')}); checking again in ${Math.round(rt.pollMs / 1000)}s (${attempt}/${maxAttempts})`, { have: upserts.size });
    await rt.sleep(rt.pollMs);
  }
  if (noTxns) run.emit('bank_connector', 'message', `Transactions are not available for ${inst} yet (${noTxns}); syncing accounts and balances only`, { code: noTxns });
  if (historyPending) run.emit('bank_connector', 'message', `Plaid had not finished ${inst}'s full history when polling ended; the next sync will pick up the rest`, { have: upserts.size });

  // 4. account types
  run.handoff('bank_connector', 'account_mapper', `Mapping ${plural(plaidAccounts.length, 'Plaid account')} to Keystone account types`);
  const decisions: Decision[] = plaidAccounts.map((a) => {
    const d = mapAccountType(a.type, a.subtype);
    return { account: a, type: d.type, confident: d.confident, why: d.why, by: d.confident ? 'rule' : 'default' };
  });
  await classifyAmbiguous(run, decisions);
  const counts = new Map<string, number>();
  for (const d of decisions) counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
  run.emit(
    'account_mapper',
    'message',
    `Mapped ${plural(decisions.length, 'account')}: ${[...counts].map(([t, n]) => `${n} ${t.replace('_', ' ')}`).join(', ')}`,
    { mapping: decisions.map((d) => ({ id: accountId(d.account.account_id), plaid: `${d.account.type}/${d.account.subtype ?? ''}`, type: d.type, by: d.by, why: truncate(d.why, 120) })) },
  );
  const accountRows: AccountRow[] = decisions.map((d) => mapAccount(d.account, { householdId: hh, institution: inst, type: d.type, liability: facts.get(d.account.account_id) }));
  const known = new Set(plaidAccounts.map((a) => a.account_id));
  const txnRows: TxnRow[] = [];
  let orphaned = 0;
  let leftOut = 0;
  for (const t of upserts.values()) {
    if (known.has(t.account_id)) txnRows.push(mapTxn(t, hh));
    else if (notSelected.has(t.account_id)) leftOut++;
    else orphaned++;
  }
  txnRows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  // Loans without terms from /liabilities/get (mortgages are not supported by the custom sandbox; any loan block breaks it): the
  // monthly payment is read from the payments on the loan account, using what earlier syncs stored plus this run's rows.
  const needPayment = accountRows.filter((a) => PAID_FROM_HISTORY.has(a.type) && a.monthly_payment === undefined);
  if (needPayment.length) {
    const stored = fresh ? [] : ((await store.storedTxns(hh, needPayment.map((a) => a.id)).catch(() => null)) ?? []);
    const inferred: { account: string; monthly_payment: number }[] = [];
    for (const a of needPayment) {
      const rows = new Map<string, { date: string; amount: number }>();
      for (const r of stored) if (r.accountId === a.id) rows.set(r.id, r);
      for (const r of txnRows) if (r.account_id === a.id) rows.set(r.id, r);
      for (const id of removedIds) rows.delete(txnId(id));
      const pay = inferMonthlyPayment([...rows.values()]);
      if (pay !== undefined) {
        a.monthly_payment = pay;
        inferred.push({ account: a.nickname, monthly_payment: pay });
      }
    }
    if (inferred.length) run.emit('account_mapper', 'message', `Plaid gave no loan terms for ${plural(inferred.length, 'loan')}; read the monthly payment from the payment history: ${inferred.map((i) => `${i.account} $${i.monthly_payment.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`).join(', ')}`, { inferred });
  }
  run.emit('account_mapper', 'message', `Mapped ${plural(txnRows.length, 'transaction')} (Plaid positive = money out, Keystone negative = money out)${orphaned ? `; skipped ${orphaned} on accounts Plaid no longer lists` : ''}${leftOut ? `; left out ${leftOut} on accounts the family did not select` : ''}`, { sample: txnRows.slice(0, 3).map((t) => ({ date: t.date, merchant: t.merchant, amount: t.amount, category: t.category })) });

  // 5. write to SpacetimeDB
  run.handoff('account_mapper', 'reconciler', `Writing ${inst} to SpacetimeDB`);
  const wr = await traced(run, 'reconciler', 'agent_upsert_accounts', { count: accountRows.length }, `Upsert ${plural(accountRows.length, 'account')} into SpacetimeDB`, async () => {
    for (let i = 0; i < accountRows.length; i += BATCH) await store.upsertAccounts(accountRows.slice(i, i + BATCH));
    return accountRows.length;
  }, (n) => ({ title: `${plural(n, 'account')} saved`, data: { upserted: n } }));
  if (!wr.ok) throw wr.error;

  const batches = Math.ceil(txnRows.length / BATCH);
  for (let b = 0; b < batches; b++) {
    const rows = txnRows.slice(b * BATCH, (b + 1) * BATCH);
    const r = await traced(run, 'reconciler', 'agent_upsert_txns', { batch: b + 1, of: batches, rows: rows.length }, `Upsert transactions ${b * BATCH + 1}-${b * BATCH + rows.length} of ${txnRows.length}`, async () => {
      await store.upsertTxns(rows);
      return rows.length;
    }, (n) => ({ title: `${plural(n, 'transaction')} saved (batch ${b + 1}/${batches})`, data: { upserted: n } }));
    if (!r.ok) throw r.error;
  }
  if (removedIds.size) {
    const ids = [...removedIds].map(txnId);
    const r = await traced(run, 'reconciler', 'agent_remove_txns', { count: ids.length }, `Remove ${plural(ids.length, 'transaction')} Plaid no longer reports`, async () => {
      for (let i = 0; i < ids.length; i += BATCH) await store.removeTxns(ids.slice(i, i + BATCH));
      return ids.length;
    }, (n) => ({ title: `${plural(n, 'transaction')} removed`, data: { removed: n } }));
    if (!r.ok) throw r.error;
  }
  // the cursor only moves once the data it describes is safely stored, so a failed run is simply retried from the old one
  if (cursorAdvanced) {
    const r = await traced(run, 'reconciler', 'agent_save_plaid_item', { cursor: 'next' }, 'Save the /transactions/sync cursor', async () => store.saveItem({ ...item, accessToken: '', institutionId: '', institutionName: '', cursor }), () => ({ title: 'Cursor saved', data: { saved: true } }));
    if (!r.ok) throw r.error;
  }
  const rc = await traced(run, 'reconciler', 'recompute_household', { household_id: hh }, 'Recompute health indicators, forecast and data-quality rule alerts', () => store.recompute(hh), () => ({ title: 'Health indicators, 90-day forecast and rule alerts refreshed from the new data', data: { household_id: hh } }));
  if (!rc.ok) run.emit('reconciler', 'message', `Recompute failed (${truncate(msgOf(rc.error), 100)}); the scheduled tick will retry within a minute`, {});

  // 6. report
  const stored = (await store.countTxns(hh, accountRows.map((a) => a.id))) ?? txnRows.length;
  await store.setConnection({ itemId: item.itemId, householdId: hh, institutionName: inst, status: 'ok', accountsCount: accountRows.length, txnsCount: stored });
  const line = fresh
    ? `Linked ${inst}: ${plural(accountRows.length, 'account')}, ${plural(stored, 'transaction')}`
    : `Synced ${inst}: ${plural(accountRows.length, 'account')}, ${plural(stored, 'transaction')} (+${addedCount} new, ${modifiedCount} changed, -${removedIds.size} removed)`;
  return { item_id: item.itemId, institution: inst, accounts: accountRows.length, txns: stored, added: addedCount, modified: modifiedCount, removed: removedIds.size, fresh, history_pending: historyPending, line };
}

const locks = new Map<string, Promise<unknown>>();
/** One plaid_sync per household at a time (two overlapping syncs would race on the cursor). */
async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

async function waitForItems(rt: PlaidRuntime, householdId: string): Promise<PlaidItem[]> {
  // the token view can trail the reducer that wrote the item by a moment
  for (let i = 0; i < 6; i++) {
    const items = await rt.store!.items(householdId);
    if (items.length) return items;
    await rt.sleep(500);
  }
  return [];
}

export function createPlaidSyncWorkflow(getRt: () => PlaidRuntime = getPlaidRuntime): WorkflowDef {
  return {
    name: 'plaid_sync',
    // no cacheKey: a bank sync must always run live, never replay an earlier one

    async run(run, job) {
      const rt = getRt();
      if (!rt.store) throw new Error('SpacetimeDB is not connected');
      const hh = job.householdId;
      return exclusive(hh, async () => {
        const items = await waitForItems(rt, hh);
        if (!items.length) {
          run.emit('planner', 'final', 'No linked bank for this household yet: nothing to sync', { household_id: hh });
          return { items: 0 };
        }
        if (!rt.client || !rt.config) {
          for (const it of items) await rt.store!.setConnection({ itemId: it.itemId, householdId: hh, institutionName: it.institutionName, status: 'error', accountsCount: 0, txnsCount: 0, error: 'Plaid is not configured on the worker (PLAID_CLIENT_ID / PLAID_SECRET)' }).catch(() => undefined);
          throw new Error('Plaid is not configured (PLAID_CLIENT_ID / PLAID_SECRET missing)');
        }

        const names = items.map((i) => i.institutionName || 'your bank').join(', ');
        const fallbackPlan = [`Fetch the accounts and live balances at ${names} (Plaid /accounts/get)`, 'Read card and loan terms where the bank supports them (Plaid /liabilities/get)', 'Pull new, changed and removed transactions with a saved cursor (Plaid /transactions/sync)', "Map Plaid account types to Keystone's eight types, asking Nemotron about ambiguous ones", 'Save accounts and transactions to SpacetimeDB, recompute health and the forecast, then report'];
        try {
          await emitPlan(run, {
            agent: 'planner',
            task: 'plaid_sync',
            system: `You are Keystone's bank-sync planner. ${householdBrief(run)} Data comes from the Plaid Sandbox (synthetic).`,
            user: `The household linked ${names}. Plan how to import its accounts, balances, card and loan terms and transactions from Plaid into the family's financial picture. Steps available: Plaid /accounts/get, /liabilities/get, /transactions/sync (cursor paging), account-type mapping, saving to SpacetimeDB, recompute health and forecast.`,
            toolNames: [],
            local: { plan: fallbackPlan },
          });
        } catch (e) {
          run.emit('planner', 'plan', `Plan: ${fallbackPlan.map((s, i) => `${i + 1}) ${s}`).join('  ')}`, { steps: fallbackPlan, note: `planning model unavailable: ${truncate(msgOf(e), 100)}` });
        }

        const done: ItemSummary[] = [];
        const failed: { item: PlaidItem; error: string }[] = [];
        for (const item of items) {
          try {
            done.push(await syncItem(run, rt, item));
          } catch (e) {
            const message = isPlaidError(e) ? `${e.message} (${e.code})` : msgOf(e);
            failed.push({ item, error: message });
            run.emit('reconciler', 'message', `Sync of ${item.institutionName || 'the bank'} failed: ${truncate(message, 200)}`, { item_id: item.itemId });
            await rt.store!.setConnection({ itemId: item.itemId, householdId: hh, institutionName: item.institutionName, status: 'error', accountsCount: 0, txnsCount: 0, error: truncate(message, 400) }).catch(() => undefined);
          }
        }
        if (failed.length) throw new Error(`Bank sync failed: ${failed.map((f) => `${f.item.institutionName || f.item.itemId}: ${f.error}`).join('; ')}`);

        const summary = done.map((d) => d.line).join('; ');
        run.emit('reconciler', 'final', summary, { items: done.map(({ line: _l, ...rest }) => rest) });
        return { items: done.length, accounts: done.reduce((n, d) => n + d.accounts, 0), txns: done.reduce((n, d) => n + d.txns, 0), summary };
      });
    },
  };
}

export const plaidSyncWorkflow: WorkflowDef = createPlaidSyncWorkflow();
