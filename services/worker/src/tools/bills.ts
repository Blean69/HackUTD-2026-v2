// "Which bills should we cut?": a deterministic sort of the household's monthly bills into what could be cut or paused, what is
// worth shopping around, and what to keep paying (with why). The model reads the result instead of improvising, so it never
// suggests skipping a loan or card payment and never mislabels a bill.
import { z } from 'zod';
import type { Obligation } from '../types.js';
import { round2, usd } from '../util.js';
import { defineTool } from './registry.js';

const STREAMING = /netflix|hulu|disney|spotify|prime|youtube|hbo|\bmax\b|peacock|paramount|apple\s*(tv|music|one)|audible|sirius|xbox|playstation|nintendo/i;
const EXTRAS = /club|dues|membership|gym|fitness|lessons?|subscription|box\b|delivery/i;
const SHOP = /internet|wireless|mobile|cell|phone|cable|\btv\b|satellite|fiber/i;
const UTILITY = /water|electric|energy|power|\bgas\b|sewer|trash/i;
const SAVING = /college fund|savings|529|contribution|invest/i;
const KIDS_COMMITTED = /tuition|after.?school|daycare|child ?care|braces|orthodont|medical|doctor|therapy/i;
const DEBT = /mortgage|loan|\bcard\b|payment(?! plan)|\brent\b/i;

export type BillVerdict = 'cut' | 'shop' | 'keep';
export function sortBill(o: Pick<Obligation, 'name' | 'kind'>): { verdict: BillVerdict; why: string } {
  const n = o.name;
  if (o.kind === 'loan' || (DEBT.test(n) && !STREAMING.test(n))) return { verdict: 'keep', why: /rent|mortgage/i.test(n) ? 'housing' : 'skipping a debt payment brings late fees and hurts credit' };
  if (o.kind === 'insurance') return { verdict: 'keep', why: 'you need the cover' };
  if (o.kind === 'tuition' || KIDS_COMMITTED.test(n)) return { verdict: 'keep', why: 'already committed for the kids' };
  if (SAVING.test(n)) return { verdict: 'keep', why: 'this is saving, not spending; pausing it delays the goal' };
  if (UTILITY.test(n)) return { verdict: 'keep', why: 'essential; you can use less, not cancel' };
  if (o.kind === 'subscription' || STREAMING.test(n) || EXTRAS.test(n)) return { verdict: 'cut', why: STREAMING.test(n) ? 'a streaming subscription you could cancel or share' : 'an extra you could pause or trim' };
  if (SHOP.test(n)) return { verdict: 'shop', why: 'worth comparing plans; a cheaper plan could lower it' };
  return { verdict: 'keep', why: 'a regular bill' };
}

export const findSavings = defineTool({
  name: 'find_savings',
  description:
    'Which monthly bills the family could cut or pause (subscriptions, clubs, extras), which are worth shopping around (phone, internet), ' +
    'and which to keep paying (loans, cards, mortgage, insurance, utilities, tuition) with the reason. Use it for "which bills should we cut", "how can we save".',
  schema: z.object({}),
  describe: () => 'Sorting the bills: what could be cut, what to keep',
  run: (_args, { data }) => {
    const rows = data.obligations.filter((o) => o.amount > 0).map((o) => ({ name: o.name, monthly: round2(o.amount), ...sortBill(o) }));
    const by = (v: BillVerdict) => rows.filter((r) => r.verdict === v).sort((a, b) => b.monthly - a.monthly);
    const cut = by('cut');
    const shop = by('shop');
    const keep = by('keep');
    return {
      can_cut: cut.map(({ name, monthly, why }) => ({ name, monthly, why })),
      can_cut_total: round2(cut.reduce((s, r) => s + r.monthly, 0)),
      shop_around: shop.map(({ name, monthly }) => ({ name, monthly })),
      keep_paying: keep.map(({ name, monthly, why }) => ({ name, monthly, why })),
      monthly_bills_total: round2(rows.reduce((s, r) => s + r.monthly, 0)),
    };
  },
  summarize: (r) => `Could cut ${r.can_cut.length} bill(s), about ${usd(r.can_cut_total)} a month; ${r.shop_around.length} to shop around; ${r.keep_paying.length} to keep paying`,
});
