// What a voice model needs from a tool result: a handful of rounded numbers and one-line explanations, not 4 KB of JSON.
// The full result still goes into the trace (run.tool emits it); only the copy handed back to the voice model is trimmed.
import { fitJson, truncate } from '../util.js';

/** Tools the phone/voice agent may use (7 is plenty for a 3B-active model). Order = order in the model's tool list. */
export const PHONE_TOOLS = ['get_health_indicators', 'get_forecast', 'get_obligations', 'get_accounts', 'simulate_scenario', 'goal_feasibility', 'detect_scam_signals'] as const;
export type PhoneTool = (typeof PHONE_TOOLS)[number];
export const isPhoneTool = (name: string): name is PhoneTool => (PHONE_TOOLS as readonly string[]).includes(name);

/** Voice replies stay small: the model gets at most this many characters of JSON per tool call. */
export const VOICE_VIEW_MAX_CHARS = 1100;

const whole = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : 0);
const one = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10) / 10 : 0);
const rec = (x: unknown): Record<string, any> => (x && typeof x === 'object' ? (x as Record<string, any>) : {});
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);

function indicatorValue(i: Record<string, any>): number {
  // money-like indicators are dollars, the rest keep one decimal (months, percent, score)
  return i.unit === 'USD' ? whole(i.value) : one(i.value);
}

export function voiceView(tool: string, result: unknown): unknown {
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
          .map((o) => ({ name: o.name, amount: whole(o.amount), due_day: o.due_day, kind: o.kind })),
      };
      break;
    case 'get_accounts':
      view = {
        accounts: arr(r.accounts)
          .slice()
          .sort((a, b) => Math.abs(b.balance ?? 0) - Math.abs(a.balance ?? 0))
          .slice(0, 8)
          .map((a) => ({ name: a.nickname || a.type, type: a.type, balance: whole(a.balance), ...(a.rate_pct !== undefined ? { rate_pct: one(a.rate_pct) } : {}), ...(a.monthly_payment !== undefined ? { monthly_payment: whole(a.monthly_payment) } : {}) })),
        totals: { liquid_cash: whole(r.totals?.liquid_cash), debt: whole(r.totals?.debt), net_worth: whole(r.totals?.net_worth) },
      };
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
        months_of_spending_covered_at_low: one(r.months_of_spending_covered_at_low),
        assumptions: arr(r.assumptions).slice(0, 2).map((a) => truncate(String(a), 200)),
      };
      break;
    }
    case 'goal_feasibility':
      view = {
        feasibility: r.feasibility,
        target_amount: whole(r.target_amount),
        target_date: r.target_date,
        months_left: one(r.months_left),
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
