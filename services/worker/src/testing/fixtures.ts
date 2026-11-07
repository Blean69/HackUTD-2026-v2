// Test fixtures: a small hand-built household and a loader that builds HouseholdData from data/seed/*.json.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, HouseholdData, Txn } from '../types.js';

export function acct(p: Partial<Account> & Pick<Account, 'id' | 'type'>): Account {
  return { household_id: 'hh_test', institution: 'Test Bank', nickname: p.id, balance: 0, opened_date: '2020-01-01', owner_member_ids: [], ...p };
}

export function txn(p: Partial<Txn> & Pick<Txn, 'id' | 'date' | 'amount'>): Txn {
  return { household_id: 'hh_test', account_id: 'chk', merchant: 'Misc', category: 'shopping', description: '', is_recurring: false, ...p };
}

/** ~100 days of a household earning $5,000/mo and spending ~$3,900/mo on checking, $20k cash, $10k savings, a car loan and a card. */
export function smallHousehold(extra: Partial<HouseholdData> = {}): HouseholdData {
  const txns: Txn[] = [];
  let n = 0;
  const day = (offset: number): string => new Date(Date.UTC(2026, 10, 7) - offset * 86_400_000).toISOString().slice(0, 10);
  for (let m = 0; m < 4; m++) {
    txns.push(txn({ id: `t${n++}`, date: day(m * 30 + 3), amount: 5000, merchant: 'Employer', category: 'income' }));
    txns.push(txn({ id: `t${n++}`, date: day(m * 30 + 5), amount: -1500, merchant: 'Landlord', category: 'rent', is_recurring: true }));
    txns.push(txn({ id: `t${n++}`, date: day(m * 30 + 8), amount: -450, merchant: 'Auto Finance', category: 'loan_payment', is_recurring: true }));
    txns.push(txn({ id: `t${n++}`, date: day(m * 30 + 9), amount: -300, merchant: 'Savings move', category: 'transfer' }));
    for (let g = 0; g < 8; g++) txns.push(txn({ id: `t${n++}`, date: day(m * 30 + g * 3 + 1), amount: -(60 + ((g * 7) % 25)), merchant: g % 2 ? 'Kroger' : 'HEB', category: 'groceries' }));
    for (let g = 0; g < 6; g++) txns.push(txn({ id: `t${n++}`, date: day(m * 30 + g * 4 + 2), amount: -(500 / 6 + (g % 3) * 3), merchant: 'Utilities & misc', category: 'utilities' }));
  }
  return {
    household: { id: 'hh_test', name: 'Test Family', city: 'Dallas', state: 'TX', persona: 'A test family.', template_id: '' },
    members: [{ id: 'm1', household_id: 'hh_test', name: 'Alex Test', age: 40, role: 'parent', income_annual: 60000 }],
    accounts: [
      acct({ id: 'chk', type: 'checking', nickname: 'Checking', balance: 20000 }),
      acct({ id: 'sav', type: 'savings', nickname: 'Savings', balance: 10000, rate_pct: 4 }),
      acct({ id: 'car', type: 'auto_loan', nickname: 'Car loan', balance: 12000, rate_pct: 6.5, monthly_payment: 450 }),
      acct({ id: 'card', type: 'credit_card', nickname: 'Visa', balance: 3000, rate_pct: 22, credit_limit: 10000 }),
    ],
    txns,
    credit: [{ member_id: 'm1', household_id: 'hh_test', score: 700, utilization_pct: 30, hard_inquiries_12m: 1, oldest_account_years: 10, late_payments_24m: 0 }],
    obligations: [{ id: 'o1', household_id: 'hh_test', name: 'Rent', amount: 1500, due_day: 1, account_id: 'chk', kind: 'bill' }],
    health: [{ key: 'savings_rate', label: 'Savings rate', value: 20, unit: 'pct', status: 'good', explanation: 'Saving 20% of income.' }],
    forecast: Array.from({ length: 90 }, (_v, i) => ({ date: new Date(Date.UTC(2026, 10, 7) + i * 86_400_000).toISOString().slice(0, 10), balance: 20000 + i * 35, obligations_due: i % 30 === 0 ? 1500 : 0 })),
    goals: [],
    asOf: '2026-11-07',
    ...extra,
  };
}

const SEED_DIR = join(new URL('.', import.meta.url).pathname, '../../../../data/seed');
export const seedAvailable = (): boolean => existsSync(join(SEED_DIR, 'households.json')) && existsSync(join(SEED_DIR, 'transactions.json'));

function rows<T>(file: string): T[] {
  return JSON.parse(readFileSync(join(SEED_DIR, file), 'utf8')) as T[];
}

/** HouseholdData for a seed household straight from data/seed (no DB). health/forecast are empty: those are computed in SpacetimeDB. */
export function seedHousehold(id: string): HouseholdData {
  const hh = rows<{ id: string; name: string; city: string; state: string; persona: string }>('households.json').find((h) => h.id === id);
  if (!hh) throw new Error(`no seed household ${id}`);
  const accounts = rows<Record<string, any>>('accounts.json').filter((a) => a.household_id === id);
  const accountIds = new Set(accounts.map((a) => a.id));
  return {
    household: { id: hh.id, name: hh.name, city: hh.city, state: hh.state, persona: hh.persona, template_id: '' },
    members: rows<Record<string, any>>('members.json').filter((m) => m.household_id === id) as never,
    accounts: accounts.map((a) => ({ ...a, owner_member_ids: a.owner_member_ids ?? [] })) as never,
    // the ground-truth `anomaly` field is dropped here exactly as the real loader drops anomaly_truth
    txns: rows<Record<string, any>>('transactions.json')
      .filter((t) => t.household_id === id || accountIds.has(t.account_id))
      .map((t) => ({ id: t.id, household_id: id, account_id: t.account_id, date: t.date, amount: t.amount, merchant: t.merchant, category: t.category, description: t.description, is_recurring: Boolean(t.is_recurring) })),
    credit: rows<Record<string, any>>('credit_profiles.json').filter((c) => c.household_id === id) as never,
    obligations: rows<Record<string, any>>('obligations.json').filter((o) => o.household_id === id) as never,
    health: [],
    forecast: [],
    goals: [],
    asOf: '2026-11-07',
  };
}

export function seedConversations(id: string): { id: string; household_id: string; title: string; turns: { speaker: string; text: string }[] }[] {
  return rows<any>('conversations.json').filter((c: { household_id: string }) => c.household_id === id);
}
