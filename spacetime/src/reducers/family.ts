// Client-callable reducers used by the family room and the advisor console.
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { recomputeHousehold } from '../recompute';
import { callerName, cleanText, enqueueJob, fail, newId, requireHousehold } from '../util';

export const request_simulation = spacetimedb.reducer(
  { household_id: t.string(), prompt: t.string() },
  (ctx, { household_id, prompt }) => {
    requireHousehold(ctx, household_id);
    const text = cleanText(prompt, 'prompt', 1000);
    const id = newId(ctx, 'scn_', (x) => !!ctx.db.scenario.id.find(x));
    const who = callerName(ctx);
    ctx.db.scenario.insert({
      id,
      household_id,
      prompt: text,
      status: 'queued',
      result_json: '',
      requested_by_name: who,
      created_at: ctx.timestamp,
    });
    enqueueJob(ctx, 'what_if', household_id, id, { scenario_id: id, prompt: text, requested_by: who });
  },
);

export const ask_coach = spacetimedb.reducer(
  { household_id: t.string(), text: t.string() },
  (ctx, { household_id, text }) => {
    requireHousehold(ctx, household_id);
    const msg = cleanText(text, 'text', 1000);
    const who = callerName(ctx);
    const row = ctx.db.coach_message.insert({
      id: 0n,
      household_id,
      role: 'user',
      author_name: who,
      text: msg,
      run_id: '',
      created_at: ctx.timestamp,
    });
    enqueueJob(ctx, 'coach', household_id, row.id.toString(), { message_id: row.id.toString(), text: msg, asked_by: who });
  },
);

/**
 * Family edit of a goal. id "" creates a new one. For an existing goal the AI fields (feasibility, evidence_quote,
 * source) are preserved, except that changing the amount or date clears feasibility because the old verdict is stale.
 */
export const upsert_goal = spacetimedb.reducer(
  {
    id: t.string(),
    household_id: t.string(),
    title: t.string(),
    target_amount: t.f64(),
    target_date: t.string(),
    priority: t.i32(),
  },
  (ctx, { id, household_id, title, target_amount, target_date, priority }) => {
    requireHousehold(ctx, household_id);
    const clean = cleanText(title, 'title', 140);
    if (!Number.isFinite(target_amount) || target_amount < 0) fail('target_amount must be a non-negative number');
    const date = cleanText(target_date, 'target_date', 32, true);
    const prev = id ? ctx.db.goal.id.find(id) : null;
    if (prev) {
      if (prev.household_id !== household_id) fail('goal belongs to another household');
      const changed = prev.target_amount !== target_amount || prev.target_date !== date;
      ctx.db.goal.id.update({
        ...prev,
        title: clean,
        target_amount,
        target_date: date,
        priority,
        feasibility: changed ? '' : prev.feasibility,
        updated_at: ctx.timestamp,
      });
      return;
    }
    const newGoalId = id || newId(ctx, 'goal_', (x) => !!ctx.db.goal.id.find(x));
    if (ctx.db.goal.id.find(newGoalId)) fail('goal id already exists');
    ctx.db.goal.insert({
      id: newGoalId,
      household_id,
      title: clean,
      target_amount,
      target_date: date,
      priority,
      feasibility: '',
      evidence_quote: '',
      source: 'manual',
      created_at: ctx.timestamp,
      updated_at: ctx.timestamp,
    });
  },
);

export const delete_goal = spacetimedb.reducer({ id: t.string() }, (ctx, { id }) => {
  ctx.db.goal.id.delete(id);
});

export const ack_alert = spacetimedb.reducer(
  { alert_id: t.string(), display_name: t.string() },
  (ctx, { alert_id, display_name }) => {
    const a = ctx.db.alert.id.find(alert_id);
    if (!a) fail(`unknown alert "${alert_id}"`);
    const who = cleanText(display_name, 'display_name', 40, true) || callerName(ctx);
    ctx.db.alert.id.update({ ...a, acknowledged_by: who });
  },
);

export const post_advisor_note = spacetimedb.reducer(
  { household_id: t.string(), author_name: t.string(), text: t.string() },
  (ctx, { household_id, author_name, text }) => {
    requireHousehold(ctx, household_id);
    const author = cleanText(author_name, 'author_name', 40);
    const body = cleanText(text, 'text', 2000);
    const note = ctx.db.advisor_note.insert({ id: 0n, household_id, author_name: author, text: body, created_at: ctx.timestamp });
    ctx.db.alert.insert({
      id: newId(ctx, 'alt_adv_', (x) => !!ctx.db.alert.id.find(x)),
      household_id,
      severity: 'info',
      kind: 'advisor',
      title: `Advisor note from ${author}`,
      detail: body.length > 240 ? `${body.slice(0, 237)}...` : body,
      related_ids_json: JSON.stringify([note.id.toString()]),
      created_at: ctx.timestamp,
      acknowledged_by: '',
    });
  },
);

/** Recompute health indicators, the 90-day forecast and rule-based alerts. Deterministic and idempotent. */
export const recompute_household = spacetimedb.reducer({ household_id: t.string() }, (ctx, { household_id }) => {
  recomputeHousehold(ctx, household_id);
});
