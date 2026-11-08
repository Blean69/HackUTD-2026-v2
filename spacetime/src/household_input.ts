// Reads one household's rows into the plain-data shape the pure math (finance.ts, credit.ts) works on.
import { isAutoObligation, type HouseholdInput } from './finance';
import { fail, type Ctx } from './util';

/**
 * The household's accounts, transactions (never `anomaly_truth`), obligations, members and credit profiles.
 *
 * Obligations: the seeded or hand-entered rows only. The `auto:*` rows are recompute's own output (bills detected from the
 * transactions), never its input: an imported household (any Plaid account) with no other obligation on file gets
 * `derive_obligations`, and the math re-reads its bills from the transactions every time.
 */
export function loadHouseholdInput(ctx: Ctx, household_id: string): HouseholdInput {
  const hh = ctx.db.household.id.find(household_id);
  if (!hh) fail(`unknown household "${household_id}"`);
  const accountRows = [...ctx.db.account.household_id.filter(household_id)];
  const onFile = [...ctx.db.obligation.household_id.filter(household_id)].filter((o) => !isAutoObligation(o.id));
  const input: HouseholdInput = {
    household_id,
    home_value: hh.home_value,
    vehicle_value: hh.vehicle_value,
    accounts: accountRows.map((a) => ({
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
    obligations: onFile.map((o) => ({
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
    derive_obligations: onFile.length === 0 && accountRows.some((a) => a.source === 'plaid'),
  };
  return input;
}
