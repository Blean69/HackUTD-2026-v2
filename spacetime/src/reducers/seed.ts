// Bulk seed reducers (worker-only). Each takes a JSON array string whose objects follow docs/contracts.md section 1
// (snake_case, same shape as data/seed/*.json) and inserts the rows, skipping ids that already exist.
// Seed in dependency order: households, members, accounts, credit, txns, obligations, conversations, proposals, votes.
// Rows that change a household's numbers mark it dirty so `tick_recompute` refreshes its health math.
import { Timestamp } from 'spacetimedb';
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { DAY_MICROS, VOTE_CHOICES, enqueueProposalCheck, normalizeDetails } from '../proposals';
import { fail, markDirty, parseJsonArray, type Ctx } from '../util';

type Row = Record<string, unknown>;

function rowsOf(rows_json: string, table: string): Row[] {
  return parseJsonArray(rows_json, 'rows_json').map((r, i) => {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) fail(`${table}[${i}] must be an object`);
    return r as Row;
  });
}
function requireWorker(ctx: Ctx): void {
  if (!ctx.db.worker.identity.find(ctx.sender)) fail('worker only');
}
function str(r: Row, key: string, where: string, fallback?: string): string {
  const v = r[key];
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    return fail(`${where}: missing "${key}"`);
  }
  return String(v);
}
function num(r: Row, key: string, where: string, fallback?: number): number {
  const v = r[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  return fail(`${where}: "${key}" must be a number`);
}
function uint(r: Row, key: string, where: string, fallback?: number): number {
  const n = Math.round(num(r, key, where, fallback));
  if (n < 0) fail(`${where}: "${key}" must be >= 0`);
  return n;
}
function optNum(r: Row, key: string, where: string): number | undefined {
  const v = r[key];
  if (v === undefined || v === null || v === '') return undefined;
  return num(r, key, where);
}
function optStr(r: Row, key: string): string | undefined {
  const v = r[key];
  return v === undefined || v === null || v === '' ? undefined : String(v);
}
/** Accept either an array/object under `key` or an already-serialised `${key}_json`. */
function jsonField(r: Row, key: string, fallback: string): string {
  const raw = r[`${key}_json`];
  if (typeof raw === 'string') return raw;
  const v = r[key];
  return v === undefined || v === null ? fallback : JSON.stringify(v);
}

/** ISO date string (or epoch ms) -> Timestamp; missing -> fallback. */
function stamp(r: Row, key: string, where: string, fallback: Timestamp): Timestamp {
  const v = r[key];
  if (v === undefined || v === null || v === '') return fallback;
  const ms = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(ms)) return fail(`${where}: "${key}" must be an ISO date`);
  return Timestamp.fromDate(new Date(ms));
}

function done(table: string, inserted: number, skipped: number): void {
  console.info(`seed_${table}: inserted ${inserted}, skipped ${skipped} existing`);
}

export const seed_households = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  let ins = 0, skip = 0;
  for (const r of rowsOf(rows_json, 'household')) {
    const id = str(r, 'id', 'household');
    if (ctx.db.household.id.find(id)) { skip++; continue; }
    ctx.db.household.insert({
      id,
      name: str(r, 'name', id),
      city: str(r, 'city', id, ''),
      state: str(r, 'state', id, ''),
      persona: str(r, 'persona', id, ''),
      home_value: Math.max(0, num(r, 'home_value', id, 0)),
      vehicle_value: Math.max(0, num(r, 'vehicle_value', id, 0)),
      template_id: '',
      owner: undefined,
      created_at: ctx.timestamp,
    });
    ins++;
  }
  done('households', ins, skip);
});

export const seed_members = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  let ins = 0, skip = 0;
  const touched = new Set<string>();
  for (const r of rowsOf(rows_json, 'member')) {
    const id = str(r, 'id', 'member');
    if (ctx.db.member.id.find(id)) { skip++; continue; }
    const household_id = str(r, 'household_id', id);
    ctx.db.member.insert({
      id,
      household_id,
      name: str(r, 'name', id),
      age: uint(r, 'age', id, 0),
      role: str(r, 'role', id, 'other'),
      income_annual: num(r, 'income_annual', id, 0),
    });
    touched.add(household_id);
    ins++;
  }
  for (const h of touched) markDirty(ctx, h);
  done('members', ins, skip);
});

export const seed_accounts = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  let ins = 0, skip = 0;
  const touched = new Set<string>();
  for (const r of rowsOf(rows_json, 'account')) {
    const id = str(r, 'id', 'account');
    if (ctx.db.account.id.find(id)) { skip++; continue; }
    const household_id = str(r, 'household_id', id);
    ctx.db.account.insert({
      id,
      household_id,
      type: str(r, 'type', id),
      institution: str(r, 'institution', id, ''),
      nickname: str(r, 'nickname', id, ''),
      balance: num(r, 'balance', id, 0),
      rate_pct: optNum(r, 'rate_pct', id),
      credit_limit: optNum(r, 'credit_limit', id),
      monthly_payment: optNum(r, 'monthly_payment', id),
      maturity_date: optStr(r, 'maturity_date'),
      opened_date: str(r, 'opened_date', id, ''),
      owner_member_ids_json: jsonField(r, 'owner_member_ids', '[]'),
      source: 'seed',
    });
    touched.add(household_id);
    ins++;
  }
  for (const h of touched) markDirty(ctx, h);
  done('accounts', ins, skip);
});

/** Transactions carry no household_id in the seed files; it is taken from the account (seed accounts first). */
export const seed_txns = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  let ins = 0, skip = 0;
  const touched = new Set<string>();
  const accountHousehold = new Map<string, string>();
  for (const r of rowsOf(rows_json, 'txn')) {
    const id = str(r, 'id', 'txn');
    if (ctx.db.txn.id.find(id)) { skip++; continue; }
    const account_id = str(r, 'account_id', id);
    let household_id = optStr(r, 'household_id');
    if (!household_id) {
      household_id = accountHousehold.get(account_id);
      if (!household_id) {
        const acct = ctx.db.account.id.find(account_id);
        if (!acct) fail(`txn ${id}: unknown account "${account_id}" (seed_accounts first)`);
        household_id = acct.household_id;
        accountHousehold.set(account_id, household_id);
      }
    }
    ctx.db.txn.insert({
      id,
      household_id,
      account_id,
      date: str(r, 'date', id),
      amount: num(r, 'amount', id),
      merchant: str(r, 'merchant', id, ''),
      category: str(r, 'category', id, ''),
      description: str(r, 'description', id, ''),
      is_recurring: r['is_recurring'] === true || r['is_recurring'] === 'true' || r['is_recurring'] === 1,
      anomaly_truth: optStr(r, 'anomaly') ?? optStr(r, 'anomaly_truth') ?? '',
      source: 'seed',
    });
    touched.add(household_id);
    ins++;
  }
  for (const h of touched) markDirty(ctx, h);
  done('txns', ins, skip);
});

/** Credit profiles carry no household_id in the seed files; it is taken from the member (seed members first). */
export const seed_credit = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  let ins = 0, skip = 0;
  const touched = new Set<string>();
  for (const r of rowsOf(rows_json, 'credit_profile')) {
    const member_id = str(r, 'member_id', 'credit_profile');
    if (ctx.db.credit_profile.member_id.find(member_id)) { skip++; continue; }
    let household_id = optStr(r, 'household_id');
    if (!household_id) {
      const m = ctx.db.member.id.find(member_id);
      if (!m) fail(`credit_profile ${member_id}: unknown member (seed_members first)`);
      household_id = m.household_id;
    }
    ctx.db.credit_profile.insert({
      member_id,
      household_id,
      score: uint(r, 'score', member_id, 0),
      utilization_pct: num(r, 'utilization_pct', member_id, 0),
      hard_inquiries_12m: uint(r, 'hard_inquiries_12m', member_id, 0),
      oldest_account_years: num(r, 'oldest_account_years', member_id, 0),
      late_payments_24m: uint(r, 'late_payments_24m', member_id, 0),
    });
    touched.add(household_id);
    ins++;
  }
  for (const h of touched) markDirty(ctx, h);
  done('credit', ins, skip);
});

export const seed_obligations = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  let ins = 0, skip = 0;
  const touched = new Set<string>();
  for (const r of rowsOf(rows_json, 'obligation')) {
    const id = str(r, 'id', 'obligation');
    if (ctx.db.obligation.id.find(id)) { skip++; continue; }
    const household_id = str(r, 'household_id', id);
    const due = uint(r, 'due_day', id, 1);
    if (due < 1 || due > 31) fail(`obligation ${id}: due_day must be 1..31`);
    ctx.db.obligation.insert({
      id,
      household_id,
      name: str(r, 'name', id),
      amount: num(r, 'amount', id),
      due_day: due,
      account_id: str(r, 'account_id', id, ''),
      kind: str(r, 'kind', id, 'bill'),
    });
    touched.add(household_id);
    ins++;
  }
  for (const h of touched) markDirty(ctx, h);
  done('obligations', ins, skip);
});

export const seed_conversations = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  let ins = 0, skip = 0;
  for (const r of rowsOf(rows_json, 'conversation')) {
    const id = str(r, 'id', 'conversation');
    if (ctx.db.conversation.id.find(id)) { skip++; continue; }
    ctx.db.conversation.insert({
      id,
      household_id: str(r, 'household_id', id),
      title: str(r, 'title', id, ''),
      turns_json: jsonField(r, 'turns', '[]'),
      expected_goals_json: jsonField(r, 'expected_goals', '[]'),
      scam_signals_json: jsonField(r, 'scam_signals', '[]'),
    });
    ins++;
  }
  done('conversations', ins, skip);
});

/**
 * Proposals (docs/contracts.md section 6). `details` may be an object or a ready `details_json` string; `created_at` /
 * `closes_at` are ISO strings (closes_at defaults to created_at + `closes_in_days`, default 7). A new row WITHOUT a verdict
 * gets its affordability check queued (a `what_if` job), exactly as `create_proposal` does; existing ids are skipped,
 * so re-seeding never queues a second check.
 */
export const seed_proposals = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  let ins = 0, skip = 0;
  for (const r of rowsOf(rows_json, 'proposal')) {
    const id = str(r, 'id', 'proposal');
    if (ctx.db.proposal.id.find(id)) { skip++; continue; }
    const household_id = str(r, 'household_id', id);
    if (!ctx.db.household.id.find(household_id)) fail(`proposal ${id}: unknown household "${household_id}" (seed_households first)`);
    const status = str(r, 'status', id, 'open');
    if (status !== 'open' && status !== 'closed') fail(`proposal ${id}: status must be open or closed`);
    const verdict = str(r, 'verdict', id, '');
    if (!['', 'fine', 'tight', 'risky'].includes(verdict)) fail(`proposal ${id}: verdict must be "", fine, tight or risky`);
    const created = stamp(r, 'created_at', id, ctx.timestamp);
    const days = num(r, 'closes_in_days', id, 7);
    const closes = stamp(r, 'closes_at', id, new Timestamp(created.microsSinceUnixEpoch + BigInt(Math.round(days * Number(DAY_MICROS)))));
    const row = ctx.db.proposal.insert({
      id,
      household_id,
      title: str(r, 'title', id),
      amount: num(r, 'amount', id),
      details_json: normalizeDetails(jsonField(r, 'details', '{}')),
      created_by_name: str(r, 'created_by_name', id, 'Family'),
      created_at: created,
      closes_at: closes,
      status,
      verdict,
      analysis_json: jsonField(r, 'analysis', ''),
      run_id: str(r, 'run_id', id, ''),
    });
    if (verdict === '' && status === 'open') enqueueProposalCheck(ctx, row);
    ins++;
  }
  done('proposals', ins, skip);
});

/** Seeded votes: `voter_key` is a member id (real votes use the caller's identity hex). Id = `${proposal_id}:${voter_key}`. */
export const seed_votes = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  requireWorker(ctx);
  let ins = 0, skip = 0;
  for (const r of rowsOf(rows_json, 'vote')) {
    const proposal_id = str(r, 'proposal_id', 'vote');
    const voter_key = str(r, 'voter_key', proposal_id);
    const id = `${proposal_id}:${voter_key}`;
    if (ctx.db.vote.id.find(id)) { skip++; continue; }
    const p = ctx.db.proposal.id.find(proposal_id);
    if (!p) fail(`vote ${id}: unknown proposal (seed_proposals first)`);
    const choice = str(r, 'choice', id);
    if (!(VOTE_CHOICES as readonly string[]).includes(choice)) fail(`vote ${id}: choice must be one of ${VOTE_CHOICES.join(', ')}`);
    ctx.db.vote.insert({
      id,
      proposal_id,
      household_id: p.household_id,
      voter_key,
      voter_name: str(r, 'voter_name', id, voter_key),
      choice,
      updated_at: stamp(r, 'updated_at', id, ctx.timestamp),
    });
    ins++;
  }
  done('votes', ins, skip);
});
