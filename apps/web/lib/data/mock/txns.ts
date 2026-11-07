/**
 * Deterministic synthetic transactions for the mock engine, so the dashboard's history and cash-flow charts have
 * something to derive from when SpacetimeDB is unreachable. About six months, double-entry for loan and card
 * payments (checking side negative, debt side positive) like data/generate.py.
 */
import type { Account, Obligation, Transaction } from "@/lib/types";
import { LIABILITY_TYPES } from "@/lib/format";
import { addDays, isoDate, NET_FACTOR } from "./math";
import type { SeedHousehold } from "./seed";

function rng(seedStr: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPEND: { category: string; merchants: string[]; weight: number }[] = [
  { category: "groceries", merchants: ["H-E-B", "Kroger", "Tom Thumb", "Aldi"], weight: 0.3 },
  { category: "dining", merchants: ["Chipotle", "Whataburger", "Torchy's Tacos", "Panera"], weight: 0.17 },
  { category: "fuel", merchants: ["Shell", "QuikTrip", "Exxon"], weight: 0.12 },
  { category: "shopping", merchants: ["Target", "Amazon", "Walmart"], weight: 0.18 },
  { category: "health", merchants: ["CVS Pharmacy", "Walgreens"], weight: 0.08 },
  { category: "kids", merchants: ["Dallas Kids Co", "Scholastic"], weight: 0.07 },
  { category: "entertainment", merchants: ["AMC Theatres", "Spotify"], weight: 0.08 },
];

const KIND_CATEGORY: Record<Obligation["kind"], string> = {
  bill: "utilities", loan: "loan_payment", subscription: "subscriptions", tuition: "education", insurance: "insurance", tax: "taxes",
};

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
}

/** The debt account a payment obligation most plausibly pays down. */
function matchDebt(o: Obligation, debts: readonly Account[]): Account | undefined {
  const ot = tokens(o.name);
  let best: Account | undefined;
  let score = 0;
  for (const a of debts) {
    const at = tokens(`${a.nickname} ${a.type.replace("_", " ")}`);
    let s = 0;
    for (const w of ot) if (at.has(w)) s++;
    if (/mortgage/i.test(o.name) && a.type === "mortgage") s += 2;
    if (a.monthly_payment === o.amount) s += 1;
    if (s > score) {
      score = s;
      best = a;
    }
  }
  return best;
}

export function buildTxns(s: SeedHousehold, now: Date): Transaction[] {
  const rand = rng(s.household.id);
  const hid = s.household.id;
  const out: Transaction[] = [];
  const chk = s.accounts.find((a) => a.type === "checking");
  if (!chk) return out;
  const card = s.accounts.find((a) => a.type === "credit_card");
  const debts = s.accounts.filter((a) => LIABILITY_TYPES.has(a.type));
  const earners = s.members.filter((m) => m.income_annual > 0);
  const short = hid.replace("hh_", "");
  let n = 0;
  const push = (account_id: string, date: Date, amount: number, merchant: string, category: string, recurring: boolean) => {
    if (date.getTime() > now.getTime()) return;
    n += 1;
    out.push({
      id: `txn_${short}_m${String(n).padStart(4, "0")}`, household_id: hid, account_id, date: isoDate(date),
      amount: Math.round(amount * 100) / 100, merchant, category, description: merchant.toUpperCase(), is_recurring: recurring,
    });
  };

  const start = addDays(now, -182);
  const first = new Date(start.getFullYear(), start.getMonth(), 1);
  for (let m = 0; m < 8; m++) {
    const y = first.getFullYear();
    const mo = first.getMonth() + m;
    const monthStart = new Date(y, mo, 1, 12);
    const lastDom = new Date(y, mo + 1, 0).getDate();
    if (new Date(y, mo, lastDom).getTime() < start.getTime()) continue;
    const at = (day: number) => new Date(y, mo, Math.min(day, lastDom), 12);

    // Paychecks, twice a month. Owner-style households get lumpier deposits.
    for (const e of earners) {
      const net = (e.income_annual * NET_FACTOR) / 24;
      for (const day of [1, 15]) {
        const date = at(day);
        if (date.getTime() < start.getTime()) continue;
        push(chk.id, date, net * (0.96 + rand() * 0.1), `${e.name.split(" ")[0]} payroll`, "income", true);
      }
    }
    // Fixed obligations, double-entry for debt payments.
    for (const o of s.obligations) {
      if (o.kind === "tax") continue;
      const date = at(o.due_day);
      if (date.getTime() < start.getTime()) continue;
      const cat = KIND_CATEGORY[o.kind];
      push(chk.id, date, -o.amount, o.name, cat, true);
      if (o.kind === "loan" || /visa|discover|card|minimum/i.test(o.name)) {
        const debt = matchDebt(o, debts);
        if (debt) push(debt.id, date, o.amount, o.name, cat, true);
      }
    }
    // Everyday spending: ~26 purchases a month, 60% on checking and 40% on the card if there is one.
    const target = s.varSpend * (0.9 + rand() * 0.2);
    const count = 26;
    for (let i = 0; i < count; i++) {
      const date = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 + Math.floor(rand() * 28), 12);
      if (date.getTime() < start.getTime()) continue;
      let r = rand();
      let pick = SPEND[0];
      for (const sp of SPEND) {
        if (r < sp.weight) {
          pick = sp;
          break;
        }
        r -= sp.weight;
      }
      const amt = (target / count) * (0.3 + rand() * 1.4) * (pick.weight * 6 > 1 ? 1 : 0.9);
      const merchant = pick.merchants[Math.floor(rand() * pick.merchants.length)];
      const acct = card && rand() < 0.4 ? card.id : chk.id;
      push(acct, date, -amt, merchant, pick.category, false);
    }
    // A little interest on savings.
    for (const sv of s.accounts.filter((a) => a.type === "savings")) push(sv.id, at(lastDom), (sv.balance * ((sv.rate_pct ?? 3) / 100)) / 12, "Interest Payment", "interest", true);
  }
  return out;
}
