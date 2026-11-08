// Presence, sandboxes.
import { Timestamp } from 'spacetimedb';
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { recomputeHousehold } from '../recompute';
import { backfillCreditHistory } from '../credit_store';
import { enqueueProposalCheck } from '../proposals';
import { ROLES, cleanText, enqueueJob, fail, randomSuffix, requireHousehold, upsertPresence, isSeededProposal } from '../util';

/** Upsert the caller's presence. household_id "" means the lobby. Call it again as a heartbeat to refresh last_seen. */
export const join_room = spacetimedb.reducer(
  { household_id: t.string(), display_name: t.string(), role: t.string() },
  (ctx, { household_id, display_name, role }) => {
    const name = cleanText(display_name, 'display_name', 40);
    if (!(ROLES as readonly string[]).includes(role)) fail(`role must be one of ${ROLES.join(', ')}`);
    if (household_id !== '') requireHousehold(ctx, household_id);
    upsertPresence(ctx, household_id, name, role);
  },
);

/**
 * Deep-copy a household (members, accounts, transactions, credit profiles, obligations, conversations) into a
 * private sandbox `hh_sbx_<suffix>` owned by the caller, remap every foreign key, recompute its health math, put the
 * caller in the new room, and queue a data_quality agent job.
 *
 * Copied ids keep their type prefix and gain a `__<suffix>` tail (txn_00042 -> txn_00042__k3x9aq) so they stay unique.
 * Goals, alerts, agent output and bank links (plaid_item, bank_connection) are not copied; they start empty.
 * Proposals are copied (see the block below), together with the seeded member votes.
 */
export const create_sandbox = spacetimedb.reducer(
  { template_household_id: t.string(), display_name: t.string() },
  (ctx, { template_household_id, display_name }) => {
    const name = cleanText(display_name, 'display_name', 40);
    const tpl = requireHousehold(ctx, template_household_id);

    let suffix = randomSuffix(ctx, 6);
    for (let i = 0; i < 20 && ctx.db.household.id.find(`hh_sbx_${suffix}`); i++) suffix = randomSuffix(ctx, 6);
    const hh = `hh_sbx_${suffix}`;
    if (ctx.db.household.id.find(hh)) fail('could not allocate a sandbox id, try again');
    const rid = (id: string): string => `${id}__${suffix}`;

    ctx.db.household.insert({
      id: hh,
      name: `${tpl.name} (sandbox)`,
      city: tpl.city,
      state: tpl.state,
      persona: tpl.persona,
      home_value: tpl.home_value,
      vehicle_value: tpl.vehicle_value,
      template_id: tpl.id,
      owner: ctx.sender,
      created_at: ctx.timestamp,
    });

    const memberIds = new Map<string, string>();
    for (const m of ctx.db.member.household_id.filter(tpl.id)) {
      const id = rid(m.id);
      memberIds.set(m.id, id);
      ctx.db.member.insert({ ...m, id, household_id: hh });
    }
    const accountIds = new Map<string, string>();
    for (const a of ctx.db.account.household_id.filter(tpl.id)) {
      const id = rid(a.id);
      accountIds.set(a.id, id);
      let owners: string[] = [];
      try {
        const parsed: unknown = JSON.parse(a.owner_member_ids_json);
        if (Array.isArray(parsed)) owners = parsed.map((o) => memberIds.get(String(o)) ?? String(o));
      } catch {
        owners = [];
      }
      ctx.db.account.insert({ ...a, id, household_id: hh, owner_member_ids_json: JSON.stringify(owners) });
    }
    for (const x of ctx.db.txn.household_id.filter(tpl.id)) {
      ctx.db.txn.insert({ ...x, id: rid(x.id), household_id: hh, account_id: accountIds.get(x.account_id) ?? x.account_id });
    }
    for (const c of ctx.db.credit_profile.household_id.filter(tpl.id)) {
      ctx.db.credit_profile.insert({ ...c, member_id: memberIds.get(c.member_id) ?? rid(c.member_id), household_id: hh });
    }
    for (const o of ctx.db.obligation.household_id.filter(tpl.id)) {
      ctx.db.obligation.insert({ ...o, id: rid(o.id), household_id: hh, account_id: accountIds.get(o.account_id) ?? o.account_id });
    }
    for (const c of ctx.db.conversation.household_id.filter(tpl.id)) {
      ctx.db.conversation.insert({ ...c, id: rid(c.id), household_id: hh });
    }
    // Proposals and the seeded votes (voter_key is a member id; votes by real identities stay in the template).
    // An open proposal gets a fresh voting window of the same length, so the sandbox owner can vote right away.
    // The affordability verdict is a function of the household's numbers, which the copy shares, so it is kept
    // (run_id is cleared: the trace belongs to the template). A proposal without a verdict gets its check queued.
    for (const p of ctx.db.proposal.household_id.filter(tpl.id)) {
      if (!isSeededProposal(p.id)) continue; // only seeded proposals: never a visitor's
      const pid = rid(p.id);
      const span = p.closes_at.microsSinceUnixEpoch - p.created_at.microsSinceUnixEpoch;
      const copy = ctx.db.proposal.insert({
        ...p,
        id: pid,
        household_id: hh,
        run_id: '',
        ...(p.status === 'open' ? { created_at: ctx.timestamp, closes_at: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + (span > 0n ? span : 7n * 86_400_000_000n)) } : {}),
      });
      for (const v of ctx.db.vote.proposal_id.filter(p.id)) {
        const voterKey = memberIds.get(v.voter_key);
        if (!voterKey) continue; // a real identity's vote, not a seeded member vote
        ctx.db.vote.insert({ ...v, id: `${pid}:${voterKey}`, proposal_id: pid, household_id: hh, voter_key: voterKey });
      }
      if (copy.verdict === '' && copy.status === 'open') enqueueProposalCheck(ctx, copy);
    }

    const prev = ctx.db.presence.identity.find(ctx.sender);
    upsertPresence(ctx, hh, name, prev && prev.role !== 'guest' ? prev.role : 'guest');

    recomputeHousehold(ctx, hh);
    try {
      backfillCreditHistory(ctx, hh); // ~6 monthly credit-score points from each past month's transactions
    } catch (e) {
      console.error(`create_sandbox: credit history for ${hh} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    enqueueJob(ctx, 'data_quality', hh, hh, { template_household_id: tpl.id, created_by: name });
  },
);

/**
 * Owner-only cleanup (not in contracts.md): a sandbox (`hh_sbx_*`, handy for judges who want a fresh copy) or an
 * onboarding household (`hh_onb_*`, docs/contracts.md section 7: a half-finished or test onboarding).
 */
export const delete_sandbox = spacetimedb.reducer({ household_id: t.string() }, (ctx, { household_id }) => {
  const hh = requireHousehold(ctx, household_id);
  const isSandbox = household_id.startsWith('hh_sbx_') && hh.template_id !== '';
  const isOnboarding = household_id.startsWith('hh_onb_');
  if (!isSandbox && !isOnboarding) fail('only sandboxes and onboarding households can be deleted');
  if (!hh.owner || !hh.owner.isEqual(ctx.sender)) fail('only the sandbox owner can delete it');

  for (const r of [...ctx.db.member.household_id.filter(household_id)]) ctx.db.member.id.delete(r.id);
  for (const r of [...ctx.db.account.household_id.filter(household_id)]) ctx.db.account.id.delete(r.id);
  for (const r of [...ctx.db.txn.household_id.filter(household_id)]) ctx.db.txn.id.delete(r.id);
  for (const r of [...ctx.db.credit_profile.household_id.filter(household_id)]) ctx.db.credit_profile.member_id.delete(r.member_id);
  for (const r of [...ctx.db.obligation.household_id.filter(household_id)]) ctx.db.obligation.id.delete(r.id);
  for (const r of [...ctx.db.conversation.household_id.filter(household_id)]) ctx.db.conversation.id.delete(r.id);
  for (const r of [...ctx.db.health_indicator.household_id.filter(household_id)]) ctx.db.health_indicator.id.delete(r.id);
  for (const r of [...ctx.db.forecast_point.household_id.filter(household_id)]) ctx.db.forecast_point.id.delete(r.id);
  for (const r of [...ctx.db.alert.household_id.filter(household_id)]) ctx.db.alert.id.delete(r.id);
  for (const r of [...ctx.db.credit_score.household_id.filter(household_id)]) ctx.db.credit_score.id.delete(r.id);
  for (const r of [...ctx.db.credit_score_history.household_id.filter(household_id)]) ctx.db.credit_score_history.id.delete(r.id);
  for (const r of [...ctx.db.goal.household_id.filter(household_id)]) ctx.db.goal.id.delete(r.id);
  for (const r of [...ctx.db.huddle.household_id.filter(household_id)]) ctx.db.huddle.id.delete(r.id);
  for (const r of [...ctx.db.transcript_line.household_id.filter(household_id)]) ctx.db.transcript_line.id.delete(r.id);
  for (const r of [...ctx.db.scenario.household_id.filter(household_id)]) ctx.db.scenario.id.delete(r.id);
  for (const r of [...ctx.db.coach_message.household_id.filter(household_id)]) ctx.db.coach_message.id.delete(r.id);
  for (const r of [...ctx.db.advisor_note.household_id.filter(household_id)]) ctx.db.advisor_note.id.delete(r.id);
  for (const r of [...ctx.db.vote.household_id.filter(household_id)]) ctx.db.vote.id.delete(r.id);
  for (const r of [...ctx.db.proposal.household_id.filter(household_id)]) ctx.db.proposal.id.delete(r.id);
  for (const r of [...ctx.db.trace_event.household_id.filter(household_id)]) ctx.db.trace_event.id.delete(r.id);
  for (const r of [...ctx.db.agent_run.household_id.filter(household_id)]) ctx.db.agent_run.run_id.delete(r.run_id);
  for (const r of [...ctx.db.agent_job.household_id.filter(household_id)]) ctx.db.agent_job.id.delete(r.id);
  for (const r of [...ctx.db.presence.household_id.filter(household_id)]) {
    ctx.db.presence.identity.update({ ...r, household_id: '' });
  }
  for (const r of [...ctx.db.bank_account_option.household_id.filter(household_id)]) ctx.db.bank_account_option.id.delete(r.id);
  ctx.db.household_profile.household_id.delete(household_id);
  for (const r of [...ctx.db.bank_connection.household_id.filter(household_id)]) ctx.db.bank_connection.item_id.delete(r.item_id);
  for (const r of [...ctx.db.plaid_item.household_id.filter(household_id)]) ctx.db.plaid_item.item_id.delete(r.item_id);
  ctx.db.phone_access.household_id.delete(household_id);
  ctx.db.phone_access_status.household_id.delete(household_id);
  ctx.db.dirty_household.household_id.delete(household_id);
  ctx.db.household.id.delete(household_id);
});
