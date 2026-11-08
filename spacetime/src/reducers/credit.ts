// Credit score monitoring reducers (docs/contracts.md section 9). The per-day score update lives in `recompute_household`
// (recompute.ts -> credit_store.ts); this file adds the history backfill the seed script, `create_sandbox` and
// `finish_onboarding` use.
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { backfillCreditHistory, needsBackfill } from '../credit_store';
import { recomputeHousehold } from '../recompute';
import { fail, requireHousehold, type Ctx } from '../util';

const MAX_HOUSEHOLDS_PER_CALL = 25;

function requireWorker(ctx: Ctx): void {
  if (!ctx.db.worker.identity.find(ctx.sender)) fail('worker only');
}

/**
 * Worker-only. Write about six monthly `credit_score_history` points for a household by recomputing its household health from
 * each past month's transactions (only for dates with at least 28 days of transactions behind them). Computes the household's
 * `credit_score` rows and today's point first if they do not exist yet. Idempotent. With household_id "" it backfills every
 * household that has no history yet (at most 25 per call), which catches sandboxes and onboarding households that predate the feature.
 */
export const backfill_credit_history = spacetimedb.reducer({ household_id: t.string() }, (ctx, { household_id }) => {
  requireWorker(ctx);
  const targets: string[] = [];
  if (household_id === '') {
    for (const hh of ctx.db.household.iter()) {
      if (targets.length >= MAX_HOUSEHOLDS_PER_CALL) break;
      if (needsBackfill(ctx, hh.id)) targets.push(hh.id);
    }
  } else {
    requireHousehold(ctx, household_id);
    targets.push(household_id);
  }
  for (const id of targets) {
    let scored = false;
    for (const _ of ctx.db.credit_score.household_id.filter(id)) { scored = true; break; }
    if (!scored) recomputeHousehold(ctx, id);
    const added = backfillCreditHistory(ctx, id);
    console.info(`backfill_credit_history: ${id} +${added} points`);
  }
});
