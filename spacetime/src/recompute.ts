// Glue between the tables and the pure math in finance.ts: read a household's rows, run `analyzeHousehold`,
// and replace the derived rows (health_indicator, forecast_point, rule alerts, credit scores) for that household.
import { ScheduleAt } from 'spacetimedb';
import { analyzeHousehold } from './finance';
import { loadHouseholdInput } from './household_input';
import { updateCreditScores } from './credit_store';
import { isoDay, type Ctx } from './util';

const RULE_PREFIX = 'rule:';

export function recomputeHousehold(ctx: Ctx, household_id: string): void {
  const input = loadHouseholdInput(ctx, household_id);

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

  // --- shared cash numbers (cash_flow, cash_month): the same rules as the savings-rate indicator, for every screen and agent
  const c = result.cash;
  const flowRow = {
    household_id, as_of: result.as_of, window_days: c.window_days, income_monthly: c.income_monthly, expense_monthly: c.expense_monthly,
    net_monthly: c.net_monthly, savings_rate: c.savings_rate, categories_json: JSON.stringify(c.categories), updated_at: now,
  };
  if (ctx.db.cash_flow.household_id.find(household_id)) ctx.db.cash_flow.household_id.update(flowRow);
  else ctx.db.cash_flow.insert(flowRow);
  const keepMonths = new Set<string>();
  for (const m of c.months) {
    const id = `${household_id}:${m.month}`;
    keepMonths.add(id);
    const prev = ctx.db.cash_month.id.find(id);
    const row = { id, household_id, month: m.month, income: m.income, expenses: m.expenses, net: m.net, partial: m.partial };
    if (!prev) ctx.db.cash_month.insert(row);
    else if (prev.income !== m.income || prev.expenses !== m.expenses || prev.partial !== m.partial) ctx.db.cash_month.id.update(row);
  }
  for (const old of [...ctx.db.cash_month.household_id.filter(household_id)]) {
    if (!keepMonths.has(old.id)) ctx.db.cash_month.id.delete(old.id);
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

  // --- synthetic credit scores (docs/contracts.md section 9). Must never break the health math, so a failure is only logged.
  try {
    updateCreditScores(ctx, household_id, input, result.indicators);
  } catch (e) {
    console.error(`credit scores for ${household_id} failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  ctx.db.dirty_household.household_id.delete(household_id);
}

/** Insert the single 60-second interval row behind `tick_recompute` if it is not there yet. */
export function ensureTick(ctx: Ctx): void {
  if (ctx.db.recompute_tick.count() === 0n) {
    ctx.db.recompute_tick.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(60_000_000n) });
  }
}
