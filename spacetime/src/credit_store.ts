// Tables <-> credit.ts glue: write `credit_score`, today's `credit_score_history` point and `credit` alerts from a recompute,
// and backfill the monthly history. The math is in credit.ts (pure, unit-tested); this file only reads and writes rows.
import {
  backfillHistory,
  creditAlert,
  scoreHousehold,
  type CreditFactor,
  type ScoreChange,
} from './credit';
import { formatDay, parseDay, type HouseholdInput, type Indicator } from './finance';
import { loadHouseholdInput } from './household_input';
import { isoDay, type Ctx } from './util';

function parseFactors(json: string): CreditFactor[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as CreditFactor[]) : [];
  } catch {
    return [];
  }
}

/** An onboarding household whose bank data is still arriving: its numbers move as rows land, so nothing is "a change" yet. */
function inOnboarding(ctx: Ctx, household_id: string): boolean {
  const p = ctx.db.household_profile.household_id.find(household_id);
  return !!p && p.onboarding_status !== 'done';
}

/** True once the household has any history point older than `today`: the baseline a score change is measured against. */
function hasBaseline(ctx: Ctx, household_id: string, today: string): boolean {
  if (inOnboarding(ctx, household_id)) return false;
  for (const h of ctx.db.credit_score_history.household_id.filter(household_id)) if (h.date < today) return true;
  return false;
}

function putHistory(ctx: Ctx, household_id: string, member_id: string, date: string, score: number): boolean {
  const id = `${member_id}:${date}`;
  const prev = ctx.db.credit_score_history.id.find(id);
  if (!prev) {
    ctx.db.credit_score_history.insert({ id, household_id, member_id, date, score });
    return true;
  }
  if (prev.score !== score) ctx.db.credit_score_history.id.update({ ...prev, score });
  return false;
}

/**
 * Called by `recomputeHousehold` with the indicators it just computed. Upserts one `credit_score` row per scored member,
 * today's history point (idempotent per day) and, when a member's score moved by 15 points or more since the last look and the
 * household already has a history baseline, one `credit` alert per household per day. Members that are no longer scored lose their row.
 */
export function updateCreditScores(ctx: Ctx, household_id: string, input: HouseholdInput, indicators: readonly Indicator[]): void {
  const today = isoDay(ctx.timestamp);
  const now = ctx.timestamp;
  const scores = scoreHousehold(input, indicators, today);
  const names = new Map<string, string>();
  for (const m of ctx.db.member.household_id.filter(household_id)) names.set(m.id, m.name);
  const baseline = hasBaseline(ctx, household_id, today);

  const keep = new Set<string>();
  const changes: ScoreChange[] = [];
  for (const s of scores) {
    keep.add(s.member_id);
    const factors_json = JSON.stringify(s.factors);
    const prev = ctx.db.credit_score.id.find(s.member_id);
    if (!prev) {
      ctx.db.credit_score.insert({ id: s.member_id, household_id, member_id: s.member_id, score: s.score, band: s.band, factors_json, updated_at: now });
    } else {
      if (baseline) {
        changes.push({ member_id: s.member_id, name: names.get(s.member_id) ?? s.member_id, before: prev.score, after: s.score, prev_factors: parseFactors(prev.factors_json), factors: s.factors });
      }
      if (prev.score !== s.score || prev.band !== s.band || prev.factors_json !== factors_json || prev.household_id !== household_id) {
        ctx.db.credit_score.id.update({ id: s.member_id, household_id, member_id: s.member_id, score: s.score, band: s.band, factors_json, updated_at: now });
      }
    }
    putHistory(ctx, household_id, s.member_id, today, s.score);
  }
  for (const old of [...ctx.db.credit_score.household_id.filter(household_id)]) {
    if (!keep.has(old.id)) ctx.db.credit_score.id.delete(old.id);
  }

  const draft = creditAlert(household_id, today, changes);
  if (draft && !ctx.db.alert.id.find(draft.id)) {
    ctx.db.alert.insert({
      id: draft.id,
      household_id,
      severity: draft.severity,
      kind: 'credit',
      title: draft.title,
      detail: draft.detail,
      related_ids_json: JSON.stringify(draft.related_ids),
      created_at: now,
      acknowledged_by: '',
    });
  }
}

/**
 * Write the monthly history points (about six, one per calendar month back from today, only where there are enough transactions
 * behind the date) by recomputing household health from each past month's transactions. Idempotent: the same data writes the same
 * rows. Never writes an alert. Returns how many rows were added.
 */
export function backfillCreditHistory(ctx: Ctx, household_id: string): number {
  const input = loadHouseholdInput(ctx, household_id);
  const today = isoDay(ctx.timestamp);
  let added = 0;
  for (const point of backfillHistory(input, today)) {
    for (const m of point.members) if (putHistory(ctx, household_id, m.member_id, point.date, m.score)) added++;
  }
  return added;
}

/**
 * True when the household has no monthly history yet: no point at least 20 days old (a household scored only by its own daily
 * recomputes has nothing before today, or only a few days of it). False while an onboarding household is still importing
 * (`finish_onboarding` backfills it once the data is in). A household with under a month of transactions stays "needing" it,
 * which costs one cheap no-op per scheduled recompute.
 */
export function needsBackfill(ctx: Ctx, household_id: string): boolean {
  if (inOnboarding(ctx, household_id)) return false;
  const day = parseDay(isoDay(ctx.timestamp));
  if (day === null) return false;
  const cutoff = formatDay(day - 20);
  for (const h of ctx.db.credit_score_history.household_id.filter(household_id)) if (h.date <= cutoff) return false;
  return true;
}
