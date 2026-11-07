// Plaid Sandbox support (docs/contracts.md section 5). All Plaid HTTP calls happen in the worker; this module only
// stores what the worker writes. Rows written here use source = "plaid" and ids acct_plaid_* / txn_plaid_*.
import { t } from 'spacetimedb/server';
import spacetimedb, { plaid_item } from '../schema';
import { cleanText, enqueueJob, fail, markDirty, parseJsonArray, requireHousehold, callerName, type Ctx } from '../util';

const ACCOUNT_TYPES = ['checking', 'savings', 'cd', 'ira', 'auto_loan', 'personal_loan', 'credit_card', 'mortgage'];
const CONNECTION_STATUSES = ['linking', 'selecting', 'syncing', 'ok', 'error'];

function requireWorker(ctx: Ctx): void {
  if (!ctx.db.worker.identity.find(ctx.sender)) fail('worker only');
}
type Row = Record<string, unknown>;
function objects(json: string, field: string): Row[] {
  return parseJsonArray(json, field).map((r, i) => {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) fail(`${field}[${i}] must be an object`);
    return r as Row;
  });
}
const s = (r: Row, k: string, where: string, fallback?: string): string => {
  const v = r[k];
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return fallback !== undefined ? fallback : fail(`${where}: missing "${k}"`);
  return String(v);
};
const n = (r: Row, k: string, where: string, fallback?: number): number => {
  const v = r[k];
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (Number.isFinite(x)) return x;
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  return fail(`${where}: "${k}" must be a number`);
};
const optN = (r: Row, k: string, where: string): number | undefined =>
  r[k] === undefined || r[k] === null || r[k] === '' ? undefined : n(r, k, where);
const optS = (r: Row, k: string): string | undefined =>
  r[k] === undefined || r[k] === null || r[k] === '' ? undefined : String(r[k]);

/**
 * Any client: ask the worker to pull the latest accounts, balances and transactions from the household's linked bank.
 * Enqueues a `plaid_sync` job (unless one is already waiting) and flips the household's bank connections to "syncing".
 */
export const request_bank_sync = spacetimedb.reducer({ household_id: t.string() }, (ctx, { household_id }) => {
  requireHousehold(ctx, household_id);
  for (const c of [...ctx.db.bank_connection.household_id.filter(household_id)]) {
    if (c.status === 'ok' || c.status === 'error') ctx.db.bank_connection.item_id.update({ ...c, status: 'syncing', error: '' });
  }
  for (const j of ctx.db.agent_job.household_id.filter(household_id)) {
    if (j.workflow === 'plaid_sync' && j.status === 'queued') return; // one waiting job is enough
  }
  enqueueJob(ctx, 'plaid_sync', household_id, household_id, { household_id, requested_by: callerName(ctx) });
});

/**
 * Worker-only. Create or update the stored Plaid item (token + sync cursor) and make sure a bank_connection row
 * exists. On update, empty access_token / institution_id / institution_name keep the stored values, so the worker can
 * persist a new `cursor` alone. `cursor` is always overwritten.
 */
export const agent_save_plaid_item = spacetimedb.reducer(
  {
    item_id: t.string(),
    household_id: t.string(),
    access_token: t.string(),
    institution_id: t.string(),
    institution_name: t.string(),
    cursor: t.string(),
  },
  (ctx, a) => {
    requireWorker(ctx);
    const item_id = cleanText(a.item_id, 'item_id', 200);
    requireHousehold(ctx, a.household_id);
    const prev = ctx.db.plaid_item.item_id.find(item_id);
    if (prev) {
      if (prev.household_id !== a.household_id) fail(`item ${item_id} belongs to another household`);
      ctx.db.plaid_item.item_id.update({
        ...prev,
        access_token: a.access_token || prev.access_token,
        institution_id: a.institution_id || prev.institution_id,
        institution_name: a.institution_name || prev.institution_name,
        cursor: a.cursor,
      });
    } else {
      if (!a.access_token) fail('access_token is required for a new item');
      ctx.db.plaid_item.insert({
        item_id,
        household_id: a.household_id,
        access_token: a.access_token,
        institution_id: a.institution_id,
        institution_name: a.institution_name,
        cursor: a.cursor,
        created_at: ctx.timestamp,
      });
    }
    if (!ctx.db.bank_connection.item_id.find(item_id)) {
      ctx.db.bank_connection.insert({
        item_id,
        household_id: a.household_id,
        institution_name: a.institution_name,
        status: 'linking',
        accounts_count: 0,
        txns_count: 0,
        last_synced_at: undefined,
        error: '',
      });
    }
  },
);

/** Worker-only. Upsert what the UI shows. `last_synced_at` is stamped whenever status becomes "ok". */
export const agent_set_bank_connection = spacetimedb.reducer(
  {
    item_id: t.string(),
    household_id: t.string(),
    institution_name: t.string(),
    status: t.string(),
    accounts_count: t.u32(),
    txns_count: t.u32(),
    error: t.string(),
  },
  (ctx, a) => {
    requireWorker(ctx);
    requireHousehold(ctx, a.household_id);
    if (!CONNECTION_STATUSES.includes(a.status)) fail(`status must be one of: ${CONNECTION_STATUSES.join(', ')}`);
    const prev = ctx.db.bank_connection.item_id.find(a.item_id);
    const row = {
      item_id: a.item_id,
      household_id: a.household_id,
      institution_name: a.institution_name || prev?.institution_name || '',
      status: a.status,
      accounts_count: a.accounts_count,
      txns_count: a.txns_count,
      last_synced_at: a.status === 'ok' ? ctx.timestamp : prev?.last_synced_at,
      error: a.status === 'error' ? a.error.slice(0, 500) : '',
    };
    if (prev) ctx.db.bank_connection.item_id.update(row);
    else ctx.db.bank_connection.insert(row);
  },
);

/**
 * Worker-only. Upsert accounts from Plaid (same fields as a seed account; owner_member_ids optional). `type` must be
 * one of our 8 account types: the worker does the Plaid-to-ours mapping. Existing seed accounts are never overwritten.
 */
export const agent_upsert_accounts = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  const touched = new Set<string>();
  let ins = 0, upd = 0;
  for (const r of objects(rows_json, 'rows_json')) {
    const id = s(r, 'id', 'account');
    const household_id = s(r, 'household_id', id);
    requireHousehold(ctx, household_id);
    const type = s(r, 'type', id);
    if (!ACCOUNT_TYPES.includes(type)) fail(`account ${id}: type "${type}" is not one of ${ACCOUNT_TYPES.join(', ')}`);
    const prev = ctx.db.account.id.find(id);
    if (prev && prev.source !== 'plaid') fail(`account ${id} is a seed account; refusing to overwrite it`);
    if (prev && prev.household_id !== household_id) fail(`account ${id} belongs to another household`);
    const row = {
      id,
      household_id,
      type,
      institution: s(r, 'institution', id, ''),
      nickname: s(r, 'nickname', id, ''),
      balance: n(r, 'balance', id, 0),
      rate_pct: optN(r, 'rate_pct', id),
      credit_limit: optN(r, 'credit_limit', id),
      monthly_payment: optN(r, 'monthly_payment', id),
      maturity_date: optS(r, 'maturity_date'),
      opened_date: s(r, 'opened_date', id, ''),
      owner_member_ids_json:
        typeof r['owner_member_ids_json'] === 'string'
          ? (r['owner_member_ids_json'] as string)
          : Array.isArray(r['owner_member_ids'])
            ? JSON.stringify(r['owner_member_ids'])
            : (prev?.owner_member_ids_json ?? '[]'),
      source: 'plaid',
    };
    if (prev) { ctx.db.account.id.update(row); upd++; } else { ctx.db.account.insert(row); ins++; }
    touched.add(household_id);
  }
  for (const h of touched) markDirty(ctx, h);
  console.info(`agent_upsert_accounts: inserted ${ins}, updated ${upd}`);
});

/**
 * Worker-only. Upsert transactions from Plaid's /transactions/sync "added" + "modified" lists. household_id is taken
 * from the account when the row has none. Existing seed transactions are never overwritten; anomaly_truth stays "".
 */
export const agent_upsert_txns = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  const touched = new Set<string>();
  let ins = 0, upd = 0;
  for (const r of objects(rows_json, 'rows_json')) {
    const id = s(r, 'id', 'txn');
    const account_id = s(r, 'account_id', id);
    let household_id = optS(r, 'household_id');
    if (!household_id) {
      const acct = ctx.db.account.id.find(account_id);
      if (!acct) fail(`txn ${id}: unknown account "${account_id}" (agent_upsert_accounts first)`);
      household_id = acct.household_id;
    }
    const prev = ctx.db.txn.id.find(id);
    if (prev && prev.source !== 'plaid') fail(`txn ${id} is a seed transaction; refusing to overwrite it`);
    const row = {
      id,
      household_id,
      account_id,
      date: s(r, 'date', id),
      amount: n(r, 'amount', id),
      merchant: s(r, 'merchant', id, ''),
      category: s(r, 'category', id, ''),
      description: s(r, 'description', id, ''),
      is_recurring: r['is_recurring'] === true || r['is_recurring'] === 'true' || r['is_recurring'] === 1,
      anomaly_truth: '',
      source: 'plaid',
    };
    if (prev) { ctx.db.txn.id.update(row); upd++; } else { ctx.db.txn.insert(row); ins++; }
    touched.add(household_id);
  }
  for (const h of touched) markDirty(ctx, h);
  console.info(`agent_upsert_txns: inserted ${ins}, updated ${upd}`);
});

/** Worker-only. Delete Plaid transactions by id (/transactions/sync "removed"). Seed transactions are skipped. */
export const agent_remove_txns = spacetimedb.reducer({ ids_json: t.string() }, (ctx, { ids_json }) => {
  requireWorker(ctx);
  const touched = new Set<string>();
  let removed = 0;
  for (const raw of parseJsonArray(ids_json, 'ids_json')) {
    const id = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? String((raw as Row)['id'] ?? '') : '';
    const row = id ? ctx.db.txn.id.find(id) : null;
    if (!row || row.source !== 'plaid') continue;
    ctx.db.txn.id.delete(id);
    touched.add(row.household_id);
    removed++;
  }
  for (const h of touched) markDirty(ctx, h);
  console.info(`agent_remove_txns: removed ${removed}`);
});

/**
 * Registered workers read their Plaid tokens through this view. `plaid_item` itself is private, so a worker (which
 * is an ordinary client identity, not the database owner) could not otherwise resume after a restart. Anyone not in
 * the `worker` table gets an empty result.
 */
export const worker_plaid_items = spacetimedb.view(
  { name: 'worker_plaid_items', public: true },
  t.array(plaid_item.rowType),
  (ctx) => (ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.plaid_item.iter()] : []),
);
