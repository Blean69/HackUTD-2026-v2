// What a voice model needs from a tool result: a handful of rounded numbers and one-line explanations, not 4 KB of JSON.
// The full result still goes into the trace (run.tool emits it); only the copy handed back to the voice model is trimmed.
import { fitJson, nextDueLabel, truncate } from '../util.js';

/** Tools the phone/voice agent may use (7 to 8 is plenty for a 3B-active model). Order = order in the model's tool list. */
export const PHONE_TOOLS = ['get_health_indicators', 'get_forecast', 'get_obligations', 'get_accounts', 'get_credit_score', 'simulate_scenario', 'goal_feasibility', 'detect_scam_signals', 'get_kids', 'add_kid_chore', 'add_to_kid_jar', 'find_savings', 'approve_kid_chore', 'set_kid_goal', 'get_goals', 'change_goal', 'save_what_if', 'get_alerts', 'mark_alert_handled', 'get_proposals', 'create_proposal'] as const;
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

/**
 * Free text in a tool result (account nicknames, bill and merchant names, goal titles, a caller's own words echoed by the scam check) can
 * come from outside the house: a bank feed, an import, a prank. Before the voice model reads it, control characters and links are removed
 * and anything that reads like an instruction to the model is replaced, so data cannot give orders. The full result still goes to the trace.
 */
const INJECTION = /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules?|above|previous|earlier|guidelines?)\b|\b(?:system|developer) (?:prompt|message|override|mode)\b|\byou are now\b|\b(?:reveal|print|repeat|recite|read out|say)\b[^.\n]{0,30}\b(?:prompt|instructions|secret|password|pin|api key)\b|<\/?(?:system|assistant|tool|data|instructions?)\b|```|\bnew instructions?\b/i;
export function scrubText(s: string): string {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.]+/gi, '').replace(/\s+/g, ' ').trim();
  return INJECTION.test(t) ? '[removed]' : t.slice(0, 240);
}
function scrub(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return scrubText(v);
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x, depth + 1)]));
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
        // cash that runs out / keeps falling is said as such, never as a "low point" at the last month; a gambling plan says why not
        ...(r.runs_out ? { runs_out_month: r.runs_out.month } : {}),
        ...(r.keeps_falling && r.verdict !== 'comfortable' ? { keeps_falling: true } : {}),
        ...(r.caution ? { caution: truncate(String(r.caution), 160) } : {}),
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
  const s = fitJson(scrub(view), VOICE_VIEW_MAX_CHARS);
  return JSON.parse(s);
}
