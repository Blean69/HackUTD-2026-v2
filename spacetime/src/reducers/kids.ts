// Kids and teens (docs/contracts.md section 12): a parent adds chores, the kid taps "I did it", the parent approves, and the
// reward lands in the kid's savings jar. Hackathon scope like every client reducer: anyone in the room may call these.
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { callerName, cleanText, fail, newId, requireHousehold } from '../util';
import type { Ctx } from '../util';

const MAX_REWARD = 1000;

function memberIn(ctx: Ctx, household_id: string, member_id: string) {
  const m = ctx.db.member.id.find(member_id);
  if (!m || m.household_id !== household_id) fail(`"${member_id}" is not a member of this household`);
  return m;
}

function creditJar(ctx: Ctx, household_id: string, member_id: string, amount: number) {
  const jar = ctx.db.kid_jar.member_id.find(member_id);
  if (jar) ctx.db.kid_jar.member_id.update({ ...jar, balance: jar.balance + amount, earned_total: jar.earned_total + Math.max(0, amount), updated_at: ctx.timestamp });
  else ctx.db.kid_jar.insert({ member_id, household_id, balance: amount, earned_total: Math.max(0, amount), goal_title: '', goal_target: 0, updated_at: ctx.timestamp });
}

/** Add an open chore for one kid. */
export const add_kid_task = spacetimedb.reducer(
  { household_id: t.string(), member_id: t.string(), title: t.string(), reward: t.f64(), author_name: t.string() },
  (ctx, { household_id, member_id, title, reward, author_name }) => {
    requireHousehold(ctx, household_id);
    memberIn(ctx, household_id, member_id);
    const clean = cleanText(title, 'title', 80);
    if (!Number.isFinite(reward) || reward < 0 || reward > MAX_REWARD) fail(`reward must be between 0 and ${MAX_REWARD}`);
    const id = newId(ctx, 'kt_', (x) => !!ctx.db.kid_task.id.find(x));
    ctx.db.kid_task.insert({
      id, household_id, member_id, title: clean, reward: Math.round(reward * 100) / 100, status: 'open',
      created_by_name: cleanText(author_name, 'author_name', 40, true) || callerName(ctx), created_at: ctx.timestamp, updated_at: ctx.timestamp,
    });
  },
);

/** The kid says it is finished: open -> done. Anything else is a no-op (double taps are fine). */
export const complete_kid_task = spacetimedb.reducer({ task_id: t.string() }, (ctx, { task_id }) => {
  const k = ctx.db.kid_task.id.find(task_id);
  if (!k) fail(`unknown task "${task_id}"`);
  if (k.status === 'open') ctx.db.kid_task.id.update({ ...k, status: 'done', updated_at: ctx.timestamp });
});

/** A parent confirms: done -> approved, and the reward is paid into the jar exactly once. */
export const approve_kid_task = spacetimedb.reducer({ task_id: t.string() }, (ctx, { task_id }) => {
  const k = ctx.db.kid_task.id.find(task_id);
  if (!k) fail(`unknown task "${task_id}"`);
  if (k.status !== 'done') return;
  ctx.db.kid_task.id.update({ ...k, status: 'approved', updated_at: ctx.timestamp });
  creditJar(ctx, k.household_id, k.member_id, k.reward);
});

/** Not done yet: done -> open again. */
export const reopen_kid_task = spacetimedb.reducer({ task_id: t.string() }, (ctx, { task_id }) => {
  const k = ctx.db.kid_task.id.find(task_id);
  if (!k) fail(`unknown task "${task_id}"`);
  if (k.status === 'done') ctx.db.kid_task.id.update({ ...k, status: 'open', updated_at: ctx.timestamp });
});

export const delete_kid_task = spacetimedb.reducer({ task_id: t.string() }, (ctx, { task_id }) => {
  if (ctx.db.kid_task.id.find(task_id)) ctx.db.kid_task.id.delete(task_id);
});

const MAX_DEPOSIT = 500;

/**
 * A parent puts money straight into a kid's jar (an allowance, a birthday gift), from the Kids page or by asking Brian.
 * The jar is allowance bookkeeping inside the app, not a bank transfer.
 */
export const deposit_kid_jar = spacetimedb.reducer(
  { household_id: t.string(), member_id: t.string(), amount: t.f64() },
  (ctx, { household_id, member_id, amount }) => {
    requireHousehold(ctx, household_id);
    memberIn(ctx, household_id, member_id);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_DEPOSIT) fail(`amount must be more than 0 and at most ${MAX_DEPOSIT}`);
    creditJar(ctx, household_id, member_id, Math.round(amount * 100) / 100);
  },
);

/** What the kid is saving for. target 0 clears it. */
export const set_kid_goal = spacetimedb.reducer(
  { household_id: t.string(), member_id: t.string(), title: t.string(), target: t.f64() },
  (ctx, { household_id, member_id, title, target }) => {
    requireHousehold(ctx, household_id);
    memberIn(ctx, household_id, member_id);
    if (!Number.isFinite(target) || target < 0 || target > 100_000) fail('target must be between 0 and 100000');
    const clean = target === 0 ? '' : cleanText(title, 'title', 60);
    const jar = ctx.db.kid_jar.member_id.find(member_id);
    if (jar) ctx.db.kid_jar.member_id.update({ ...jar, goal_title: clean, goal_target: target, updated_at: ctx.timestamp });
    else ctx.db.kid_jar.insert({ member_id, household_id, balance: 0, earned_total: 0, goal_title: clean, goal_target: target, updated_at: ctx.timestamp });
  },
);

/** The payoff: once the jar covers the goal, spend it. The goal clears and the balance drops by the target. */
export const redeem_kid_goal = spacetimedb.reducer({ member_id: t.string() }, (ctx, { member_id }) => {
  const jar = ctx.db.kid_jar.member_id.find(member_id);
  if (!jar || jar.goal_target <= 0) fail('no goal to redeem');
  if (jar.balance < jar.goal_target) fail('not enough saved yet');
  ctx.db.kid_jar.member_id.update({ ...jar, balance: jar.balance - jar.goal_target, goal_title: '', goal_target: 0, updated_at: ctx.timestamp });
});
