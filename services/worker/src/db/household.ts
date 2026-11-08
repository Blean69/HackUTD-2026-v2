// Household data from the SDK's local client cache. First use of a household subscribes to its rows
// (WHERE household_id = ...); after that the cache stays live, so health/forecast updates arrive on their own.
import type { Line } from '../llm/rules.js';
import type { DbConnection } from '../module_bindings/index.js';
import type { CreditFactorRow, HouseholdData } from '../types.js';
import { formatDay, parseDay, todayIso } from '../util.js';
import { subscribeAndWait } from './connection.js';

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const HOUSEHOLD_TABLES = ['member', 'account', 'txn', 'credit_profile', 'obligation', 'health_indicator', 'forecast_point', 'goal', 'credit_score', 'credit_score_history'];

export class HouseholdLoader {
  private subs = new Map<string, Promise<unknown>>();
  private transcriptSubs = new Map<string, Promise<unknown>>();

  constructor(private conn: DbConnection) {}

  private ensure(householdId: string): Promise<unknown> {
    let p = this.subs.get(householdId);
    if (!p) {
      const q = [`SELECT * FROM household WHERE id = ${sqlStr(householdId)}`, ...HOUSEHOLD_TABLES.map((t) => `SELECT * FROM ${t} WHERE household_id = ${sqlStr(householdId)}`)];
      p = subscribeAndWait(this.conn, q, 30_000).catch((e) => {
        this.subs.delete(householdId); // allow a retry on the next job
        throw e;
      });
      this.subs.set(householdId, p);
    }
    return p;
  }

  async load(householdId: string): Promise<HouseholdData> {
    await this.ensure(householdId);
    const db = this.conn.db;
    const hh = db.household.id.find(householdId);
    if (!hh) throw new Error(`unknown household ${householdId}`);
    const mine = <T extends { householdId: string }>(rows: Iterable<T>): T[] => [...rows].filter((r) => r.householdId === householdId);
    const forecast = mine(db.forecastPoint.iter()).sort((a, b) => (a.date < b.date ? -1 : 1));
    const txns = mine(db.txn.iter());
    // "today": the household's own clock. The forecast starts today; fall back to the newest transaction, then the real date.
    const newest = txns.reduce((m, t) => (t.date.slice(0, 10) > m ? t.date.slice(0, 10) : m), '');
    const real = todayIso();
    const asOf = forecast[0]?.date ?? (newest && (parseDay(real) ?? 0) - (parseDay(newest) ?? 0) > 14 ? formatDay((parseDay(newest) ?? 0) + 1) : real);
    return {
      household: {
        id: hh.id,
        name: hh.name,
        city: hh.city,
        state: hh.state,
        persona: hh.persona,
        template_id: hh.templateId,
        ...(typeof hh.homeValue === 'number' && hh.homeValue > 0 ? { home_value: hh.homeValue } : {}),
        ...(typeof hh.vehicleValue === 'number' && hh.vehicleValue > 0 ? { vehicle_value: hh.vehicleValue } : {}),
      },
      members: mine(db.member.iter()).map((m) => ({ id: m.id, household_id: m.householdId, name: m.name, age: m.age, role: m.role, income_annual: m.incomeAnnual })),
      accounts: mine(db.account.iter()).map((a) => ({
        id: a.id,
        household_id: a.householdId,
        type: a.type,
        institution: a.institution,
        nickname: a.nickname,
        balance: a.balance,
        ...(a.ratePct !== undefined ? { rate_pct: a.ratePct } : {}),
        ...(a.creditLimit !== undefined ? { credit_limit: a.creditLimit } : {}),
        ...(a.monthlyPayment !== undefined ? { monthly_payment: a.monthlyPayment } : {}),
        ...(a.maturityDate !== undefined ? { maturity_date: a.maturityDate } : {}),
        opened_date: a.openedDate,
        owner_member_ids: safeArray(a.ownerMemberIdsJson),
      })),
      // anomaly_truth is deliberately not copied: detectors must never see ground truth
      txns: txns.map((t) => ({ id: t.id, household_id: t.householdId, account_id: t.accountId, date: t.date, amount: t.amount, merchant: t.merchant, category: t.category, description: t.description, is_recurring: t.isRecurring })),
      credit: mine(db.creditProfile.iter()).map((c) => ({ member_id: c.memberId, household_id: c.householdId, score: c.score, utilization_pct: c.utilizationPct, hard_inquiries_12m: c.hardInquiries12M, oldest_account_years: c.oldestAccountYears, late_payments_24m: c.latePayments24M })),
      obligations: mine(db.obligation.iter()).map((o) => ({ id: o.id, household_id: o.householdId, name: o.name, amount: o.amount, due_day: o.dueDay, account_id: o.accountId, kind: o.kind })),
      health: mine(db.healthIndicator.iter()).map((h) => ({ key: h.key, label: h.label, value: h.value, unit: h.unit, status: h.status, explanation: h.explanation })),
      forecast: forecast.map((f) => ({ date: f.date, balance: f.balance, obligations_due: f.obligationsDue })),
      goals: mine(db.goal.iter()).map((g) => ({ id: g.id, title: g.title, target_amount: g.targetAmount, target_date: g.targetDate, priority: g.priority, feasibility: g.feasibility })),
      credit_scores: mine(db.creditScore.iter()).map((c) => ({ member_id: c.memberId, score: c.score, band: c.band, factors: safeFactors(c.factorsJson) })),
      credit_history: mine(db.creditScoreHistory.iter())
        .map((h) => ({ member_id: h.memberId, date: h.date, score: h.score }))
        .sort((a, b) => (a.member_id < b.member_id ? -1 : a.member_id > b.member_id ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      asOf,
    };
  }

  async transcript(huddleId: string): Promise<Line[]> {
    let p = this.transcriptSubs.get(huddleId);
    if (!p) {
      p = subscribeAndWait(this.conn, [`SELECT * FROM transcript_line WHERE huddle_id = ${sqlStr(huddleId)}`]);
      this.transcriptSubs.set(huddleId, p);
    }
    const sub = (await p) as { unsubscribe(): void };
    const lines = [...this.conn.db.transcriptLine.iter()].filter((l) => l.huddleId === huddleId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // keep the subscription until the purge removes the rows, then drop it
    setTimeout(() => {
      try {
        sub.unsubscribe();
      } catch {
        /* ignore */
      }
      this.transcriptSubs.delete(huddleId);
    }, 60_000).unref();
    return lines.map((l) => ({ speaker: l.speaker, text: l.text }));
  }
}

function safeFactors(json: string): CreditFactorRow[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as CreditFactorRow[]) : [];
  } catch {
    return [];
  }
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
