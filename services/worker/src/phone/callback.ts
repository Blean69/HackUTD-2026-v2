// Phone callback ("Brian calls you back with a critical alert", docs/contracts.md section 10): what the worker contributes.
//   GET  /phone/alert_candidates?household_id=   real signals for the voice service to choose from (open critical/warn alerts, rule hits
//                                                 from the anomaly scan, a forecast overdraft, a credit-score alert) + a small context of the
//                                                 household's accounts that the voice service fills its alert templates from
//   POST /phone/callback_alert {run_id, alert}   writes the chosen alert as a critical `alert` row (agent_create_alert) and traces it on
//                                                 the callback's phone run
// Nothing here knows a phone number. The voice service holds the caller's number in memory for the one callback and never sends it here.
import { createHash } from 'node:crypto';
import { subscribeAndWait } from '../db/connection.js';
import type { DbConnection } from '../module_bindings/index.js';
import type { HouseholdData, Txn } from '../types.js';
import { parseDay, round0 } from '../util.js';

/** The alert kinds `agent_create_alert` accepts today (spacetime/src/reducers/worker.ts). */
export const CALLBACK_ALERT_KINDS = ['fraud', 'scam', 'obligation', 'data_quality', 'insight'] as const;
export type CallbackAlertKind = (typeof CALLBACK_ALERT_KINDS)[number];
/** Callback alerts get ids `callback:<household>:<call>` so they are never offered as "real" signals for the next callback. */
export const CALLBACK_ALERT_PREFIX = 'callback:';

// ---- alert rows (the worker's own connection does not subscribe to `alert`; this does it per household on first use) -----------------
export interface AlertRow {
  id: string;
  severity: string;
  kind: string;
  title: string;
  detail: string;
  related_ids: string[];
  /** "" = open (nobody acknowledged it). */
  acknowledged_by: string;
  created_at: string;
}

export interface AlertSource {
  /** Every alert row of the household, newest first. Never rejects for a missing subscription (returns []). */
  list(householdId: string): Promise<AlertRow[]>;
}

export class StaticAlertSource implements AlertSource {
  constructor(public rows: Record<string, AlertRow[]> = {}) {}
  async list(householdId: string): Promise<AlertRow[]> {
    return this.rows[householdId] ?? [];
  }
}

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export class SpacetimeAlertSource implements AlertSource {
  private subs = new Map<string, Promise<unknown>>();
  constructor(
    private conn: DbConnection,
    private warn: (msg: string) => void = (m) => console.warn(m),
  ) {}

  async list(householdId: string): Promise<AlertRow[]> {
    let p = this.subs.get(householdId);
    if (!p) {
      p = subscribeAndWait(this.conn, [`SELECT * FROM alert WHERE household_id = ${sqlStr(householdId)}`], 10_000).catch((e: unknown) => {
        this.subs.delete(householdId);
        this.warn(`[phone] alert subscription failed (${e instanceof Error ? e.message.slice(0, 100) : 'error'}); callback uses rule hits and templates only`);
      });
      this.subs.set(householdId, p);
    }
    await p;
    const out: AlertRow[] = [];
    for (const r of this.conn.db.alert.iter()) {
      if (r.householdId !== householdId) continue;
      let related: string[] = [];
      try {
        const v = JSON.parse(r.relatedIdsJson || '[]');
        if (Array.isArray(v)) related = v.map(String);
      } catch {
        /* keep [] */
      }
      const ts = r.createdAt as unknown as { toDate?: () => Date };
      let created = '';
      try {
        created = typeof ts?.toDate === 'function' ? ts.toDate().toISOString() : '';
      } catch {
        /* keep '' */
      }
      out.push({ id: r.id, severity: r.severity, kind: r.kind, title: r.title, detail: r.detail, related_ids: related, acknowledged_by: r.acknowledgedBy, created_at: created });
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
}

// ---- candidates -----------------------------------------------------------------------------------------------------------------
export type CandidateType = 'open_alert' | 'credit_drop' | 'card_testing' | 'scam_payment' | 'new_payee_transfer' | 'duplicate' | 'overdraft';

export interface AlertCandidate {
  /** Stable per signal ("alert:<id>", "txn:<id>", "forecast:<date>"): the voice service avoids repeating one it used a moment ago. */
  id: string;
  type: CandidateType;
  source: 'alert' | 'rule' | 'forecast';
  severity: 'critical' | 'warn';
  /** Alert kind to write if this becomes the callback's alert. */
  kind: CallbackAlertKind;
  title: string;
  detail: string;
  /** An alert row that already exists on the dashboard (open): when it is critical the callback reuses it instead of writing a second one. */
  alert_id?: string;
  related_ids: string[];
  facts: Record<string, string | number | boolean>;
  /** Higher = more worth a phone call. */
  priority: number;
}

export interface AlertContext {
  household_id: string;
  family: string;
  as_of: string;
  city: string;
  state: string;
  checking_balance: number | null;
  accounts: { id: string; type: string; nickname: string; institution: string; last4: string; balance: number; credit_limit?: number }[];
  obligations: { name: string; amount: number; due_day: number; kind: string }[];
}

/** The scan's finding (a subset of tools/anomalies.ts Finding; kept local so this file does not depend on the tools folder). */
export interface AnomalyFinding {
  txn_id: string;
  rule: string;
  severity: string;
  kind: string;
  score: number;
  date: string;
  amount: number;
  merchant: string;
  reason: string;
}

/** A stable, plausible card/account last four from the account id (the data model has no account numbers). */
export function last4(accountId: string): string {
  const n = parseInt(createHash('sha256').update(`last4:${accountId}`).digest('hex').slice(0, 8), 16);
  return String(1000 + (n % 9000));
}

const RECENT_DAYS = 60;
const money = (x: number): number => round0(Math.abs(x));

export function buildContext(data: HouseholdData, familyName: string): AlertContext {
  const accounts = data.accounts
    .filter((a) => ['checking', 'savings', 'credit_card'].includes(a.type))
    .slice(0, 8)
    .map((a) => ({ id: a.id, type: a.type, nickname: a.nickname, institution: a.institution, last4: last4(a.id), balance: round0(a.balance), ...(a.credit_limit ? { credit_limit: round0(a.credit_limit) } : {}) }));
  const checking = data.accounts.filter((a) => a.type === 'checking');
  return {
    household_id: data.household.id,
    family: familyName,
    as_of: data.asOf,
    city: data.household.city,
    state: data.household.state,
    checking_balance: checking.length ? round0(checking.reduce((s, a) => s + a.balance, 0)) : null,
    accounts,
    obligations: [...data.obligations]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6)
      .map((o) => ({ name: o.name, amount: round0(o.amount), due_day: o.due_day, kind: o.kind })),
  };
}

const OVERNIGHT = /\b0[0-4]:[0-5]\d\b/;

export function buildAlertCandidates(data: HouseholdData, alerts: readonly AlertRow[], findings: readonly AnomalyFinding[], familyName: string): { candidates: AlertCandidate[]; context: AlertContext } {
  const today = parseDay(data.asOf) ?? Infinity;
  const txnById = new Map<string, Txn>(data.txns.map((t) => [t.id, t]));
  const acctById = new Map(data.accounts.map((a) => [a.id, a]));
  const out: AlertCandidate[] = [];
  const covered = new Set<string>(); // txn ids an open alert already talks about

  // 1. open critical / warn alert rows (the callback sits on top of what the dashboard already shows)
  for (const a of alerts) {
    if (a.acknowledged_by !== '' || a.id.startsWith(CALLBACK_ALERT_PREFIX)) continue;
    if (a.severity !== 'critical' && a.severity !== 'warn') continue;
    for (const r of a.related_ids) covered.add(r);
    const credit = a.kind === 'credit';
    out.push({
      id: `alert:${a.id}`,
      type: credit ? 'credit_drop' : 'open_alert',
      source: 'alert',
      severity: a.severity,
      kind: (CALLBACK_ALERT_KINDS as readonly string[]).includes(a.kind) ? (a.kind as CallbackAlertKind) : 'fraud',
      title: a.title,
      detail: a.detail,
      alert_id: a.id,
      related_ids: a.related_ids.slice(0, 6),
      facts: { alert_kind: a.kind, alert_severity: a.severity },
      priority: (a.severity === 'critical' ? 90 : 60) + (credit ? 6 : 0),
    });
  }

  // 2. rule hits from the anomaly scan (recent, not already covered by an open alert)
  const seenRule = new Set<string>();
  for (const f of findings) {
    const d = parseDay(f.date);
    if (d === null || today - d > RECENT_DAYS || d > today) continue;
    if (covered.has(f.txn_id)) continue;
    const t = txnById.get(f.txn_id);
    const acct = t ? acctById.get(t.account_id) : undefined;
    const base = { related_ids: [f.txn_id], source: 'rule' as const };
    const acctFacts: Record<string, string | number | boolean> = acct ? { account: acct.nickname, last4: last4(acct.id) } : {};
    if (f.rule === 'card_testing' && !seenRule.has('card_testing')) {
      seenRule.add('card_testing');
      const burst = findings.filter((x) => x.rule === 'card_testing' && x.date === f.date && txnById.get(x.txn_id)?.account_id === t?.account_id);
      out.push({
        ...base,
        id: `txn:${f.txn_id}`,
        type: 'card_testing',
        severity: 'critical',
        kind: 'fraud',
        title: `Possible card testing${acct ? ` on ${acct.nickname}` : ''}`,
        detail: f.reason,
        related_ids: burst.slice(0, 6).map((x) => x.txn_id),
        facts: { count: burst.length, date: f.date.slice(0, 10), ...acctFacts },
        priority: 84,
      });
    } else if (f.rule === 'scam_payment' && !seenRule.has('scam_payment')) {
      seenRule.add('scam_payment');
      out.push({ ...base, id: `txn:${f.txn_id}`, type: 'scam_payment', severity: 'critical', kind: 'scam', title: `Possible scam payment to ${f.merchant}`, detail: f.reason, facts: { amount: money(f.amount), merchant: f.merchant, category: t?.category ?? '', date: f.date.slice(0, 10), ...acctFacts }, priority: 85 });
    } else if (f.rule === 'account_takeover' && !seenRule.has('account_takeover')) {
      seenRule.add('account_takeover');
      out.push({
        ...base,
        id: `txn:${f.txn_id}`,
        type: 'new_payee_transfer',
        severity: 'critical',
        kind: 'fraud',
        title: `Large payment to a new payee`,
        detail: f.reason,
        facts: { amount: money(f.amount), merchant: f.merchant, date: f.date.slice(0, 10), overnight: OVERNIGHT.test(t?.description ?? ''), ...acctFacts },
        priority: 83,
      });
    } else if (f.rule === 'duplicate' && !seenRule.has('duplicate')) {
      seenRule.add('duplicate');
      out.push({ ...base, id: `txn:${f.txn_id}`, type: 'duplicate', severity: 'warn', kind: 'data_quality', title: `Duplicate charge at ${f.merchant}`, detail: f.reason, facts: { amount: money(f.amount), merchant: f.merchant, date: f.date.slice(0, 10), ...acctFacts }, priority: 50 });
    }
  }

  // 3. overdraft risk: the 90-day forecast goes below zero on a date
  const low = data.forecast.reduce<(typeof data.forecast)[number] | null>((m, p) => (m === null || p.balance < m.balance ? p : m), null);
  if (low && low.balance < 0) {
    const first = data.forecast.find((p) => p.balance < 0) ?? low;
    const inDays = (parseDay(first.date) ?? today) - today;
    // the bills that really fall due that day (by due_day), so nothing is said about bills colliding unless they do
    const day = Number(first.date.slice(8, 10));
    const dueThatDay = data.obligations.filter((o) => o.due_day === day && o.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 3);
    const billsLine = dueThatDay.map((o) => `${o.name} ($${money(o.amount).toLocaleString('en-US')})`).join(', ');
    out.push({
      id: `forecast:${first.date}`,
      type: 'overdraft',
      source: 'forecast',
      severity: 'critical',
      kind: 'obligation',
      title: `Checking could go below zero on ${first.date}`,
      detail: `The 90-day forecast dips to about -$${money(low.balance).toLocaleString('en-US')} around ${low.date}.${billsLine ? ` Due that day: ${billsLine}.` : ''} Make sure checking can cover the payments due then.`,
      related_ids: [],
      facts: { date: first.date, low_date: low.date, shortfall: money(low.balance), bills_due: round0(first.obligations_due), in_days: inDays, ...(billsLine ? { bills_that_day: billsLine } : {}) },
      priority: inDays <= 14 ? 75 : 55,
    });
  }

  out.sort((a, b) => b.priority - a.priority);
  return { candidates: out.slice(0, 8), context: buildContext(data, familyName) };
}
