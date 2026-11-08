import { describe, expect, it } from 'vitest';
import type { HouseholdData } from '../types.js';
import { findSavings, sortBill } from './bills.js';

const o = (name: string, kind: string, amount: number) => ({ id: name, household_id: 'hh', name, amount, due_day: 1, account_id: '', kind });
const rivera = [
  o('State Farm auto + home', 'insurance', 212.88), o('Spectrum internet', 'bill', 79.99), o('City of Dallas water', 'bill', 88),
  o('TXU Energy electric', 'bill', 168), o('AT&T family wireless plan', 'bill', 188.45), o('Atmos Energy gas', 'bill', 52),
  o("Sofia's volleyball club dues", 'bill', 145), o("Mateo's after-school academy", 'tuition', 320), o("Sofia's braces payment plan", 'bill', 185),
  o('Netflix', 'subscription', 15.49), o('Spotify Family', 'subscription', 16.99), o('Disney+', 'subscription', 13.99), o('Amazon Prime', 'subscription', 14.99),
  o('Mortgage (Trinity Federal)', 'loan', 2218.44), o('F-150 auto loan (Lone Star CU)', 'loan', 612.3), o('College fund contribution', 'bill', 500),
  o('Rewards Visa payment', 'loan', 2195), o('Gas Mastercard payment', 'loan', 717),
];

describe('find_savings: which bills could the family cut', () => {
  it('sorts the Riveras: extras to cut, plans to shop around, debts and essentials to keep', () => {
    const r = findSavings.run({}, { data: { obligations: rivera } as unknown as HouseholdData, external: {} as never }) as {
      can_cut: { name: string }[]; can_cut_total: number; shop_around: { name: string }[]; keep_paying: { name: string; why: string }[]; monthly_bills_total: number;
    };
    expect(r.can_cut.map((x) => x.name)).toEqual(["Sofia's volleyball club dues", 'Spotify Family', 'Netflix', 'Amazon Prime', 'Disney+']);
    expect(r.can_cut_total).toBe(206.46);
    expect(r.shop_around.map((x) => x.name)).toEqual(['AT&T family wireless plan', 'Spectrum internet']);
    const keep = Object.fromEntries(r.keep_paying.map((x) => [x.name, x.why]));
    expect(keep['Rewards Visa payment']).toMatch(/late fees/); // never "pause a card payment"
    expect(keep['Mortgage (Trinity Federal)']).toBe('housing');
    expect(keep['City of Dallas water']).toMatch(/essential/); // water is water, never "electricity"
    expect(keep['College fund contribution']).toMatch(/saving, not spending/);
    expect(r.monthly_bills_total).toBe(7743.52);
  });

  it('keeps rent, and does not read "rent" inside other words', () => {
    expect(sortBill({ name: 'Rent (Oakview Apartments)', kind: 'bill' }).verdict).toBe('keep');
    expect(sortBill({ name: 'Parenting club dues', kind: 'bill' }).verdict).toBe('cut');
    expect(sortBill({ name: 'Boost Mobile', kind: 'bill' }).verdict).toBe('shop');
  });
});
