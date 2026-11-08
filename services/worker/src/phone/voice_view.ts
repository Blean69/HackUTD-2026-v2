// What a voice model needs from a tool result: a handful of rounded numbers and one-line explanations, not 4 KB of JSON.
// The full result still goes into the trace (run.tool emits it); only the copy handed back to the voice model is trimmed.
import { fitJson, nextDueLabel, truncate } from '../util.js';

/** Tools the phone/voice agent may use (7 to 8 is plenty for a 3B-active model). Order = order in the model's tool list. */
export const PHONE_TOOLS = ['get_health_indicators', 'get_forecast', 'get_obligations', 'get_accounts', 'get_credit_score', 'simulate_scenario', 'goal_feasibility', 'detect_scam_signals', 'get_kids', 'add_kid_chore', 'add_to_kid_jar', 'find_savings'] as const;
export type PhoneTool = (typeof PHONE_TOOLS)[number];
export const isPhoneTool = (name: string): name is PhoneTool => (PHONE_TOOLS as readonly string[]).includes(name);

/** Voice replies stay small: the model gets at most this many characters of JSON per tool call. */
export const VOICE_VIEW_MAX_CHARS = 1100;

/**
 * Numbers the way a person says them, because the voice model copies what it reads: 39,655 is spoken "about forty thousand", not "thirty-nine
 * thousand six hundred fifty-five". Dollars: nearest $1,000 from $10,000 up; nearest $100 from $1,000 unless the amount is already a
 * round $50 (rent of $1,850 stays); exact below $1,000. Percentages: whole numbers from 10 up, halves below. The full-precision result
 * still goes to the trace; only this copy for the voice model is rounded.
 */
export function humanMoney(x: unknown): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0;
  const a = Math.abs(x);
  const step = a >= 10_000 ? 1000 : a >= 1000 ? (Number.isInteger(a) && a % 50 === 0 ? 1 : 100) : 1;
  return Math.sign(x) * Math.round(a / step) * step;
}
export function humanPercent(x: unknown): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0;
  return Math.abs(x) >= 10 ? Math.round(x) : Math.round(x * 2) / 2;
}
/** Months of cover / months left: under a month in halves ("about half a month", not "zero point four"), up to ten months one decimal, then whole. */
export function humanMonths(x: unknown): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0;
  const a = Math.abs(x);
  const r = a < 1 ? Math.round(a * 2) / 2 : a < 10 ? Math.round(a * 10) / 10 : Math.round(a);
  return Math.sign(x) * r;
}
const whole = (x: unknown): number => humanMoney(x);
const one = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10) / 10 : 0);
const rec = (x: unknown): Record<string, any> => (x && typeof x === 'object' ? (x as Record<string, any>) : {});
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);

function indicatorValue(i: Record<string, any>): number {
  // money-like indicators are dollars (human-rounded), percentages are whole numbers, the rest keep one decimal (months, score)
  if (String(i.unit).toLowerCase() === 'usd') return whole(i.value);
  if (['%', 'percent', 'pct'].includes(String(i.unit).toLowerCase())) return humanPercent(i.value);
  return one(i.value);
}

export function voiceView(tool: string, result: unknown, asOf = ''): unknown {
  const r = rec(result);
  let view: unknown;
  switch (tool) {
    case 'get_health_indicators':
      view = {
        indicators: arr(r.indicators)
          .slice(0, 8)
          .map((i) => ({ label: i.label, value: indicatorValue(i), unit: i.unit, status: i.status, note: truncate(String(i.explanation ?? ''), 120) })),
      };
      break;
    case 'get_forecast':
      view = r.available
        ? {
            as_of: r.start?.date,
            starting_balance: whole(r.start?.balance),
            ending_balance: whole(r.end?.balance),
            end_date: r.end?.date,
            lowest: { date: r.lowest?.date, balance: whole(r.lowest?.balance) },
            days_below_zero: r.days_below_zero ?? 0,
            bills_due_total: whole(r.obligations_due_total),
            net_change_per_month: whole(r.net_change_per_month),
          }
        : { available: false, note: r.note ?? 'No forecast yet.' };
      break;
    case 'get_obligations':
      view = {
        count: r.count ?? 0,
        monthly_total: whole(r.monthly_total),
        biggest: arr(r.obligations)
          .slice()
          .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
          .slice(0, 6)
          .map((o) => (asOf ? { name: o.name, amount: whole(o.amount), due: nextDueLabel(Number(o.due_day), asOf), kind: o.kind } : { name: o.name, amount: whole(o.amount), due_day: o.due_day, kind: o.kind })),
      };
      break;
    case 'get_accounts':
      view = {
        accounts: arr(r.accounts)
          .slice()
          .sort((a, b) => Math.abs(b.balance ?? 0) - Math.abs(a.balance ?? 0))
          .slice(0, 8)
          .map((a) => ({ name: a.nickname || a.type, type: a.type, balance: whole(a.balance), ...(a.rate_pct !== undefined ? { rate_pct: humanPercent(a.rate_pct) } : {}), ...(a.monthly_payment !== undefined ? { monthly_payment: whole(a.monthly_payment) } : {}) })),
        totals: { liquid_cash: whole(r.totals?.liquid_cash), debt: whole(r.totals?.debt), net_worth: whole(r.totals?.net_worth) },
      };
      break;
    case 'get_credit_score':
      view = r.available
        ? {
            note: 'Simulated demo score, not a real credit report. Say "simulated".',
            scores: arr(r.members)
              .slice(0, 4)
              .map((m) => ({
                name: m.member,
                score: m.score,
                band: m.band,
                change: m.change_6m ? { points: m.change_6m.points, months: m.change_6m.months } : null,
                top_factors: arr(m.top_factors)
                  .slice(0, 2)
                  .map((f) => ({ factor: f.factor, effect: f.effect, note: truncate(String(f.detail ?? ''), 90) })),
              })),
          }
        : { available: false, note: r.note ?? 'No simulated credit score yet.' };
      break;
    case 'simulate_scenario': {
      const e = rec(r.effect);
      view = {
        headline: r.headline,
        verdict: r.verdict,
        lowest: { month: r.lowest?.month, balance: whole(r.lowest?.balance) },
        ending: { baseline: whole(r.ending?.baseline), scenario: whole(r.ending?.scenario), difference: whole(r.ending?.difference) },
        effect: {
          upfront_cash: whole(e.upfront_cash),
          monthly_change: whole(e.monthly_change),
          ...(e.monthly_payment !== undefined ? { monthly_payment: whole(e.monthly_payment) } : {}),
          ...(e.total_interest !== undefined ? { total_interest: whole(e.total_interest) } : {}),
          ...(e.interest_saved !== undefined ? { interest_saved: whole(e.interest_saved) } : {}),
        },
        months_of_spending_covered_at_low: humanMonths(r.months_of_spending_covered_at_low),
        assumptions: arr(r.assumptions).slice(0, 2).map((a) => truncate(String(a), 200)),
      };
      break;
    }
    case 'goal_feasibility':
      view = {
        feasibility: r.feasibility,
        target_amount: whole(r.target_amount),
        target_date: r.target_date,
        months_left: humanMonths(r.months_left),
        still_needed: whole(r.still_needed),
        required_monthly: whole(r.required_monthly),
        available_monthly: whole(r.available_monthly),
        explanation: truncate(String(r.explanation ?? ''), 220),
      };
      break;
    case 'detect_scam_signals':
      view = {
        risk: r.risk,
        summary: truncate(String(r.summary ?? ''), 240),
        signals: arr(r.signals).slice(0, 3).map((s) => ({ label: s.label, quote: truncate(String(s.quote ?? ''), 100) })),
        linked_total: whole(r.linked_total),
      };
      break;
    default:
      view = result;
  }
  // belt and braces: whatever a tool returns, the voice model never sees more than VOICE_VIEW_MAX_CHARS of JSON
  const s = fitJson(view, VOICE_VIEW_MAX_CHARS);
  return JSON.parse(s);
}
