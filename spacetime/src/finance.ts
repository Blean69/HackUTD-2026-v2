// Deterministic household finance math. PURE: no imports, no host APIs, no clock, no randomness.
//
// recompute.ts reads rows out of SpacetimeDB tables, calls `analyzeHousehold`, and writes the result back to
// `health_indicator`, `forecast_point` and `alert`. Keeping the math here means it is unit-testable with
// `node --test src/finance.test.ts` and reproducible: same rows + same `today` => byte-identical output.
//
// GROUND TRUTH IS NEVER USED. `FinTxn` has no `anomaly_truth` field on purpose: every data-quality rule below works
// from the visible columns only (date, amount, merchant, category, ...). `anomaly_truth` exists in the `txn` table
// solely so the scorer can compare our alerts against it.

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

export type Status = 'good' | 'watch' | 'risk';
export type Severity = 'info' | 'warn' | 'critical';

export interface FinAccount {
  id: string;
  type: string; // checking | savings | cd | ira | auto_loan | personal_loan | credit_card | mortgage
  nickname?: string;
  balance: number;
  rate_pct?: number;
  credit_limit?: number;
  monthly_payment?: number;
  opened_date?: string;
}
export interface FinTxn {
  id: string;
  account_id: string;
  date: string; // ISO date or datetime
  amount: number; // negative = outflow
  merchant: string;
  category: string;
  description: string;
  is_recurring: boolean;
}
export interface FinObligation {
  id: string;
  name: string;
  amount: number;
  due_day: number; // day of month, 1..31
  account_id: string;
  kind: string;
}
export interface FinMember {
  id: string;
  income_annual: number;
  role?: string;
}
export interface FinCredit {
  member_id: string;
  score: number;
  utilization_pct: number;
  hard_inquiries_12m: number;
  oldest_account_years: number;
  late_payments_24m: number;
}
export interface HouseholdInput {
  household_id: string;
  accounts: FinAccount[];
  txns: FinTxn[];
  obligations: FinObligation[];
  members: FinMember[];
  credit: FinCredit[];
  /** Estimated market value of the home / vehicle (0 if renting / none). Counted in net worth. */
  home_value: number;
  vehicle_value: number;
}

export interface Indicator {
  key: string;
  label: string;
  value: number;
  unit: string;
  status: Status;
  explanation: string;
}
export interface ForecastPoint {
  date: string; // YYYY-MM-DD
  balance: number; // projected checking+savings at end of day
  obligations_due: number; // scheduled outflows landing that day (obligations + recurring charges), positive USD
}
export interface RuleAlert {
  id: string; // always starts with `rule:` so recompute can replace exactly the rule-generated rows
  severity: Severity;
  kind: 'data_quality' | 'fraud' | 'obligation';
  title: string;
  detail: string;
  related_ids: string[];
}
/**
 * Cash flow under the SAME rules as the savings-rate and runway indicators (income into checking/savings; spending from
 * checking, savings and cards, card bill payments skipped when the card's own purchases are present, own transfers skipped,
 * refunds netted). Stored in `cash_flow` / `cash_month` so every screen and agent shows the same numbers.
 */
export interface CashFlowResult {
  window_days: number;
  income_monthly: number;
  expense_monthly: number;
  net_monthly: number;
  savings_rate: number; // % of income, identical to the savings_rate indicator
  categories: { category: string; total: number }[]; // spending over the window, largest first
  months: { month: string; income: number; expenses: number; net: number; partial: boolean }[];
}
export interface Analysis {
  as_of: string;
  indicators: Indicator[];
  forecast: ForecastPoint[];
  alerts: RuleAlert[];
  cash: CashFlowResult;
}

// ---------------------------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------------------------

export const FORECAST_DAYS = 90;
/**
 * Contract forecast = recurring inflows + obligations - average discretionary spend. This module additionally credits
 * the average of NON-recurring deposits (owner draws, catering lumps) over the same 90 days, so a household whose pay
 * is irregular is not forecast as if that income stopped. Set to false for the strict contract formula.
 */
export const FORECAST_INCLUDE_IRREGULAR_INCOME = true;
export const IMPOSSIBLE_AMOUNT = 1_000_000;
export const BURST_MIN_COUNT = 5;
export const BURST_MAX_CHARGE = 2; // "charges under $2"
export const BURST_WINDOW_MS = 60 * 60 * 1000;
const MAX_ALERTS_PER_RULE = 25;
const WINDOW_DAYS = 90;
const MS_DAY = 86_400_000;
const DAYS_PER_MONTH = 30.4375;

const LIQUID = new Set(['checking', 'savings']);
const ASSET = new Set(['checking', 'savings', 'cd', 'ira']);
const DEBT = new Set(['auto_loan', 'personal_loan', 'credit_card', 'mortgage']);
const CASHFLOW_ACCOUNTS = new Set(['checking', 'savings', 'credit_card']);

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

export const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
export const round1 = (x: number): number => Math.round((x + Number.EPSILON) * 10) / 10;

export function usd(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(n);
  const body = (abs >= 100 ? Math.round(abs).toString() : abs.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${body}`;
}

/** Days since the Unix epoch for the leading YYYY-MM-DD of `s`, or null if it is not a real calendar date. */
export function parseDay(s: string): number | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  if (new Date(ms).getUTCMonth() !== mo - 1) return null; // e.g. Feb 30
  return Math.floor(ms / MS_DAY);
}
export const formatDay = (day: number): string => new Date(day * MS_DAY).toISOString().slice(0, 10);

function ymd(day: number): { y: number; m: number; d: number } {
  const dt = new Date(day * MS_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function daysInMonth(y: number, m1: number): number {
  return new Date(Date.UTC(y, m1, 0)).getUTCDate();
}
/** Day number for (year, month) shifted by `k` months, with day-of-month `dom` clamped to the month length. */
function shiftMonths(y: number, m1: number, k: number, dom: number): number {
  const idx = y * 12 + (m1 - 1) + k;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return Math.floor(Date.UTC(ny, nm - 1, Math.min(dom, daysInMonth(ny, nm))) / MS_DAY);
}

/** Timestamp in ms. Date-only strings resolve to midnight UTC; zone-less datetimes are read as UTC. */
function parseTimestampMs(s: string): { ms: number; hasTime: boolean } | null {
  const day = parseDay(s);
  if (day === null) return null;
  const hasTime = /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s);
  if (!hasTime) return { ms: day * MS_DAY, hasTime: false };
  let iso = s.trim().replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += 'Z';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? { ms: day * MS_DAY, hasTime: false } : { ms, hasTime: true };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** FNV-1a, 32-bit, as 8 hex chars. Used only to make stable alert ids. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Lowercase letters only; digits, store numbers and punctuation dropped: "NETFLIX.COM 8001" => "netflix com". */
function normMerchant(s: string): string {
  const n = s.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  return n || s.toLowerCase().trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Rule-based data-quality / fraud-pattern alerts (visible columns only)
// ---------------------------------------------------------------------------------------------------------------

// Characters that do not belong in a merchant descriptor (kept ASCII-only in this file on purpose; the rule is
// expressed with code points so there are no escape sequences or odd glyphs to mangle).
const SYMBOL_RE = /[^\p{L}\p{N}\s.\-&',/\u2019]/gu;
const EMBEDDED_ODD_RE = /\p{L}[^\p{L}\p{N}\s.\-*#&',/_@+():!\u2019]\p{L}/u;

/** Control chars, U+FFFD, private-use, zero-width and line-separator code points. */
function isBadCodePoint(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0xfffd ||
    (c >= 0xe000 && c <= 0xf8ff) ||
    (c >= 0x200b && c <= 0x200f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0xfeff
  );
}

/**
 * UTF-8 bytes that were decoded as Latin-1 / Windows-1252 leave telltale pairs: U+00C3 or U+00C2 followed by a
 * C1/Latin-1 symbol (e.g. "cafe" with an accent shows up as A-tilde + copyright sign), U+00E2 followed by the euro
 * sign or single low quote (a mangled curly apostrophe), and U+00EF U+00BF U+00BD (a mangled replacement char).
 */
function hasMojibake(m: string): boolean {
  for (let i = 0; i < m.length - 1; i++) {
    const c = m.charCodeAt(i);
    const d = m.charCodeAt(i + 1);
    if ((c === 0xc3 || c === 0xc2) && d >= 0x80 && d <= 0xbf) return true;
    if (c === 0xe2 && (d === 0x20ac || d === 0x201a)) return true;
    if (c === 0xef && d === 0xbf && m.charCodeAt(i + 2) === 0xbd) return true;
  }
  return false;
}

export function isGarbledMerchant(merchant: string): { garbled: boolean; reason: string } {
  const m = merchant ?? '';
  if (m.trim() === '') return { garbled: true, reason: 'merchant is empty' };
  for (let i = 0; i < m.length; i++) {
    if (isBadCodePoint(m.charCodeAt(i))) return { garbled: true, reason: 'contains non-printable characters' };
  }
  if (hasMojibake(m)) return { garbled: true, reason: 'contains mojibake (mis-decoded text)' };
  // A stray symbol wedged between two letters ("Fi$st Mart", "McDo&a?d's") is what substitution noise looks like.
  if (EMBEDDED_ODD_RE.test(m)) return { garbled: true, reason: 'has stray symbols inside words' };
  const symbols = (m.match(SYMBOL_RE) ?? []).length;
  if (m.length >= 3 && symbols / m.length >= 0.2) return { garbled: true, reason: 'is mostly symbols' };
  return { garbled: false, reason: '' };
}

export interface QualityResult {
  alerts: RuleAlert[];
  /** Ids to leave out of spending/income math: later copies of a duplicate, and impossible rows. */
  excludeIds: Set<string>;
}

function capAlerts(
  hh: string,
  rule: string,
  title: string,
  alerts: RuleAlert[],
): RuleAlert[] {
  if (alerts.length <= MAX_ALERTS_PER_RULE) return alerts;
  const kept = alerts.slice(0, MAX_ALERTS_PER_RULE);
  const extra = alerts.length - MAX_ALERTS_PER_RULE;
  kept.push({
    id: `rule:${hh}:${rule}:more`,
    severity: 'info',
    kind: alerts[0]!.kind,
    title,
    detail: `${extra} more ${rule} findings are not listed individually.`,
    related_ids: alerts.slice(MAX_ALERTS_PER_RULE).flatMap((a) => a.related_ids).slice(0, 50),
  });
  return kept;
}

export function detectDataQuality(household_id: string, txns: FinTxn[], today: string): QualityResult {
  const hh = household_id;
  const todayDay = parseDay(today) ?? 0;
  const sorted = [...txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  const excludeIds = new Set<string>();

  // 1. Impossible values: |amount| > $1M, non-finite amounts, unparseable or future dates.
  const impossible: RuleAlert[] = [];
  for (const t of sorted) {
    const reasons: string[] = [];
    let severity: Severity = 'critical';
    if (!Number.isFinite(t.amount)) reasons.push('amount is not a number');
    else if (Math.abs(t.amount) > IMPOSSIBLE_AMOUNT) reasons.push(`amount ${usd(t.amount)} exceeds ${usd(IMPOSSIBLE_AMOUNT)}`);
    const day = parseDay(t.date);
    if (day === null) reasons.push(`date "${t.date}" is not a valid date`);
    else if (day > todayDay) {
      reasons.push(`date ${t.date.slice(0, 10)} is in the future`);
      if (reasons.length === 1) severity = 'warn';
    }
    if (reasons.length === 0) continue;
    excludeIds.add(t.id);
    impossible.push({
      id: `rule:${hh}:impossible:${t.id}`,
      severity,
      kind: 'data_quality',
      title: `Impossible value: ${t.merchant || '(no merchant)'} ${Number.isFinite(t.amount) ? usd(t.amount) : ''}`.trim(),
      detail: `Transaction ${t.id}: ${reasons.join('; ')}. Excluded from health math until corrected.`,
      related_ids: [t.id],
    });
  }

  // 2. Card-testing bursts: >= 5 charges under $2 at one merchant within one hour.
  // Date-only data has no clock time, so a same-day cluster is the finest resolution available.
  const byMerchant = new Map<string, { t: FinTxn; ms: number; hasTime: boolean }[]>();
  for (const t of sorted) {
    if (excludeIds.has(t.id)) continue;
    const abs = Math.abs(t.amount);
    if (!(t.amount < 0) || !(abs > 0) || abs >= BURST_MAX_CHARGE) continue;
    const key = (t.merchant ?? '').trim().toLowerCase();
    if (!key) continue;
    const ts = parseTimestampMs(t.date);
    if (!ts) continue;
    if (!byMerchant.has(key)) byMerchant.set(key, []);
    byMerchant.get(key)!.push({ t, ms: ts.ms, hasTime: ts.hasTime });
  }
  const burstIds = new Set<string>();
  const bursts: RuleAlert[] = [];
  for (const [, list] of [...byMerchant.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    list.sort((a, b) => a.ms - b.ms || (a.t.id < b.t.id ? -1 : 1));
    const marked = new Array<boolean>(list.length).fill(false);
    let j = 0;
    for (let i = 0; i < list.length; i++) {
      if (j < i) j = i;
      while (j + 1 < list.length && list[j + 1]!.ms - list[i]!.ms <= BURST_WINDOW_MS) j++;
      if (j - i + 1 >= BURST_MIN_COUNT) for (let k = i; k <= j; k++) marked[k] = true;
    }
    let i = 0;
    while (i < list.length) {
      if (!marked[i]) { i++; continue; }
      let e = i;
      while (e + 1 < list.length && marked[e + 1]) e++;
      const cluster = list.slice(i, e + 1);
      const amounts = cluster.map((c) => Math.abs(c.t.amount));
      const spanMin = Math.round((cluster[cluster.length - 1]!.ms - cluster[0]!.ms) / 60000);
      const when = cluster.every((c) => c.hasTime)
        ? `within ${spanMin} minute${spanMin === 1 ? '' : 's'}`
        : `on ${cluster[0]!.t.date.slice(0, 10)}`;
      for (const c of cluster) burstIds.add(c.t.id);
      bursts.push({
        id: `rule:${hh}:burst:${cluster[0]!.t.id}`,
        severity: 'critical',
        kind: 'fraud',
        title: `Card-testing pattern: ${cluster.length} tiny charges at ${cluster[0]!.t.merchant}`,
        detail: `${cluster.length} charges between ${usd(Math.min(...amounts))} and ${usd(Math.max(...amounts))} at "${cluster[0]!.t.merchant}" ${when}. Small repeated charges often precede larger fraudulent ones.`,
        related_ids: cluster.map((c) => c.t.id),
      });
      i = e + 1;
    }
  }

  // 3. Exact duplicates: same day, amount and merchant.
  const groups = new Map<string, FinTxn[]>();
  for (const t of sorted) {
    if (excludeIds.has(t.id) || burstIds.has(t.id)) continue;
    if (!Number.isFinite(t.amount) || Math.abs(t.amount) < 0.005) continue;
    const key = `${t.date.slice(0, 10)}|${t.amount.toFixed(2)}|${t.merchant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const dups: RuleAlert[] = [];
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    for (const extra of g.slice(1)) excludeIds.add(extra.id);
    const first = g[0]!;
    dups.push({
      id: `rule:${hh}:duplicate:${first.id}`,
      severity: 'warn',
      kind: 'data_quality',
      title: `Possible duplicate: ${first.merchant} ${usd(first.amount)} x${g.length}`,
      detail: `${g.length} identical transactions on ${first.date.slice(0, 10)} for ${usd(first.amount)} at "${first.merchant}". Extra copies are ignored in health math.`,
      related_ids: g.map((x) => x.id),
    });
  }

  // 3b. Re-posted charges: the same merchant, account and amount on consecutive days (a bank posting a charge twice).
  // Lower confidence than an exact duplicate, so it is informational and its rows stay in the math. Recurring
  // charges, fees, interest and transfers legitimately repeat and are skipped.
  const consecutive = new Map<string, { t: FinTxn; day: number }[]>();
  for (const t of sorted) {
    if (excludeIds.has(t.id) || burstIds.has(t.id) || t.is_recurring) continue;
    if (!Number.isFinite(t.amount) || Math.abs(t.amount) < 0.005) continue;
    if (/fee|interest|subscription|transfer|savings/i.test(t.category)) continue;
    const day = parseDay(t.date);
    if (day === null) continue;
    const key = `${t.account_id}|${t.merchant}|${t.amount.toFixed(2)}`;
    if (!consecutive.has(key)) consecutive.set(key, []);
    consecutive.get(key)!.push({ t, day });
  }
  const reposts: RuleAlert[] = [];
  for (const [, list] of [...consecutive.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    list.sort((a, b) => a.day - b.day || (a.t.id < b.t.id ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.day - list[i - 1]!.day !== 1) continue;
      const first = list[i - 1]!.t;
      const second = list[i]!.t;
      reposts.push({
        id: `rule:${hh}:repost:${second.id}`,
        severity: 'info',
        kind: 'data_quality',
        title: `Possible re-posted charge: ${second.merchant} ${usd(second.amount)}`,
        detail: `Same merchant, account and amount on ${first.date.slice(0, 10)} and ${second.date.slice(0, 10)}. May be one charge posted twice.`,
        related_ids: [first.id, second.id],
      });
    }
  }

  // 4. Garbled merchant strings, one alert per distinct string.
  const garbledBy = new Map<string, { reason: string; ids: string[] }>();
  for (const t of sorted) {
    if (excludeIds.has(t.id) && !burstIds.has(t.id)) {
      // duplicates and impossible rows are already reported; still allow garbled check on the kept copy only
      continue;
    }
    const g = isGarbledMerchant(t.merchant);
    if (!g.garbled) continue;
    const entry = garbledBy.get(t.merchant) ?? { reason: g.reason, ids: [] };
    entry.ids.push(t.id);
    garbledBy.set(t.merchant, entry);
  }
  const garbled: RuleAlert[] = [];
  for (const [merchant, e] of [...garbledBy.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const shown = Array.from(merchant, (ch) => (isBadCodePoint(ch.charCodeAt(0)) ? '?' : ch)).join('');
    garbled.push({
      id: `rule:${hh}:garbled:${fnv1a(merchant)}`,
      severity: 'info',
      kind: 'data_quality',
      title: `Garbled merchant name: "${shown.slice(0, 40)}"`,
      detail: `${e.ids.length} transaction${e.ids.length === 1 ? '' : 's'} with a merchant that ${e.reason}. Needs cleanup before it can be categorised.`,
      related_ids: e.ids.slice(0, 50),
    });
  }

  return {
    alerts: [
      ...capAlerts(hh, 'impossible', 'More impossible values', impossible),
      ...capAlerts(hh, 'burst', 'More card-testing bursts', bursts),
      ...capAlerts(hh, 'duplicate', 'More possible duplicates', dups),
      ...capAlerts(hh, 'repost', 'More possible re-posted charges', reposts),
      ...capAlerts(hh, 'garbled', 'More garbled merchants', garbled),
    ],
    excludeIds,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cash-flow classification
// ---------------------------------------------------------------------------------------------------------------

interface CleanTxn {
  id: string;
  account_id: string;
  acctType: string;
  day: number;
  amount: number;
  merchant: string;
  category: string;
  norm: string;
  is_recurring: boolean;
  transferLike: boolean;
  cardPayment: boolean;
  refund: boolean;
}

const CARD_PAYMENT_RE =
  /(credit\s*card|card)\s*(payment|pmt|autopay)|\bcc\s*(payment|pmt)\b|payment\s*(to|-)\s*(visa|mastercard|amex|discover|citi|capital one)/i;
const REFUND_RE = /refund|reimburse|cash\s*back|chargeback|reversal/i;

/**
 * Moves between the household's own accounts: not spending, not income. Decided by category and merchant only.
 * (Descriptions are unreliable: "ONLINE TRANSFER FROM <employer or LLC> OWNER DRAW" is income, not a transfer.)
 */
function isTransferLike(t: FinTxn): boolean {
  const cat = t.category.toLowerCase().replace(/[_-]+/g, ' ');
  if (/\b(income|payroll|salary|wages|deposit|dividend)\b/.test(cat)) return false;
  if (/\b(transfer|xfer|savings)\b/.test(cat)) return true;
  return /^\s*(online |internal )?(transfer|xfer)\s*$/i.test(t.merchant);
}

function classify(t: FinTxn, acctType: string, day: number): CleanTxn {
  // Underscores and dashes become spaces so "credit_card_payment" reads as "credit card payment".
  const text = `${t.category} ${t.merchant} ${t.description}`.replace(/[_-]+/g, ' ');
  return {
    id: t.id,
    account_id: t.account_id,
    acctType,
    day,
    amount: t.amount,
    merchant: t.merchant,
    category: t.category || 'other',
    norm: normMerchant(t.merchant),
    is_recurring: t.is_recurring,
    transferLike: isTransferLike(t),
    cardPayment: CARD_PAYMENT_RE.test(text),
    refund: REFUND_RE.test(text),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Recurring series + forecast
// ---------------------------------------------------------------------------------------------------------------

type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
interface Series {
  sign: 1 | -1;
  amount: number; // absolute
  cadence: Cadence;
  last: number;
  dom: number;
  norm: string;
  account_id: string;
  stepDays: number; // for weekly/biweekly
  ids: string[];
}

const PERIOD_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 31, quarterly: 92, annual: 366 };

function makeSeries(g: CleanTxn[], asOf: number, forceMonthly: boolean): Series | null {
  const days = [...new Set(g.map((t) => t.day))].sort((x, y) => x - y);
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push(days[i]! - days[i - 1]!);
  const gap = gaps.length ? median(gaps) : 30;
  let cadence: Cadence;
  if (forceMonthly) cadence = 'monthly';
  else if (gap <= 9) cadence = 'weekly';
  else if (gap <= 18) cadence = 'biweekly';
  else if (gap <= 45) cadence = 'monthly';
  else if (gap <= 120) cadence = 'quarterly';
  else cadence = 'annual';
  const last = days[days.length - 1]!;
  if (asOf - last > PERIOD_DAYS[cadence] * 2.5) return null; // series stopped; do not project it
  return {
    sign: g[0]!.amount >= 0 ? 1 : -1,
    amount: median(g.slice(-3).map((t) => Math.abs(t.amount))),
    cadence,
    last,
    dom: Math.round(median(days.map((d) => ymd(d).d))),
    norm: g[0]!.norm,
    account_id: g[0]!.account_id,
    stepDays: cadence === 'weekly' ? 7 : 14,
    ids: g.map((t) => t.id),
  };
}

/**
 * Twice-a-month payers (e.g. the 1st and the 15th) look "biweekly" by gap size but land on fixed days of the month.
 * If the days-of-month fall into exactly two tight clusters 10-20 days apart, split into two monthly series.
 */
function splitSemiMonthly(g: CleanTxn[]): CleanTxn[][] | null {
  if (g.length < 4) return null;
  const doms = [...new Set(g.map((t) => ymd(t.day).d))].sort((x, y) => x - y);
  const clusters: number[][] = [];
  for (const d of doms) {
    const cur = clusters[clusters.length - 1];
    if (cur && d - cur[cur.length - 1]! <= 2) cur.push(d);
    else clusters.push([d]);
  }
  if (clusters.length !== 2) return null;
  const parts = clusters.map((c) => g.filter((t) => c.includes(ymd(t.day).d)));
  const centers = clusters.map((c) => median(c));
  const sep = centers[1]! - centers[0]!;
  if (sep < 10 || sep > 20 || parts.some((p) => p.length < 2)) return null;
  return parts;
}

function buildSeries(recurring: CleanTxn[], asOf: number): Series[] {
  const groups = new Map<string, CleanTxn[]>();
  for (const t of recurring) {
    const key = `${t.amount >= 0 ? '+' : '-'}|${t.norm}|${t.account_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const out: Series[] = [];
  for (const [, g] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    g.sort((a, b) => a.day - b.day || (a.id < b.id ? -1 : 1));
    const parts = splitSemiMonthly(g);
    const made = parts ? parts.map((p) => makeSeries(p, asOf, true)) : [makeSeries(g, asOf, false)];
    for (const m of made) if (m) out.push(m);
  }
  return out;
}

function* occurrences(s: Series, asOf: number, end: number): Generator<number> {
  if (s.cadence === 'weekly' || s.cadence === 'biweekly') {
    let d = s.last;
    if (d <= asOf) d += Math.ceil((asOf - d + 1) / s.stepDays) * s.stepDays;
    for (; d <= end; d += s.stepDays) yield d;
    return;
  }
  const step = s.cadence === 'monthly' ? 1 : s.cadence === 'quarterly' ? 3 : 12;
  const base = ymd(s.last);
  for (let k = 1; k < 400; k++) {
    const d = shiftMonths(base.y, base.m, k * step, s.dom);
    if (d > end) return;
    if (d > asOf) yield d;
  }
}

function* monthlyDates(dueDay: number, asOf: number, end: number): Generator<number> {
  const base = ymd(asOf);
  const dom = Math.min(31, Math.max(1, Math.round(dueDay) || 1));
  for (let k = 0; k < 6; k++) {
    const d = shiftMonths(base.y, base.m, k, dom);
    if (d > end) return;
    if (d > asOf) yield d;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------------------------------

export function analyzeHousehold(input: HouseholdInput, today: string): Analysis {
  const todayDay = parseDay(today);
  if (todayDay === null) throw new Error(`analyzeHousehold: bad today "${today}"`);
  const hh = input.household_id;

  const accounts = [...input.accounts].sort((a, b) => (a.id < b.id ? -1 : 1));
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const obligations = [...input.obligations].sort((a, b) => (a.id < b.id ? -1 : 1));

  // --- data quality first: its findings decide which rows are trustworthy for the math below
  const quality = detectDataQuality(hh, input.txns, today);

  // --- clean, classified transactions
  const clean: CleanTxn[] = [];
  for (const t of [...input.txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))) {
    if (quality.excludeIds.has(t.id)) continue;
    const day = parseDay(t.date);
    if (day === null || day > todayDay) continue;
    const acct = acctById.get(t.account_id);
    if (!acct) continue;
    clean.push(classify(t, acct.type, day));
  }
  // The data's own "now": newest trustworthy transaction, never later than today.
  const asOf = clean.length ? clean[clean.length - 1]!.day : todayDay;
  const winStart = asOf - WINDOW_DAYS; // exclusive
  const inWin = clean.filter((t) => t.day > winStart && t.day <= asOf);
  const hasCardTxns = clean.some((t) => t.acctType === 'credit_card');

  const isCashflowTxn = (t: CleanTxn): boolean =>
    CASHFLOW_ACCOUNTS.has(t.acctType) && !t.transferLike && !(t.cardPayment && t.amount < 0 && hasCardTxns && t.acctType !== 'credit_card');
  const isIncome = (t: CleanTxn): boolean => t.amount > 0 && LIQUID.has(t.acctType) && !t.refund && isCashflowTxn(t);
  const isExpenseOut = (t: CleanTxn): boolean => t.amount < 0 && isCashflowTxn(t);
  const isRefundIn = (t: CleanTxn): boolean => t.amount > 0 && t.refund && CASHFLOW_ACCOUNTS.has(t.acctType) && !t.transferLike;

  const cfTxns = inWin.filter((t) => CASHFLOW_ACCOUNTS.has(t.acctType));
  const earliest = cfTxns.length ? Math.min(...cfTxns.map((t) => t.day)) : asOf;
  const spanDays = Math.max(30, Math.min(WINDOW_DAYS, asOf - earliest + 1));
  const months = spanDays / DAYS_PER_MONTH;

  let incomeTotal = 0;
  let expenseTotal = 0;
  for (const t of inWin) {
    if (isIncome(t)) incomeTotal += t.amount;
    else if (isExpenseOut(t)) expenseTotal += -t.amount;
    else if (isRefundIn(t)) expenseTotal -= t.amount;
  }
  expenseTotal = Math.max(0, expenseTotal);
  const obligationsMonthly = obligations.reduce((s, o) => s + (o.amount > 0 ? o.amount : 0), 0);
  const observedExpenseMonthly = expenseTotal / months;
  const monthlyExpenses = observedExpenseMonthly > 0 ? observedExpenseMonthly : obligationsMonthly;
  const observedIncomeMonthly = incomeTotal / months;
  const statedIncomeMonthly = input.members.reduce((s, m) => s + (m.income_annual > 0 ? m.income_annual : 0), 0) / 12;

  // --- shared cash numbers (cash_flow / cash_month tables): the window figures above, by category, and by calendar month
  const cashFlow: CashFlowResult = (() => {
    const byCat = new Map<string, number>();
    for (const t of inWin) {
      if (isExpenseOut(t)) byCat.set(t.category, (byCat.get(t.category) ?? 0) - t.amount);
      else if (isRefundIn(t)) byCat.set(t.category, (byCat.get(t.category) ?? 0) - t.amount);
    }
    const categories = [...byCat.entries()].filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]).map(([category, total]) => ({ category, total: round2(total) }));
    const monthOf = (day: number): string => { const x = ymd(day); return `${x.y}-${String(x.m).padStart(2, '0')}`; };
    const byMonth = new Map<string, { income: number; expenses: number }>();
    for (const t of clean) {
      const k = monthOf(t.day);
      const m = byMonth.get(k) ?? { income: 0, expenses: 0 };
      if (isIncome(t)) m.income += t.amount;
      else if (isExpenseOut(t)) m.expenses += -t.amount;
      else if (isRefundIn(t)) m.expenses -= t.amount;
      else continue;
      byMonth.set(k, m);
    }
    const first = clean.length ? clean[0]!.day : asOf;
    const firstPartial = ymd(first).d > 3;
    const months = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, m]) => ({
      month, income: round2(m.income), expenses: round2(Math.max(0, m.expenses)), net: round2(m.income - Math.max(0, m.expenses)),
      partial: month === monthOf(asOf) || (firstPartial && month === monthOf(first)),
    }));
    const incomeM = observedIncomeMonthly > 0 ? observedIncomeMonthly : statedIncomeMonthly;
    return {
      window_days: Math.round(spanDays),
      income_monthly: round2(incomeM),
      expense_monthly: round2(observedExpenseMonthly),
      net_monthly: round2(incomeM - observedExpenseMonthly),
      savings_rate: incomeM > 0 ? round1(((incomeM - observedExpenseMonthly) / incomeM) * 100) : 0,
      categories,
      months,
    };
  })();

  // --- balances
  const liquid = accounts.filter((a) => LIQUID.has(a.type)).reduce((s, a) => s + a.balance, 0);
  const savings = accounts.filter((a) => a.type === 'savings').reduce((s, a) => s + Math.max(0, a.balance), 0);
  const owed = (a: FinAccount): number => Math.abs(a.balance);
  const assets = accounts.filter((a) => ASSET.has(a.type)).reduce((s, a) => s + a.balance, 0);
  const debts = accounts.filter((a) => DEBT.has(a.type)).reduce((s, a) => s + owed(a), 0);
  const homeValue = input.home_value > 0 ? input.home_value : 0;
  const vehicleValue = input.vehicle_value > 0 ? input.vehicle_value : 0;
  const netWorth = assets + homeValue + vehicleValue - debts;

  // =============================================================================================================
  // Forecast (docs/contracts.md section 1 conventions)
  //   balance(day) = checking+savings now
  //                + recurring INFLOWS (is_recurring, amount > 0) projected by their cadence
  //                - obligations on their due_day (the complete schedule of recurring outflows, loan and card payments
  //                  included, so recurring outflow transactions are NOT subtracted again)
  //                - average daily discretionary spend (non-recurring outflows on checking/savings)
  //                + average daily irregular income (non-recurring deposits such as owner draws; see the flag)
  // =============================================================================================================
  const end = asOf + FORECAST_DAYS;
  const recurringIn = clean.filter(
    (t) => t.is_recurring && t.amount > 0 && LIQUID.has(t.acctType) && !t.transferLike && !t.refund,
  );
  const series = buildSeries(recurringIn, asOf);

  interface DayFlow { in: number; out: number; obligationIds: string[] }
  const flows = new Map<number, DayFlow>();
  const flow = (d: number): DayFlow => {
    let f = flows.get(d);
    if (!f) { f = { in: 0, out: 0, obligationIds: [] }; flows.set(d, f); }
    return f;
  };
  for (const s of series) for (const d of occurrences(s, asOf, end)) flow(d).in += s.amount;
  for (const o of obligations) {
    if (!(o.amount > 0)) continue;
    for (const d of monthlyDates(o.due_day, asOf, end)) {
      const f = flow(d);
      f.out += o.amount;
      f.obligationIds.push(o.id);
    }
  }

  // Discretionary spend / irregular income: non-recurring flows on checking+savings over the window.
  // Transfers between the household's own accounts and card payments (already scheduled as obligations) are skipped.
  let discretionaryOut = 0;
  let irregularIn = 0;
  for (const t of inWin) {
    if (t.is_recurring || !LIQUID.has(t.acctType) || t.transferLike) continue;
    if (t.cardPayment && hasCardTxns) continue;
    if (t.amount < 0) discretionaryOut += -t.amount;
    else if (t.refund) discretionaryOut -= t.amount;
    else if (FORECAST_INCLUDE_IRREGULAR_INCOME) irregularIn += t.amount;
  }
  const discretionaryDaily = Math.max(0, discretionaryOut) / spanDays;
  const irregularDaily = irregularIn / spanDays;
  const netDailyBurn = discretionaryDaily - irregularDaily;

  const forecast: ForecastPoint[] = [];
  let bal = liquid;
  let low = { balance: Infinity, date: '' };
  let firstNegative: { date: string; balance: number; obligationIds: string[] } | null = null;
  for (let d = asOf + 1; d <= end; d++) {
    const f = flows.get(d);
    bal += (f ? f.in - f.out : 0) - netDailyBurn;
    const date = formatDay(d);
    const point = { date, balance: round2(bal), obligations_due: round2(f ? f.out : 0) };
    forecast.push(point);
    if (point.balance < low.balance) low = { balance: point.balance, date };
    if (!firstNegative && point.balance < 0) {
      firstNegative = { date, balance: point.balance, obligationIds: f ? f.obligationIds : [] };
    }
  }

  // =============================================================================================================
  // Indicators
  // =============================================================================================================
  const indicators: Indicator[] = [];

  // 1. Liquidity runway
  {
    const value = liquid <= 0 ? 0 : monthlyExpenses > 0 ? Math.min(60, liquid / monthlyExpenses) : 60;
    const status: Status = liquid <= 0 ? 'risk' : value >= 6 ? 'good' : value >= 3 ? 'watch' : 'risk';
    indicators.push({
      key: 'liquidity_runway',
      label: 'Liquidity runway',
      value: round1(value),
      unit: 'months',
      status,
      explanation:
        monthlyExpenses > 0
          ? `${usd(liquid)} in checking and savings covers ${round1(value)} months of about ${usd(monthlyExpenses)} a month in spending.`
          : `${usd(liquid)} in checking and savings; no spending history yet to measure runway.`,
    });
  }

  // 2. Debt-to-income
  {
    let payments = 0;
    for (const a of accounts) {
      if (!DEBT.has(a.type)) continue;
      if (a.monthly_payment && a.monthly_payment > 0) payments += a.monthly_payment;
      else if (a.type === 'credit_card' && owed(a) > 0) payments += Math.max(25, 0.02 * owed(a));
    }
    const income = statedIncomeMonthly > 0 ? statedIncomeMonthly : observedIncomeMonthly;
    const value = income > 0 ? (payments / income) * 100 : payments > 0 ? 100 : 0;
    const status: Status = value <= 36 ? 'good' : value <= 43 ? 'watch' : 'risk';
    indicators.push({
      key: 'debt_to_income',
      label: 'Debt-to-income',
      value: round1(value),
      unit: '%',
      status,
      explanation:
        income > 0
          ? `${usd(payments)} a month in debt payments against ${usd(income)} a month of gross income (lenders like 36% or less).`
          : `${usd(payments)} a month in debt payments and no income on record.`,
    });
  }

  // 3. Credit utilization
  {
    const cards = accounts.filter((a) => a.type === 'credit_card' && a.credit_limit && a.credit_limit > 0);
    const limit = cards.reduce((s, a) => s + (a.credit_limit ?? 0), 0);
    const used = cards.reduce((s, a) => s + owed(a), 0);
    let value: number;
    let explanation: string;
    if (limit > 0) {
      value = (used / limit) * 100;
      const worst = [...cards].sort((a, b) => owed(b) / (b.credit_limit ?? 1) - owed(a) / (a.credit_limit ?? 1))[0]!;
      explanation = `${usd(used)} used of ${usd(limit)} in card limits; highest is ${worst.nickname || worst.id} at ${round1((owed(worst) / (worst.credit_limit ?? 1)) * 100)}%.`;
    } else if (input.credit.length) {
      value = input.credit.reduce((s, c) => s + c.utilization_pct, 0) / input.credit.length;
      explanation = `Average reported utilization across ${input.credit.length} credit file${input.credit.length === 1 ? '' : 's'}.`;
    } else {
      value = 0;
      explanation = 'No revolving credit lines on record.';
    }
    indicators.push({
      key: 'credit_utilization',
      label: 'Credit utilization',
      value: round1(value),
      unit: '%',
      status: value <= 30 ? 'good' : value <= 50 ? 'watch' : 'risk',
      explanation,
    });
  }

  // 4. Savings rate, last 3 months
  {
    const incomeM = observedIncomeMonthly > 0 ? observedIncomeMonthly : statedIncomeMonthly;
    const basis = observedIncomeMonthly > 0 ? 'deposits' : 'stated income';
    const saved = incomeM - observedExpenseMonthly;
    const value = incomeM > 0 ? (saved / incomeM) * 100 : 0;
    indicators.push({
      key: 'savings_rate',
      label: 'Savings rate (3 mo)',
      value: round1(value),
      unit: '%',
      status: incomeM <= 0 ? 'watch' : value >= 15 ? 'good' : value >= 5 ? 'watch' : 'risk',
      explanation:
        incomeM > 0
          ? `${usd(incomeM)} a month in (${basis}) vs ${usd(observedExpenseMonthly)} out leaves ${usd(saved)} a month, ${round1(value)}% of income.`
          : 'No income found in the last 3 months of transactions.',
    });
  }

  // 5. Net-worth trend: reconstruct the balance 90 days ago from today's balance and the transactions since.
  {
    let delta = 0;
    for (const t of clean) {
      if (t.day <= winStart || t.day > asOf) continue;
      const a = acctById.get(t.account_id);
      if (!a) continue;
      // Assets rise by their transaction amounts. A debt account's payment (+) shrinks what is owed, a purchase (-)
      // grows it, so its amount moves net worth by the same signed amount. Transfers and loan payments cancel out.
      if (ASSET.has(a.type) || DEBT.has(a.type)) delta += t.amount;
    }
    const nwThen = netWorth - delta;
    const pct = nwThen !== 0 ? (delta / Math.abs(nwThen)) * 100 : 0;
    indicators.push({
      key: 'net_worth_trend',
      label: 'Net worth trend (90 d)',
      value: round2(delta),
      unit: 'USD',
      status: delta >= 0 ? 'good' : pct > -5 ? 'watch' : 'risk',
      explanation: `Net worth is ${usd(netWorth)}${homeValue + vehicleValue > 0 ? ` (including ${usd(homeValue + vehicleValue)} of home and vehicle value)` : ''}, ${delta >= 0 ? 'up' : 'down'} ${usd(Math.abs(delta))}${Math.abs(nwThen) >= 5000 ? ` (${pct >= 0 ? '+' : ''}${round1(pct)}%)` : ''} over the last 90 days.`,
    });
  }

  // 6. Emergency fund: savings vs a 3-month cushion
  {
    const target = 3 * monthlyExpenses;
    const value = target > 0 ? Math.min(999, (savings / target) * 100) : savings > 0 ? 999 : 0;
    indicators.push({
      key: 'emergency_fund',
      label: 'Emergency fund',
      value: round1(value),
      unit: '%',
      status: value >= 100 ? 'good' : value >= 50 ? 'watch' : 'risk',
      explanation:
        target > 0
          ? `${usd(savings)} in savings is ${round1(value)}% of a 3-month cushion (${usd(target)}).`
          : `${usd(savings)} in savings; no spending history to size a cushion.`,
    });
  }

  // 7. Lowest projected balance in the next 90 days
  {
    const minBal = low.balance === Infinity ? liquid : low.balance;
    const status: Status = minBal < 0 ? 'risk' : minBal < 0.5 * monthlyExpenses ? 'watch' : 'good';
    indicators.push({
      key: 'forecast_low_point',
      label: 'Lowest balance, next 90 d',
      value: round2(minBal),
      unit: 'USD',
      status,
      explanation: firstNegative
        ? `Checking and savings are projected to go negative on ${firstNegative.date} (${usd(firstNegative.balance)}).`
        : `Projected low is ${usd(minBal)}${low.date ? ` on ${low.date}` : ''}; stays above zero for 90 days.`,
    });
  }

  // 8. Credit score (from credit_profile)
  if (input.credit.length) {
    const avg = input.credit.reduce((s, c) => s + c.score, 0) / input.credit.length;
    const late = input.credit.reduce((s, c) => s + c.late_payments_24m, 0);
    const inq = input.credit.reduce((s, c) => s + c.hard_inquiries_12m, 0);
    let status: Status = avg >= 740 ? 'good' : avg >= 670 ? 'watch' : 'risk';
    if (status === 'good' && late > 0) status = 'watch';
    indicators.push({
      key: 'credit_score',
      label: 'Credit score',
      value: Math.round(avg),
      unit: 'score',
      status,
      explanation: `Average score ${Math.round(avg)} across ${input.credit.length} credit file${input.credit.length === 1 ? '' : 's'}; ${late} late payment${late === 1 ? '' : 's'} in 24 months, ${inq} hard inquir${inq === 1 ? 'y' : 'ies'} in 12.`,
    });
  }

  // =============================================================================================================
  // Forecast-derived alert
  // =============================================================================================================
  const alerts = [...quality.alerts];
  if (firstNegative) {
    const daysOut = parseDay(firstNegative.date)! - asOf;
    alerts.push({
      id: `rule:${hh}:overdraft`,
      severity: daysOut <= 30 ? 'critical' : 'warn',
      kind: 'obligation',
      title: `Projected overdraft on ${firstNegative.date}`,
      detail: `Checking and savings are projected to reach ${usd(firstNegative.balance)} on ${firstNegative.date} (${daysOut} days out); the lowest point in the next 90 days is ${usd(low.balance)}.`,
      related_ids: firstNegative.obligationIds,
    });
  }

  return { as_of: formatDay(asOf), indicators, forecast, alerts, cash: cashFlow };
}
