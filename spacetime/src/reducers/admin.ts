// Operator-only reducers. Today: rotating the worker-secret hash without editing source (see src/config.ts).
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { CONFIG_ID, readConfig } from '../config';
import { fail, isSeededProposal } from '../util';
import { recomputeHousehold } from '../recompute';

/**
 * Set (or with "" clear) the SHA-256 that `register_worker` accepts, overriding the dev hash compiled into the module.
 *
 *   printf %s "$WORKER_SECRET" | sha256sum | cut -d' ' -f1      # then pass the hex digest
 *
 * Who may call it:
 *  - the publisher: `init` records `ctx.sender` of the publishing call in `module_config.publisher` (verified against a real
 *    SpacetimeDB 2.14.1 server: the recorded identity equals the CLI identity that ran `spacetime publish`). The publisher can call it any time, including to rotate.
 *  - LEGACY ONLY, for a database published before `init` recorded anyone (init does not re-run on a republish): while no
 *    publisher is recorded AND no override exists yet, a caller that is already registered as a worker may set the first
 *    override, and is then recorded as the publisher so it can rotate later. Document: DEPLOY.md, "database published
 *    before this change".
 * Everyone else gets "not allowed". The hash is stored in a private table; it is never logged or returned.
 */
export const admin_set_worker_secret_hash = spacetimedb.reducer({ sha256_hex: t.string() }, (ctx, { sha256_hex }) => {
  const cfg = readConfig(ctx);
  let allowed = false;
  let adopt = false;
  if (cfg?.publisher) {
    allowed = cfg.publisher.isEqual(ctx.sender);
  } else if ((cfg?.worker_secret_hash ?? '') === '' && ctx.db.worker.identity.find(ctx.sender)) {
    allowed = true;
    adopt = true;
  }
  if (!allowed) fail('not allowed: only the identity that published this database can change the worker secret hash');

  const hex = (sha256_hex ?? '').trim().toLowerCase();
  if (hex !== '' && !/^[0-9a-f]{64}$/.test(hex)) fail('sha256_hex must be 64 hex characters (pass "" to go back to the dev default)');

  const row = {
    id: CONFIG_ID,
    publisher: adopt ? ctx.sender : cfg?.publisher,
    worker_secret_hash: hex,
    updated_at: ctx.timestamp,
  };
  if (cfg) ctx.db.module_config.id.update(row);
  else ctx.db.module_config.insert(row);
  console.info(`admin_set_worker_secret_hash: ${hex === '' ? 'override cleared (dev default active)' : 'override set'}`);
});

/**
 * Put a shared demo household back to its seeded state, e.g. right before a judging slot: everything visitors added (Ask chat,
 * what-ifs, goals, kids' chores and jars, agent jobs, runs and traces, Table Mode sessions, alerts, new proposals and guest
 * votes) is removed. The seeded data stays (members, accounts, transactions, bills, sample conversations, the seeded proposal
 * and the family's votes on it), and the household is recomputed. Publisher only:
 *   docker exec keystone-spacetime-1 spacetime call -s local keystone admin_reset_household '"hh_rivera"'
 */
export const admin_reset_household = spacetimedb.reducer({ household_id: t.string() }, (ctx, { household_id }) => {
  const cfg = readConfig(ctx);
  if (!cfg?.publisher || !cfg.publisher.isEqual(ctx.sender)) fail('not allowed: only the identity that published this database can reset a household');
  if (!ctx.db.household.id.find(household_id)) fail(`unknown household "${household_id}"`);
  const members = new Set([...ctx.db.member.household_id.filter(household_id)].map((m) => m.id));
  let removed = 0;
  const drop = <R>(rows: Iterable<R>, del: (r: R) => void): void => {
    for (const r of [...rows]) {
      del(r);
      removed++;
    }
  };
  drop(ctx.db.coach_message.household_id.filter(household_id), (r) => ctx.db.coach_message.id.delete(r.id));
  drop(ctx.db.scenario.household_id.filter(household_id), (r) => ctx.db.scenario.id.delete(r.id));
  drop(ctx.db.goal.household_id.filter(household_id), (r) => ctx.db.goal.id.delete(r.id));
  drop(ctx.db.kid_task.household_id.filter(household_id), (r) => ctx.db.kid_task.id.delete(r.id));
  drop(ctx.db.kid_jar.household_id.filter(household_id), (r) => ctx.db.kid_jar.member_id.delete(r.member_id));
  drop(ctx.db.alert.household_id.filter(household_id), (r) => ctx.db.alert.id.delete(r.id)); // rule alerts come back on recompute
  drop(ctx.db.trace_event.household_id.filter(household_id), (r) => ctx.db.trace_event.id.delete(r.id));
  drop(ctx.db.agent_run.household_id.filter(household_id), (r) => ctx.db.agent_run.run_id.delete(r.run_id));
  drop(ctx.db.agent_job.household_id.filter(household_id), (r) => ctx.db.agent_job.id.delete(r.id));
  drop(ctx.db.transcript_line.household_id.filter(household_id), (r) => ctx.db.transcript_line.id.delete(r.id));
  drop(ctx.db.huddle.household_id.filter(household_id), (r) => ctx.db.huddle.id.delete(r.id));
  for (const p of [...ctx.db.proposal.household_id.filter(household_id)]) {
    const seeded = isSeededProposal(p.id);
    drop([...ctx.db.vote.proposal_id.filter(p.id)].filter((v) => !seeded || !members.has(v.voter_key)), (v) => ctx.db.vote.id.delete(v.id));
    if (!seeded) drop([p], (x) => ctx.db.proposal.id.delete(x.id));
  }
  recomputeHousehold(ctx, household_id);
  console.info(`admin_reset_household ${household_id}: removed ${removed} row(s)`);
});
