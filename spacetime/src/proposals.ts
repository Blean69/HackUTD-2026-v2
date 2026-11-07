// Family-voting helpers shared by the reducers (docs/contracts.md section 6). Not exported from index.ts.
import { Timestamp } from 'spacetimedb';
import { enqueueJob, fail, type Ctx } from './util';

export const VOTE_CHOICES = ['yes', 'no', 'abstain'] as const;
export const DAY_MICROS = 86_400_000_000n;

type ProposalRow = NonNullable<ReturnType<Ctx['db']['proposal']['id']['find']>>;

/** Parse a details_json string into a plain object. "" becomes {}; arrays, scalars and invalid JSON are rejected. */
export function normalizeDetails(details_json: string): string {
  const raw = (details_json ?? '').trim();
  if (raw === '') return '{}';
  if (raw.length > 2000) fail('details_json is too long (max 2000 characters)');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return fail('details_json must be a JSON object');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('details_json must be a JSON object');
  return JSON.stringify(v);
}

/** Is voting still possible? A proposal is open only while its status is "open" AND its deadline has not passed. */
export function votingOpen(p: ProposalRow, now: Timestamp): boolean {
  return p.status === 'open' && now.microsSinceUnixEpoch < p.closes_at.microsSinceUnixEpoch;
}

/** Queue the affordability check: a `what_if` job whose subject is the proposal (the worker's what_if workflow detects it). */
export function enqueueProposalCheck(ctx: Ctx, p: ProposalRow): void {
  let details: unknown = {};
  try {
    details = JSON.parse(p.details_json);
  } catch {
    details = {};
  }
  enqueueJob(ctx, 'what_if', p.household_id, p.id, {
    proposal_id: p.id,
    title: p.title,
    amount: p.amount,
    details,
    created_by: p.created_by_name,
    closes_at: new Date(Number(p.closes_at.microsSinceUnixEpoch / 1000n)).toISOString(),
  });
}

/** Flip proposals whose deadline passed to "closed". Called by the 60 s tick (a failing cast_vote cannot do it: it rolls back). */
export function closeExpiredProposals(ctx: Ctx): number {
  let n = 0;
  for (const p of [...ctx.db.proposal.iter()]) {
    if (p.status === 'open' && ctx.timestamp.microsSinceUnixEpoch >= p.closes_at.microsSinceUnixEpoch) {
      ctx.db.proposal.id.update({ ...p, status: 'closed' });
      n++;
    }
  }
  return n;
}
