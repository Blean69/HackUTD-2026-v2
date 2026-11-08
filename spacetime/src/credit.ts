// Synthetic credit-score monitoring (docs/contracts.md section 9). PURE: no host APIs, no clock, no randomness.
//
// recompute.ts / credit_glue.ts read rows out of SpacetimeDB tables, call the functions here and write `credit_score`,
// `credit_score_history` and `credit` alerts. Everything here is deterministic: same rows + same `today` => same output.
//
//   raw   = 0.45*household_health/100 + 0.20*payment + 0.15*utilization + 0.08*history + 0.06*new_credit + 0.06*mix
//   score = round(300 + 550*raw), clamped to 300..850
//   band  = poor (<580) | fair (580-669) | good (670-739) | very good (740-799) | exceptional (800+)
//
// `household_health` is the 0-100 Household Health score the dashboard shows: the mean of the per-indicator scores of the
// indicators `analyzeHousehold` (finance.ts) already produces. The five member factors are 0..1 (higher is better) and come
// from the member's `credit_profile` or, when a member has none (Plaid / PNC onboarded households), from the household's own
// accounts and transactions. The curves that turn raw profile numbers into 0..1 are the tuning knobs; see the CURVES block.
import {
  analyzeHousehold,
  detectDataQuality,
  formatDay,
  parseDay,
  round1,
  usd,
  type FinAccount,
  type FinCredit,
  type FinTxn,
  type HouseholdInput,
  type Indicator,
} from './finance';

// ---------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------

export type CreditBand = 'poor' | 'fair' | 'good' | 'very good' | 'exceptional';
export type FactorKey = 'household_health' | 'payment_history' | 'utilization' | 'history_length' | 'new_credit' | 'credit_mix';

export interface CreditFactor {
  key: FactorKey;
  label: string;
  /** 0..1, higher is better. */
  value: number;
  /** Contract weight (0.45, 0.20, 0.15, 0.08, 0.06, 0.06). */
  weight: number;
  /** Points this factor adds on the 300..850 scale: 550 * weight * value (one decimal). They sum to score - 300 (before the clamp). */
  points: number;
  /** The most this factor could add: 550 * weight. */
  max_points: number;
  /** One plain-English line. */
  explanation: string;
}

export interface MemberCreditProfile {
  late_payments_24m: number;
  utilization_pct: number;
  hard_inquiries_12m: number;
  oldest_account_years: number;
}

export interface CreditScoreResult {
  score: number;
  band: CreditBand;
  /** The unrounded 0..1 blend. */
  raw: number;
  factors: CreditFactor[];
}

export interface HealthRow {
  key: string;
  label: string;
  score: number;
  status: string;
  /** A short plain-English phrase about this indicator, e.g. "cash on hand covers 3.3 months of spending". */
  phrase: string;
}
export interface HealthBlend {
  /** 0..100 mean of the indicator scores (what the dashboard's Health tile shows). */
  score: number;
  label: string;
  rows: HealthRow[];
}

// ---------------------------------------------------------------------------------------------------------------
// Weights and curves
// ---------------------------------------------------------------------------------------------------------------

export const WEIGHTS = {
  household_health: 0.45,
  payment_history: 0.2,
  utilization: 0.15,
  history_length: 0.08,
  new_credit: 0.06,
  credit_mix: 0.06,
} as const;

export const SCORE_MIN = 300;
export const SCORE_MAX = 850;
export const SCORE_SPAN = 550;
/** A change of at least this many points between two looks at a member's score raises a `credit` alert. */
export const ALERT_DELTA = 15;
/** How many monthly points the backfill writes (one per calendar month back from today, newest first). */
export const HISTORY_MONTHS = 6;
/** A historical point needs at least this many days of transactions up to that date, otherwise the math has nothing to read. */
export const MIN_EVIDENCE_DAYS = 28;

type Curve = readonly (readonly [number, number])[];

/** Piecewise-linear interpolation, clamped at both ends. */
export function interp(x: number, pts: Curve): number {
  if (!(x > pts[0]![0])) return pts[0]![1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i]![0]) {
      const [x0, y0] = pts[i - 1]!;
      const [x1, y1] = pts[i]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1]![1];
}

/**
 * The household-finances factor is the dashboard's Health score scaled by this: a perfect dashboard score is not a perfect
 * borrower (the other 55% of the score is about credit behaviour the dashboard cannot see). Tuned, see spacetime/README.md.
 */
export const HEALTH_CREDIT_SCALE = 0.8;

/*
 * CURVES: how a raw profile number becomes a 0..1 factor. These, with HEALTH_CREDIT_SCALE, are the tuning knobs.
 * A 1.0 means top-tier behaviour in that category, not merely "no problem": under 5% utilization, 40 years of history,
 * no hard inquiries, four kinds of debt. With them the seeded families land where docs/contracts.md section 9 says they
 * should (Riveras good, Okafors fair, Nguyens very good, Patels poor, Brooks good).
 */
export const CURVES = {
  /** late payments in the last 24 months -> payment history. */
  payment: [[0, 1], [1, 0.7], [2, 0.45], [3, 0.3], [4, 0.12], [6, 0]] as Curve,
  /**
   * card utilization % -> utilization factor. Under ~5% is ideal and under 30% is the usual advice. A card nobody uses
   * (0%) scores a little lower than one used lightly, as real scoring models do.
   */
  utilization: [[0, 0.85], [3, 1], [5, 1], [10, 0.7], [20, 0.46], [30, 0.32], [50, 0.17], [75, 0.06], [100, 0]] as Curve,
  /** age of the oldest account, years -> history length. */
  history: [[0, 0.05], [2, 0.25], [5, 0.45], [10, 0.62], [20, 0.8], [30, 0.95], [40, 1]] as Curve,
  /** hard inquiries in the last 12 months -> new credit. */
  inquiries: [[0, 1], [1, 0.72], [2, 0.5], [3, 0.35], [4, 0.2], [6, 0.08], [8, 0]] as Curve,
  /** distinct kinds of debt in the household (card, auto, personal/student, mortgage) -> credit mix. */
  mix: [[0, 0.2], [1, 0.4], [2, 0.55], [3, 0.7], [4, 1]] as Curve,
};

export function bandOf(score: number): CreditBand {
  if (score >= 800) return 'exceptional';
  if (score >= 740) return 'very good';
  if (score >= 670) return 'good';
  if (score >= 580) return 'fair';
  return 'poor';
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const round3 = (x: number): number => Math.round((x + Number.EPSILON) * 1000) / 1000;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------------
// Household health (the dashboard's blend of the health indicators)
// ---------------------------------------------------------------------------------------------------------------

const lower = (s: string): string => s.toLowerCase();

/** 0..100 for one indicator. Mirrors `indicatorScore` in apps/web/lib/finance.ts (the dashboard's Health tile). */
function indicatorRaw(i: Indicator): number {
  const unit = lower(i.unit);
  switch (i.key) {
    case 'liquidity_runway':
      return interp(i.value, [[0, 0], [1, 25], [3, 60], [6, 88], [9, 100]]);
    case 'emergency_fund': {
      const pct = unit === 'months' ? (i.value / 3) * 100 : i.value;
      return interp(pct, [[0, 0], [50, 45], [100, 85], [150, 100]]);
    }
    case 'debt_to_income':
      return interp(i.value, [[0, 100], [15, 96], [28, 82], [36, 70], [43, 50], [60, 15], [100, 0]]);
    case 'credit_utilization':
      return interp(i.value, [[0, 100], [10, 95], [30, 78], [50, 45], [75, 15], [100, 0]]);
    case 'savings_rate':
      return interp(i.value, [[-10, 0], [0, 30], [5, 52], [15, 80], [25, 100]]);
    case 'net_worth_trend':
      if (unit === 'usd') return i.status === 'good' ? 84 : i.status === 'watch' ? 55 : 28;
      return interp(i.value, [[-10, 10], [-2, 45], [0, 65], [5, 82], [12, 100]]);
    case 'forecast_low_point':
      return interp(i.value, [[-2000, 0], [0, 30], [1000, 60], [3000, 85], [8000, 100]]);
    case 'credit_score':
      return interp(i.value, [[500, 0], [580, 25], [650, 50], [700, 70], [740, 88], [800, 100]]);
    default:
      return i.status === 'good' ? 85 : i.status === 'watch' ? 58 : 30;
  }
}

export function indicatorScore(i: Indicator): number {
  const s = indicatorRaw(i);
  const v = i.status === 'good' ? Math.max(s, 72) : i.status === 'watch' ? Math.min(71, Math.max(45, s)) : Math.min(44, s);
  return Math.round(v);
}

export function healthLabel(score: number): string {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 55) return 'fair';
  if (score >= 40) return 'needs attention';
  return 'at risk';
}

function phraseFor(i: Indicator): string {
  const n = (x: number): string => String(round1(x));
  switch (i.key) {
    case 'liquidity_runway':
      return `cash on hand covers ${n(i.value)} months of spending`;
    case 'debt_to_income':
      return `debt payments take ${n(i.value)}% of income`;
    case 'credit_utilization':
      return `cards are at ${n(i.value)}% of their limits`;
    case 'savings_rate':
      return i.value < 0 ? `spending runs ${n(-i.value)}% over income` : `saving ${n(i.value)}% of income`;
    case 'net_worth_trend':
      return `net worth ${i.value >= 0 ? 'rose' : 'fell'} ${usd(Math.abs(i.value))} over 90 days`;
    case 'emergency_fund':
      return `the emergency fund is ${Math.round(i.value)}% of a 3-month cushion`;
    case 'forecast_low_point':
      return i.value < 0 ? `cash is projected to run out (low of ${usd(i.value)})` : `cash is projected to dip to ${usd(i.value)}`;
    case 'credit_score':
      return `reported credit scores average ${Math.round(i.value)}`;
    default:
      return lower(i.label);
  }
}

/** The Household Health score (0..100) from a household's indicators, plus each indicator's share of it. */
export function householdHealth(indicators: readonly Indicator[]): HealthBlend {
  const rows: HealthRow[] = indicators.map((i) => ({ key: i.key, label: i.label, score: indicatorScore(i), status: i.status, phrase: phraseFor(i) }));
  if (!rows.length) return { score: 50, label: healthLabel(50), rows };
  const score = Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length);
  return { score, label: healthLabel(score), rows };
}

// ---------------------------------------------------------------------------------------------------------------
// The formula
// ---------------------------------------------------------------------------------------------------------------

export interface ScoreArgs {
  /** 0..100: the dashboard's Household Health score. */
  household_health: number;
  profile: MemberCreditProfile;
  /** Distinct debt account types in the household (card, auto loan, personal/student loan, mortgage). */
  debt_types: number;
  /** Optional context for the plain-English lines. */
  health?: HealthBlend;
  debt_type_names?: string[];
  /** True when the profile was derived from accounts rather than read from `credit_profile`. */
  derived?: boolean;
}

function factor(key: FactorKey, label: string, value: number, explanation: string): CreditFactor {
  const weight = WEIGHTS[key];
  const v = clamp01(value);
  return { key, label, value: round3(v), weight, points: round1(SCORE_SPAN * weight * v), max_points: round1(SCORE_SPAN * weight), explanation };
}

/** The contract formula. `raw = sum(weight * factor value)`, `score = round(300 + 550*raw)` clamped to 300..850. */
export function scoreCredit(a: ScoreArgs): CreditScoreResult {
  const h = Math.max(0, Math.min(100, a.household_health));
  const p = a.profile;
  const late = Math.max(0, Math.round(p.late_payments_24m));
  const util = Math.max(0, p.utilization_pct);
  const inq = Math.max(0, Math.round(p.hard_inquiries_12m));
  const years = Math.max(0, p.oldest_account_years);
  const types = Math.max(0, Math.round(a.debt_types));

  const weakest = a.health ? [...a.health.rows].sort((x, y) => x.score - y.score)[0] : undefined;
  const healthWords =
    `Household finances score ${Math.round(h)} out of 100 (${healthLabel(h)})` +
    (weakest && weakest.score < 80 ? `; the weakest spot is that ${weakest.phrase}.` : '.');
  const utilWords =
    util <= 0.05 && a.derived
      ? 'No card balances are reporting, so there is no utilization to count against you.'
      : util <= 30
        ? `Cards are at ${Math.round(util)}% of their limits${util <= 10 ? '; under 10% is ideal.' : '; under 30% helps, under 10% helps more.'}`
        : `Cards are at ${Math.round(util)}% of their limits; under 30% helps.`;
  const kinds = a.debt_type_names && a.debt_type_names.length ? ` (${a.debt_type_names.join(', ')})` : '';

  const factors: CreditFactor[] = [
    factor('household_health', 'Household finances', (h / 100) * HEALTH_CREDIT_SCALE, healthWords),
    factor(
      'payment_history',
      'Payment history',
      interp(late, CURVES.payment),
      late === 0 ? 'No late payments in the last 2 years, the biggest single plus.' : `${plural(late, 'late payment')} in the last 2 years; on-time payments rebuild this.`,
    ),
    factor('utilization', 'Card utilization', interp(util, CURVES.utilization), utilWords),
    factor(
      'history_length',
      'Credit history length',
      interp(years, CURVES.history),
      years >= 20
        ? `The oldest account is ${Math.round(years)} years old; a long history is a strong plus.`
        : `The oldest account is ${years < 10 ? round1(years) : Math.round(years)} years old; a longer history scores higher.`,
    ),
    factor(
      'new_credit',
      'New credit',
      interp(inq, CURVES.inquiries),
      inq === 0 ? 'No new credit applications in the last year.' : `${plural(inq, 'hard credit check')} in the last year; each one dips the score for a while.`,
    ),
    factor(
      'credit_mix',
      'Credit mix',
      interp(types, CURVES.mix),
      types === 0 ? 'No loans or cards on record; a mix of card and installment loans helps.' : `${plural(types, 'kind')} of debt${kinds}; a mix of cards and installment loans helps.`,
    ),
  ];
  let raw = 0;
  for (const f of factors) raw += f.weight * f.value;
  raw = clamp01(raw);
  const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(SCORE_MIN + SCORE_SPAN * raw)));
  return { score, band: bandOf(score), raw: round3(raw), factors };
}

// ---------------------------------------------------------------------------------------------------------------
// Member profiles: from `credit_profile`, or derived from the household's own accounts and transactions
// ---------------------------------------------------------------------------------------------------------------

const DEBT_TYPES = new Set(['auto_loan', 'personal_loan', 'credit_card', 'mortgage']);
const DEBT_NAME: Record<string, string> = { credit_card: 'cards', auto_loan: 'auto loan', personal_loan: 'personal or student loan', mortgage: 'mortgage' };
const DEBT_ORDER = ['credit_card', 'auto_loan', 'personal_loan', 'mortgage'];
const ASSET_TYPES = new Set(['checking', 'savings', 'cd', 'ira']);
const MS_DAY = 86_400_000;
const LATE_RE = /late\s*(fee|charge|payment|pmt)|past\s*due|overdue/i;
/** Plaid accounts often have no opened date; with nothing to go on a member is assumed to have this many years of history. */
export const DEFAULT_HISTORY_YEARS = 5;

export interface DebtTypes {
  count: number;
  names: string[];
}
export function debtTypes(accounts: readonly FinAccount[]): DebtTypes {
  const seen = new Set(accounts.filter((a) => DEBT_TYPES.has(a.type)).map((a) => a.type));
  const names = DEBT_ORDER.filter((t) => seen.has(t)).map((t) => DEBT_NAME[t]!);
  return { count: seen.size, names };
}

function cardUtilizationPct(accounts: readonly FinAccount[]): number {
  const cards = accounts.filter((a) => a.type === 'credit_card' && (a.credit_limit ?? 0) > 0);
  const limit = cards.reduce((s, a) => s + (a.credit_limit ?? 0), 0);
  if (limit <= 0) return 0;
  return (cards.reduce((s, a) => s + Math.abs(a.balance), 0) / limit) * 100;
}

/**
 * A profile for a member with no `credit_profile` row (a Plaid or PNC household): utilization from the household's cards, late
 * payments from late-fee style transactions, hard inquiries from credit accounts opened in the last year, history length from the
 * oldest account. All of it only reads columns the household already has.
 */
export function deriveProfile(input: HouseholdInput, today: string): MemberCreditProfile {
  const todayDay = parseDay(today) ?? 0;
  const lateMonths = new Set<string>();
  for (const t of input.txns) {
    const d = parseDay(t.date);
    if (d === null || d > todayDay || todayDay - d > 730) continue;
    if (LATE_RE.test(`${t.merchant} ${t.description} ${t.category}`.replace(/[_-]+/g, ' ')) && t.amount <= 0) lateMonths.add(t.date.slice(0, 7));
  }
  const opened = (a: FinAccount): number | null => (a.opened_date ? parseDay(a.opened_date) : null);
  const debt = input.accounts.filter((a) => DEBT_TYPES.has(a.type));
  const recent = debt.filter((a) => {
    const d = opened(a);
    return d !== null && d <= todayDay && todayDay - d <= 365;
  }).length;
  const ages = (debt.length ? debt : input.accounts).map(opened).filter((d): d is number => d !== null && d <= todayDay);
  const years = ages.length ? (todayDay - Math.min(...ages)) / 365.25 : DEFAULT_HISTORY_YEARS;
  return {
    late_payments_24m: Math.min(6, lateMonths.size),
    utilization_pct: round1(cardUtilizationPct(input.accounts)),
    hard_inquiries_12m: Math.min(8, recent),
    oldest_account_years: round1(years),
  };
}

export interface ScoredMember {
  member_id: string;
  derived: boolean;
  profile: MemberCreditProfile;
}

/**
 * Who gets a score. Members with a `credit_profile` row, always. A household with no profile rows at all (an onboarded bank
 * household) scores every member who is not a child, using a profile derived from the household's accounts. A seeded household
 * whose children have no profile does not score them.
 */
export function scoredMembers(input: HouseholdInput, today: string): ScoredMember[] {
  if (input.credit.length) {
    return [...input.credit]
      .sort((a, b) => (a.member_id < b.member_id ? -1 : 1))
      .map((c) => ({
        member_id: c.member_id,
        derived: false,
        profile: { late_payments_24m: c.late_payments_24m, utilization_pct: c.utilization_pct, hard_inquiries_12m: c.hard_inquiries_12m, oldest_account_years: c.oldest_account_years },
      }));
  }
  if (!input.accounts.length) return []; // nothing to derive a profile from yet (an onboarding household before its bank is linked)
  const adults = input.members.filter((m) => (m.role ?? '') !== 'child').sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!adults.length) return [];
  const profile = deriveProfile(input, today);
  return adults.map((m) => ({ member_id: m.id, derived: true, profile }));
}

export interface MemberScore extends CreditScoreResult {
  member_id: string;
  derived: boolean;
}

/** Score every scoreable member of a household from its indicators (already computed by analyzeHousehold). */
export function scoreHousehold(input: HouseholdInput, indicators: readonly Indicator[], today: string, yearsBack = 0): MemberScore[] {
  const health = householdHealth(indicators);
  const types = debtTypes(input.accounts);
  return scoredMembers(input, today).map((m) => {
    const profile = m.derived ? m.profile : { ...m.profile, oldest_account_years: Math.max(0, m.profile.oldest_account_years - yearsBack) };
    const r = scoreCredit({ household_health: health.score, profile, debt_types: types.count, debt_type_names: types.names, health, derived: m.derived });
    return { ...r, member_id: m.member_id, derived: m.derived };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// History: recompute household health from each past month's transactions
// ---------------------------------------------------------------------------------------------------------------

/** `day` (YYYY-MM-DD) shifted back by `k` calendar months, the day of month clamped to the month length. */
export function monthsBack(day: string, k: number): string {
  const d = parseDay(day);
  if (d === null) return day;
  const dt = new Date(d * MS_DAY);
  const idx = dt.getUTCFullYear() * 12 + dt.getUTCMonth() - k;
  const y = Math.floor(idx / 12);
  const m = idx % 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return formatDay(Math.floor(Date.UTC(y, m, Math.min(dt.getUTCDate(), dim)) / MS_DAY));
}

/** The monthly dates the backfill writes, oldest first: today minus `months` ... today minus 1 month (today itself is the live point). */
export function historyDates(today: string, months = HISTORY_MONTHS): string[] {
  const out: string[] = [];
  for (let k = months; k >= 1; k--) out.push(monthsBack(today, k));
  return out;
}

/**
 * The household as it stood on `day`: transactions up to that day, balances wound back by the transactions since (an asset
 * balance falls by what came in after `day`; a debt balance owed rises by it, a positive amount on a debt being a payment),
 * and accounts that did not exist yet left out. Rows the data-quality rules exclude (duplicates, impossible values) are not
 * used to wind balances back. Returns null when there is less than MIN_EVIDENCE_DAYS of usable transactions up to `day`.
 */
export function householdAsOf(input: HouseholdInput, day: string, today: string): HouseholdInput | null {
  const dayN = parseDay(day);
  const todayN = parseDay(today);
  if (dayN === null || todayN === null || dayN >= todayN) return null;
  const quality = detectDataQuality(input.household_id, input.txns, today);
  const usable: { t: FinTxn; d: number }[] = [];
  for (const t of input.txns) {
    if (quality.excludeIds.has(t.id)) continue;
    const d = parseDay(t.date);
    if (d === null || d > todayN) continue;
    usable.push({ t, d });
  }
  const earliest = usable.reduce((m, u) => (u.d < m ? u.d : m), Infinity);
  if (!(earliest <= dayN - (MIN_EVIDENCE_DAYS - 1))) return null;

  const delta = new Map<string, number>();
  for (const u of usable) if (u.d > dayN) delta.set(u.t.account_id, (delta.get(u.t.account_id) ?? 0) + u.t.amount);
  const accounts: FinAccount[] = [];
  const kept = new Set<string>();
  for (const a of input.accounts) {
    const opened = a.opened_date ? parseDay(a.opened_date) : null;
    if (opened !== null && opened > dayN) continue; // not open yet
    const moved = delta.get(a.id) ?? 0;
    let balance = a.balance;
    if (ASSET_TYPES.has(a.type)) balance = a.balance - moved;
    else if (DEBT_TYPES.has(a.type)) balance = Math.abs(a.balance) + moved;
    accounts.push({ ...a, balance });
    kept.add(a.id);
  }
  const txns = input.txns.filter((t) => {
    if (!kept.has(t.account_id)) return false;
    const d = parseDay(t.date);
    return d === null || d <= dayN; // unparseable dates stay so the rules keep flagging (and excluding) them
  });
  return { ...input, accounts, txns };
}

export interface HistoryPoint {
  date: string;
  members: { member_id: string; score: number; band: CreditBand }[];
  household_health: number;
}

/**
 * The monthly points for a household, oldest first, for the dates that have enough transactions behind them. Every date reruns
 * `analyzeHousehold` on the household as of that date (the same math that fills the dashboard), blends the indicators into the
 * Household Health score, and scores each member. Does not include today.
 */
export function backfillHistory(input: HouseholdInput, today: string, months = HISTORY_MONTHS): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  const todayN = parseDay(today) ?? 0;
  for (const date of historyDates(today, months)) {
    const past = householdAsOf(input, date, today);
    if (!past) continue;
    const analysis = analyzeHousehold(past, date);
    const years = ((todayN - (parseDay(date) ?? todayN)) / 365.25);
    const scores = scoreHousehold(past, analysis.indicators, date, years);
    out.push({
      date,
      household_health: householdHealth(analysis.indicators).score,
      members: scores.map((s) => ({ member_id: s.member_id, score: s.score, band: s.band })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Alerts: what moved
// ---------------------------------------------------------------------------------------------------------------

export interface FactorMove {
  key: FactorKey;
  label: string;
  /** Change in points on the 300..850 scale (positive = helped). */
  delta_points: number;
  explanation: string;
}

/** The factor that moved the score most between two looks (largest absolute change in points). */
export function biggestMove(prev: readonly CreditFactor[], next: readonly CreditFactor[]): FactorMove | null {
  const before = new Map(prev.map((f) => [f.key, f]));
  let best: FactorMove | null = null;
  for (const f of next) {
    const delta = round1(f.points - (before.get(f.key)?.points ?? 0));
    if (best === null || Math.abs(delta) > Math.abs(best.delta_points)) best = { key: f.key, label: f.label, delta_points: delta, explanation: f.explanation };
  }
  return best;
}

export interface CreditAlertDraft {
  id: string;
  severity: 'info' | 'warn';
  title: string;
  detail: string;
  related_ids: string[];
}

export interface ScoreChange {
  member_id: string;
  name: string;
  before: number;
  after: number;
  prev_factors: readonly CreditFactor[];
  factors: readonly CreditFactor[];
}

/**
 * One `credit` alert per household per day when any member's score moved by ALERT_DELTA or more between two looks. Warn when the
 * biggest mover dropped, info when it rose; the detail names the factor that moved the most for that member. Null when nothing
 * moved enough. The id is `credit:<household>:<yyyy-mm-dd>` so repeating a recompute the same day never adds a second alert.
 */
export function creditAlert(household_id: string, day: string, changes: readonly ScoreChange[]): CreditAlertDraft | null {
  const moved = changes.filter((c) => Math.abs(c.after - c.before) >= ALERT_DELTA);
  if (!moved.length) return null;
  const lead = [...moved].sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before) || (a.member_id < b.member_id ? -1 : 1))[0]!;
  const delta = lead.after - lead.before;
  const drop = delta < 0;
  const mv = biggestMove(lead.prev_factors, lead.factors);
  const first = (name: string): string => name.split(' ')[0] || name;
  const others = moved.length - 1;
  const title = drop
    ? `${first(lead.name)}'s credit score dropped ${-delta} points to ${lead.after}${others ? ` (and ${plural(others, 'other score')} fell too)` : ''}`
    : `${first(lead.name)}'s credit score rose ${delta} points to ${lead.after}${others ? ` (and ${plural(others, 'other score')} moved too)` : ''}`;
  const reason = mv
    ? `Biggest factor: ${mv.label.toLowerCase()} (${mv.delta_points >= 0 ? '+' : ''}${mv.delta_points} points). ${mv.explanation}`
    : '';
  const detail = `${first(lead.name)}'s simulated score went from ${lead.before} to ${lead.after}. ${reason} Simulated score for this demo.`.replace(/\s+/g, ' ').trim();
  return { id: `credit:${household_id}:${day}`, severity: drop ? 'warn' : 'info', title, detail, related_ids: moved.map((m) => m.member_id) };
}
