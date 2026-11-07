// Glue between the tables and the pure math in finance.ts: read a household's rows, run `analyzeHousehold`,
// and replace the derived rows (health_indicator, forecast_point, rule alerts) for that household.
import { ScheduleAt } from 'spacetimedb';
import { analyzeHousehold, type HouseholdInput } from './finance';
import { fail, isoDay, type Ctx } from './util';

const RULE_PREFIX = 'rule:';

export function recomputeHousehold(ctx: Ctx, household_id: string): void {
  if (!ctx.db.household.id.find(household_id)) fail(`unknown household "${household_id}"`);

  const hh = ctx.db.household.id.find(household_id)!;
  const input: HouseholdInput = {
    household_id,
    home_value: hh.home_value,
    vehicle_value: hh.vehicle_value,
    accounts: [...ctx.db.account.household_id.filter(household_id)].map((a) => ({
      id: a.id,
      type: a.type,
      nickname: a.nickname,
      balance: a.balance,
      rate_pct: a.rate_pct ?? undefined,
      credit_limit: a.credit_limit ?? undefined,
      monthly_payment: a.monthly_payment ?? undefined,
      opened_date: a.opened_date,
    })),
    // NOTE: anomaly_truth is deliberately not copied: the math never sees the ground-truth label.
    txns: [...ctx.db.txn.household_id.filter(household_id)].map((x) => ({
      id: x.id,
      account_id: x.account_id,
      date: x.date,
      amount: x.amount,
      merchant: x.merchant,
      category: x.category,
      description: x.description,
      is_recurring: x.is_recurring,
    })),
    obligations: [...ctx.db.obligation.household_id.filter(household_id)].map((o) => ({
      id: o.id,
      name: o.name,
      amount: o.amount,
      due_day: o.due_day,
      account_id: o.account_id,
      kind: o.kind,
    })),
    members: [...ctx.db.member.household_id.filter(household_id)].map((m) => ({
      id: m.id,
      income_annual: m.income_annual,
      role: m.role,
    })),
    credit: [...ctx.db.credit_profile.household_id.filter(household_id)].map((c) => ({
      member_id: c.member_id,
      score: c.score,
      utilization_pct: c.utilization_pct,
      hard_inquiries_12m: c.hard_inquiries_12m,
      oldest_account_years: c.oldest_account_years,
      late_payments_24m: c.late_payments_24m,
    })),
  };

  const result = analyzeHousehold(input, isoDay(ctx.timestamp));
  const now = ctx.timestamp;

  // --- health indicators: upsert by id, drop keys that no longer apply
  const keepIndicators = new Set<string>();
  for (const i of result.indicators) {
    const id = `${household_id}:${i.key}`;
    keepIndicators.add(id);
    const row = { id, household_id, key: i.key, label: i.label, value: i.value, unit: i.unit, status: i.status, explanation: i.explanation, updated_at: now };
    if (ctx.db.health_indicator.id.find(id)) ctx.db.health_indicator.id.update(row);
    else ctx.db.health_indicator.insert(row);
  }
  for (const old of [...ctx.db.health_indicator.household_id.filter(household_id)]) {
    if (!keepIndicators.has(old.id)) ctx.db.health_indicator.id.delete(old.id);
  }

  // --- forecast: upsert by date, skip untouched rows, drop days that rolled out of the window
  const keepDays = new Set<string>();
  for (const p of result.forecast) {
    const id = `${household_id}:${p.date}`;
    keepDays.add(id);
    const prev = ctx.db.forecast_point.id.find(id);
    const row = { id, household_id, date: p.date, balance: p.balance, obligations_due: p.obligations_due };
    if (!prev) ctx.db.forecast_point.insert(row);
    else if (prev.balance !== p.balance || prev.obligations_due !== p.obligations_due) ctx.db.forecast_point.id.update(row);
  }
  for (const old of [...ctx.db.forecast_point.household_id.filter(household_id)]) {
    if (!keepDays.has(old.id)) ctx.db.forecast_point.id.delete(old.id);
  }

  // --- rule alerts: ids start with "rule:"; keep created_at / acknowledgement of findings that persist
  type AlertRow = NonNullable<ReturnType<typeof ctx.db.alert.id.find>>;
  const existing = new Map<string, AlertRow>();
  for (const a of ctx.db.alert.household_id.filter(household_id)) {
    if (a.id.startsWith(RULE_PREFIX)) existing.set(a.id, a);
  }
  const keepAlerts = new Set<string>();
  for (const a of result.alerts) {
    keepAlerts.add(a.id);
    const related = JSON.stringify(a.related_ids);
    const prev = existing.get(a.id);
    if (!prev) {
      ctx.db.alert.insert({ id: a.id, household_id, severity: a.severity, kind: a.kind, title: a.title, detail: a.detail, related_ids_json: related, created_at: now, acknowledged_by: '' });
    } else if (prev.severity !== a.severity || prev.kind !== a.kind || prev.title !== a.title || prev.detail !== a.detail || prev.related_ids_json !== related) {
      ctx.db.alert.id.update({ ...prev, severity: a.severity, kind: a.kind, title: a.title, detail: a.detail, related_ids_json: related });
    }
  }
  for (const id of existing.keys()) {
    if (!keepAlerts.has(id)) ctx.db.alert.id.delete(id);
  }

  ctx.db.dirty_household.household_id.delete(household_id);
}

/** Insert the single 60-second interval row behind `tick_recompute` if it is not there yet. */
export function ensureTick(ctx: Ctx): void {
  if (ctx.db.recompute_tick.count() === 0n) {
    ctx.db.recompute_tick.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(60_000_000n) });
  }
}
