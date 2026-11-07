// detect_transaction_anomalies: visible-column rules plus a robust statistical outlier score. NEVER reads ground truth
// (the Txn type has no anomaly field; the loader drops it).
import { z } from 'zod';
import type { HouseholdData, Txn } from '../types.js';
import { median, parseDay, round2, usd } from '../util.js';
import { IMPOSSIBLE_AMOUNT } from './finance.js';
import { defineTool } from './registry.js';

export type AnomalyRule = 'impossible_value' | 'duplicate' | 'garbled' | 'card_testing' | 'scam_payment' | 'account_takeover' | 'outlier';

export interface Finding {
  txn_id: string;
  rule: AnomalyRule;
  severity: 'info' | 'warn' | 'critical';
  /** Alert kind this finding maps to. */
  kind: 'data_quality' | 'fraud' | 'scam';
  score: number;
  date: string;
  amount: number;
  merchant: string;
  reason: string;
}

const SKIP_OUTLIER = new Set(['income', 'transfer', 'savings', 'mortgage', 'rent', 'loan_payment', 'tuition', 'taxes', 'insurance', 'education']);
const SCAM_MERCHANT = /gift\s*card|google\s*play|itunes|apple\s*(gift|card)|steam\s*(card|wallet)|green\s*dot|moneypak|vanilla|western\s*union|moneygram|wire\s*(transfer|out)|bitcoin|crypto|coinme|coinflip|bitcoin\s*depot|cash\s*app\s*out/i;
const TAKEOVER_DESC = /new payee|new device|password reset|unrecognized|unknown device|credentials changed|added payee|login from/i;
const SEVERITY_RANK = { critical: 3, warn: 2, info: 1 } as const;

const normMerchant = (s: string): string => s.toLowerCase().replace(/[^a-z]+/g, ' ').trim() || s.toLowerCase().trim();

function isGarbled(merchant: string): boolean {
  const m = merchant.trim();
  if (!m) return true;
  if (/[�]|Ã.|â€/.test(m)) return true; // mojibake
  const letters = (m.match(/[A-Za-z]/g) ?? []).length;
  if (m.length >= 6 && letters / m.length < 0.45) return true; // mostly digits/symbols
  if (/[^\x20-\x7E]/.test(m) && !/[À-ÿ]/.test(m)) return true; // control junk
  const words = m.split(/\s+/);
  return words.some((w) => w.length >= 7 && /^[A-Za-z0-9]+$/.test(w) && /\d/.test(w) && /[A-Za-z]/.test(w) && !/[aeiouAEIOU]/.test(w));
}

export function detectAnomalies(data: HouseholdData, opts: { since?: string; limit?: number } = {}): { findings: Finding[]; counts: Record<string, number>; scanned: number } {
  const today = parseDay(data.asOf) ?? Infinity;
  const sinceDay = opts.since ? parseDay(opts.since) : null;
  const all = data.txns;
  const found = new Map<string, Finding>(); // one finding per txn: the most severe

  const add = (t: Txn, rule: AnomalyRule, severity: Finding['severity'], kind: Finding['kind'], score: number, reason: string) => {
    const prev = found.get(t.id);
    if (prev && SEVERITY_RANK[prev.severity] >= SEVERITY_RANK[severity] && prev.score >= score) return;
    found.set(t.id, { txn_id: t.id, rule, severity, kind, score: round2(score), date: t.date.slice(0, 10), amount: t.amount, merchant: t.merchant, reason });
  };

  // 1. impossible values and dates
  for (const t of all) {
    const d = parseDay(t.date);
    if (!Number.isFinite(t.amount) || Math.abs(t.amount) >= IMPOSSIBLE_AMOUNT)
      add(t, 'impossible_value', 'warn', 'data_quality', 9, `Amount ${usd(t.amount)} is not plausible for a household account.`);
    else if (d === null) add(t, 'impossible_value', 'warn', 'data_quality', 7, `Date "${t.date}" is not a real calendar date.`);
    else if (d > today) add(t, 'impossible_value', 'warn', 'data_quality', 6, `Dated ${t.date.slice(0, 10)}, which is in the future.`);
  }
  const usable = all.filter((t) => {
    const d = parseDay(t.date);
    return d !== null && d <= today && Math.abs(t.amount) < IMPOSSIBLE_AMOUNT && Number.isFinite(t.amount);
  });

  // 2. duplicates: same account + merchant + amount on the same or adjacent day
  const groups = new Map<string, Txn[]>();
  for (const t of usable) {
    const k = `${t.account_id}|${normMerchant(t.merchant)}|${t.amount}`;
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => parseDay(a.date)! - parseDay(b.date)!);
    for (let i = 1; i < g.length; i++) {
      const gap = parseDay(g[i]!.date)! - parseDay(g[i - 1]!.date)!;
      if (gap <= 1) add(g[i]!, 'duplicate', 'warn', 'data_quality', 5, `Same ${usd(g[i]!.amount)} charge at ${g[i]!.merchant} appears twice within a day (${g[i - 1]!.id}).`);
    }
  }

  // 3. garbled merchant names
  for (const t of usable) if (isGarbled(t.merchant)) add(t, 'garbled', 'warn', 'data_quality', 4, `Merchant "${t.merchant.slice(0, 40)}" looks corrupted.`);

  // 4. card testing: a burst of tiny charges
  const small = usable.filter((t) => t.amount < 0 && -t.amount < 2);
  const byAcctDay = new Map<string, Txn[]>();
  for (const t of small) {
    const key = `${t.account_id}|${t.date.slice(0, 10)}`;
    byAcctDay.set(key, [...(byAcctDay.get(key) ?? []), t]);
  }
  for (const g of byAcctDay.values()) {
    if (g.length < 5) continue;
    for (const t of g) add(t, 'card_testing', 'critical', 'fraud', 8, `${g.length} charges under $2 on one day looks like a card-testing burst.`);
  }

  // 5. scam-style payments (gift cards, wires, crypto)
  for (const t of usable) {
    if (t.amount >= 0) continue;
    const scammy = t.category === 'gift_cards' || SCAM_MERCHANT.test(t.merchant) || SCAM_MERCHANT.test(t.description);
    if (scammy && -t.amount >= 200) add(t, 'scam_payment', 'critical', 'scam', 9 + Math.min(1, -t.amount / 5000), `${usd(-t.amount)} to ${t.merchant}: gift-card, wire or crypto payments of this size are the classic scam payment.`);
  }

  // 6. account takeover hints
  for (const t of usable) {
    if (t.amount < -500 && TAKEOVER_DESC.test(t.description)) add(t, 'account_takeover', 'critical', 'fraud', 8.5, `Large outflow whose description mentions a new payee, device or password change.`);
  }

  // 7. statistical outliers (median / MAD) per category and per merchant
  const spend = usable.filter((t) => t.amount < 0 && !SKIP_OUTLIER.has(t.category));
  const byCat = new Map<string, number[]>();
  const byMerch = new Map<string, number[]>();
  for (const t of spend) {
    const a = -t.amount;
    byCat.set(t.category, [...(byCat.get(t.category) ?? []), a]);
    const m = normMerchant(t.merchant);
    byMerch.set(m, [...(byMerch.get(m) ?? []), a]);
  }
  const robust = (xs: number[], x: number): number => {
    const med = median(xs);
    const mad = median(xs.map((v) => Math.abs(v - med))) || med * 0.25 || 1;
    return (0.6745 * (x - med)) / mad;
  };
  for (const t of spend) {
    const a = -t.amount;
    if (a < 75) continue;
    const cat = byCat.get(t.category) ?? [];
    const merch = byMerch.get(normMerchant(t.merchant)) ?? [];
    const zc = cat.length >= 8 ? robust(cat, a) : 0;
    const zm = merch.length >= 4 ? robust(merch, a) : 0;
    const z = Math.max(zc, zm);
    if (z >= 4.5) add(t, 'outlier', 'info', 'fraud', Math.min(7, z), `${usd(a)} at ${t.merchant} is far above this household's usual ${zm >= zc ? 'spend there' : `${t.category} spending`} (robust z ${round2(z)}).`);
  }

  let list = [...found.values()];
  if (sinceDay !== null) list = list.filter((f) => (parseDay(f.date) ?? 0) >= sinceDay);
  list.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.score - a.score || (a.date < b.date ? 1 : -1));
  const counts: Record<string, number> = {};
  for (const f of list) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  return { findings: list.slice(0, opts.limit ?? 25), counts, scanned: usable.length };
}

export const detectTransactionAnomalies = defineTool({
  name: 'detect_transaction_anomalies',
  description:
    'Scan transactions for data-quality problems (duplicates, garbled merchants, impossible values) and fraud/scam patterns (card testing, gift-card or wire payments, account-takeover hints, statistical outliers). Uses only visible fields.',
  schema: z.object({
    since: z.string().optional().describe('Only report findings on or after this YYYY-MM-DD date'),
    limit: z.number().int().min(1).max(30).optional().describe('Max findings (default 10)'),
  }),
  describe: (a) => `Scanning transactions for anomalies${a.since ? ` since ${a.since}` : ''}`,
  run: (a, { data }) => {
    const r = detectAnomalies(data, { ...(a.since ? { since: a.since } : {}), limit: a.limit ?? 10 });
    return { scanned: r.scanned, counts: r.counts, findings: r.findings };
  },
  summarize: (r) => {
    const total = Object.values(r.counts as Record<string, number>).reduce((s, n) => s + n, 0);
    return total ? `${total} suspicious transactions: ${Object.entries(r.counts as Record<string, number>).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}` : `No anomalies in ${r.scanned} transactions`;
  },
});
