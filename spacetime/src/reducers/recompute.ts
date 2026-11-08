// Scheduled recompute (every 60 s) of households that changed, plus a daily refresh so forecasts roll forward.
import spacetimedb, { recompute_tick } from '../schema';
import { recomputeHousehold } from '../recompute';
import { backfillCreditHistory, needsBackfill } from '../credit_store';
import { closeExpiredProposals } from '../proposals';
import { isoDay } from '../util';

const MAX_PER_TICK = 20;

/**
 * Fired by the `recompute_tick` schedule row. Scheduled reducers are private in SpacetimeDB 2.x, so clients cannot
 * call this directly. It recomputes (a) households flagged dirty by seed/import reducers and (b) households whose
 * indicators were last computed on a previous day or that have no cash_flow row yet (a module upgrade), at most MAX_PER_TICK per run. It also closes family-voting proposals
 * whose deadline has passed (`cast_vote` rejects late votes either way; the status flip is what the UI shows).
 */
export const tick_recompute = spacetimedb.reducer(
  { onSchedule: recompute_tick },
  { arg: recompute_tick.rowType },
  (ctx) => {
    closeExpiredProposals(ctx); // family voting: proposals past their deadline become "closed"
    const today = isoDay(ctx.timestamp);
    const todo: string[] = [];
    const seen = new Set<string>();
    for (const d of ctx.db.dirty_household.iter()) {
      if (!seen.has(d.household_id)) { seen.add(d.household_id); todo.push(d.household_id); }
    }
    for (const hh of ctx.db.household.iter()) {
      if (seen.has(hh.id)) continue;
      const marker = ctx.db.health_indicator.id.find(`${hh.id}:liquidity_runway`);
      // no cash_flow row yet: the module was upgraded since this household's last recompute (self-healing backfill)
      const stale = !marker || isoDay(marker.updated_at) !== today || !ctx.db.cash_flow.household_id.find(hh.id);
      if (stale) { seen.add(hh.id); todo.push(hh.id); }
    }
    todo.sort();
    for (const id of todo.slice(0, MAX_PER_TICK)) {
      if (!ctx.db.household.id.find(id)) {
        ctx.db.dirty_household.household_id.delete(id);
        continue;
      }
      try {
        recomputeHousehold(ctx, id);
        // households that predate the credit history (or were never backfilled) get their monthly points once
        if (needsBackfill(ctx, id)) {
          try {
            backfillCreditHistory(ctx, id);
          } catch (e) {
            console.error(`tick_recompute: credit history for ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        console.error(`tick_recompute: ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
        ctx.db.dirty_household.household_id.delete(id); // do not retry a poison household every minute
      }
    }
  },
);
