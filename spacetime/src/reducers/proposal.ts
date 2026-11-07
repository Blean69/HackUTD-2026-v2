// Family voting (docs/contracts.md section 6): propose a purchase or decision, everyone in the room votes live, and a
// worker agent attaches an affordability check (`agent_update_proposal`).
import { Timestamp } from 'spacetimedb';
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { DAY_MICROS, VOTE_CHOICES, enqueueProposalCheck, normalizeDetails, votingOpen } from '../proposals';
import { callerName, cleanText, fail, newId, requireHousehold } from '../util';

const MAX_AMOUNT = 1_000_000_000;
const MAX_DAYS = 90;

/**
 * Create an open proposal and queue its affordability check (a `what_if` job with subject_id = the proposal id).
 * `closes_in_days` is a number in (0, 90]; fractions are fine. `details_json` is a JSON object or "".
 */
export const create_proposal = spacetimedb.reducer(
  {
    household_id: t.string(),
    title: t.string(),
    amount: t.f64(),
    details_json: t.string(),
    closes_in_days: t.f64(),
    author_name: t.string(),
  },
  (ctx, { household_id, title, amount, details_json, closes_in_days, author_name }) => {
    requireHousehold(ctx, household_id);
    const clean = cleanText(title, 'title', 140);
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) fail(`amount must be between 0 and ${MAX_AMOUNT}`);
    if (!Number.isFinite(closes_in_days) || closes_in_days <= 0 || closes_in_days > MAX_DAYS) fail(`closes_in_days must be greater than 0 and at most ${MAX_DAYS}`);
    const details = normalizeDetails(details_json);
    const author = cleanText(author_name, 'author_name', 40, true) || callerName(ctx);
    const id = newId(ctx, 'prop_', (x) => !!ctx.db.proposal.id.find(x));
    const closes = new Timestamp(ctx.timestamp.microsSinceUnixEpoch + BigInt(Math.max(1, Math.round(closes_in_days * Number(DAY_MICROS)))));
    const row = ctx.db.proposal.insert({
      id,
      household_id,
      title: clean,
      amount,
      details_json: details,
      created_by_name: author,
      created_at: ctx.timestamp,
      closes_at: closes,
      status: 'open',
      verdict: '',
      analysis_json: '',
      run_id: '',
    });
    enqueueProposalCheck(ctx, row);
  },
);

/** One vote per identity per proposal (`vote.id = proposal_id:identity-hex`). Calling again changes it, until the proposal closes. */
export const cast_vote = spacetimedb.reducer(
  { proposal_id: t.string(), choice: t.string(), voter_name: t.string() },
  (ctx, { proposal_id, choice, voter_name }) => {
    const p = ctx.db.proposal.id.find(proposal_id);
    if (!p) fail(`unknown proposal "${proposal_id}"`);
    if (!(VOTE_CHOICES as readonly string[]).includes(choice)) fail(`choice must be one of ${VOTE_CHOICES.join(', ')}`);
    if (!votingOpen(p, ctx.timestamp)) fail('voting on this proposal has closed');
    const name = cleanText(voter_name, 'voter_name', 40, true) || callerName(ctx);
    const voter_key = ctx.sender.toHexString();
    const id = `${proposal_id}:${voter_key}`;
    const row = { id, proposal_id, household_id: p.household_id, voter_key, voter_name: name, choice, updated_at: ctx.timestamp };
    if (ctx.db.vote.id.find(id)) ctx.db.vote.id.update(row);
    else ctx.db.vote.insert(row);
  },
);

/** Close voting now. Anyone may (hackathon scope, like every client reducer); closing twice is a no-op. */
export const close_proposal = spacetimedb.reducer({ proposal_id: t.string() }, (ctx, { proposal_id }) => {
  const p = ctx.db.proposal.id.find(proposal_id);
  if (!p) fail(`unknown proposal "${proposal_id}"`);
  if (p.status === 'closed') return;
  ctx.db.proposal.id.update({ ...p, status: 'closed' });
});
