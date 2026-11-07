// The keyless `local` provider: deterministic, rule-based "model" that still drives the real tools, so the whole app
// runs (and the demo survives) without any API key. Every trace event it produces says provider=local.
// Workflows hand it structured facts through `req.local`; it never sees secrets or the network.
import type { Scenario } from '../tools/simulate.js';
import { findDate, findMoney, extractFromLines, parseScenarioPrompt, type Line } from './rules.js';
import type { ChatMessage, ChatRequest, ChatResult, LLMProvider, ToolCall } from './types.js';
import { usd } from '../util.js';

export const LOCAL_MODEL = 'keystone-rules-v1';

export interface CoachLocal {
  question: string;
  asOf: string;
}

type Partial_ = Pick<ChatResult, 'content' | 'toolCalls'> & { reasoning?: string };

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

export interface RoutedCall {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

/** Decide which tools a family question needs. Deterministic keyword routing. */
export function routeCoach(question: string, asOf: string): RoutedCall[] {
  const q = question.toLowerCase();
  const money = findMoney(question);
  const ninetyAgo = (() => {
    const d = new Date(`${asOf}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 90);
    return d.toISOString().slice(0, 10);
  })();
  const calls: RoutedCall[] = [];
  if (/scam|fraud|suspicious|phish|gift card|wire|irs|grand(?:son|daughter)|bail|someone called|text said|email said/.test(q)) {
    calls.push({ tool: 'detect_scam_signals', args: { text: question }, why: 'The question mentions possible fraud, so I check the wording for known scam patterns.' });
    calls.push({ tool: 'detect_transaction_anomalies', args: { limit: 8 }, why: 'Then I look for payments that match those patterns in the ledger.' });
    return calls;
  }
  if (/mortgage rate|interest rate|refinanc|prime rate|rates? (?:are|going)/.test(q)) {
    calls.push({ tool: 'fred_series', args: { series_id: /prime|card|credit/.test(q) ? 'DPRIME' : 'MORTGAGE30US' }, why: 'Rates are an outside number, so I fetch the latest value from FRED.' });
    calls.push({ tool: 'get_accounts', args: { type: 'mortgage' }, why: 'Then I compare it with what the family pays today.' });
    return calls;
  }
  if (/college|tuition|university|ut dallas|utd|ut austin|school/.test(q)) {
    const school = /ut austin/.test(q) ? 'UT Austin' : /ut dallas|utd/.test(q) ? 'UT Dallas' : 'UT Dallas';
    calls.push({ tool: 'college_scorecard', args: { school_name: school }, why: 'College costs come from the U.S. College Scorecard.' });
    calls.push({ tool: 'get_accounts', args: { type: 'savings' }, why: 'Then I check what is already saved.' });
    return calls;
  }
  if (/afford|buy|purchase|new car|house|can we|should we|take out|loan|raise|lose|laid off|pay off/.test(q) && (money.length || /lose|laid off|raise|pay off/.test(q))) {
    const scn = parseScenarioPrompt(question);
    calls.push({ tool: 'get_health_indicators', args: {}, why: 'First I look at the household\'s health indicators to see how much room there is.' });
    calls.push({ tool: 'simulate_scenario', args: scn, why: 'Then I run the numbers for this scenario against the real cash flow.' });
    return calls;
  }
  if (/save|saving|goal|by (?:next|20\d\d|january|february|march|april|may|june|july|august|september|october|november|december)|target/.test(q) && money.length) {
    const date = findDate(question, asOf) || `${asOf.slice(0, 4)}-12-31`;
    calls.push({ tool: 'get_accounts', args: { type: 'savings' }, why: 'I start from what is already saved.' });
    calls.push({ tool: 'goal_feasibility', args: { target_amount: money[0]!.value, target_date: date }, why: 'Then I test the target against the monthly surplus.' });
    return calls;
  }
  if (/spend|spent|spending|grocer|dining|restaurant|subscription|where does|budget|cut back/.test(q)) {
    calls.push({ tool: 'get_transactions', args: { group_by: 'category', direction: 'out', since: ninetyAgo }, why: 'I group the last 90 days of spending by category.' });
    calls.push({ tool: 'get_obligations', args: {}, why: 'Then I add the fixed monthly obligations.' });
    return calls;
  }
  if (/debt|credit|score|utiliz|card balance/.test(q)) {
    calls.push({ tool: 'get_credit_profiles', args: {}, why: 'I read the credit profiles first.' });
    calls.push({ tool: 'get_accounts', args: {}, why: 'Then I check the balances and rates behind them.' });
    return calls;
  }
  calls.push({ tool: 'get_health_indicators', args: {}, why: 'For a general question I start with the household health indicators.' });
  calls.push({ tool: 'get_forecast', args: {}, why: 'Then I look at the 90-day cash forecast.' });
  calls.push({ tool: 'get_accounts', args: {}, why: 'Finally I check the balances.' });
  return calls;
}

type Msg = ChatMessage;
function toolResults(messages: Msg[]): { name: string; result: any }[] {
  return messages
    .filter((m): m is Extract<Msg, { role: 'tool' }> => m.role === 'tool')
    .map((m) => {
      let result: unknown = {};
      try {
        result = JSON.parse(m.content);
      } catch {
        result = { raw: m.content };
      }
      return { name: m.name, result };
    });
}

/** Compose a plain-English answer from tool results. */
export function composeCoachAnswer(question: string, results: { name: string; result: any }[]): string {
  const parts: string[] = [];
  for (const { name, result: r } of results) {
    if (r?.error) {
      parts.push(`I could not run ${name}: ${r.error}.`);
      continue;
    }
    switch (name) {
      case 'simulate_scenario':
        parts.push(`${r.headline} Over ${r.months} months your monthly cash flow is about ${usd(r.baseline.monthly_net)} before this change${r.effect.monthly_payment ? `, and the new payment would be ${usd(r.effect.monthly_payment)} per month` : ''}.`);
        break;
      case 'get_health_indicators': {
        const risky = (r.indicators ?? []).filter((i: { status: string }) => i.status !== 'good').slice(0, 3);
        parts.push(risky.length ? `Watch items: ${risky.map((i: { label: string; explanation: string }) => `${i.label} (${i.explanation})`).join('; ')}.` : 'All health indicators look good.');
        break;
      }
      case 'get_forecast':
        if (r.available) parts.push(`The 90-day forecast bottoms out at ${usd(r.lowest.balance)} on ${r.lowest.date} and ends at ${usd(r.end.balance)}.`);
        break;
      case 'get_accounts':
        parts.push(`Liquid cash is ${usd(r.totals.liquid_cash)} against ${usd(r.totals.debt)} of debt (net worth ${usd(r.totals.net_worth)}).`);
        break;
      case 'goal_feasibility':
        parts.push(`That goal is ${String(r.feasibility).replace('_', ' ')}: ${r.explanation}`);
        break;
      case 'college_scorecard':
        parts.push(`${r.name} costs about ${r.cost_of_attendance ? usd(r.cost_of_attendance) : 'n/a'} a year to attend (average net price ${r.avg_net_price ? usd(r.avg_net_price) : 'n/a'}).`);
        break;
      case 'fred_series':
        parts.push(`${r.title}: ${r.latest.value}% as of ${r.latest.date}${r.source === 'fixed_table' ? ' (reference value, not live)' : ''}.`);
        break;
      case 'detect_scam_signals':
        parts.push(r.risk === 'none' ? 'I did not find typical scam wording.' : `Scam risk is ${r.risk}: ${r.summary} Do not send gift cards, wires or codes, hang up, and call the person back on a number you already know.`);
        break;
      case 'detect_transaction_anomalies': {
        const n = Object.values(r.counts ?? {}).reduce((s: number, x) => s + Number(x), 0);
        parts.push(n ? `I also found ${n} suspicious transaction(s), for example ${(r.findings ?? []).slice(0, 2).map((f: { merchant: string; amount: number }) => `${f.merchant} ${usd(f.amount)}`).join(' and ')}.` : 'No suspicious transactions turned up.');
        break;
      }
      case 'get_transactions':
        if (r.groups) parts.push(`Top spending in the last 90 days: ${r.groups.slice(0, 4).map((g: { key: string; out: number }) => `${g.key} ${usd(g.out)}`).join(', ')}.`);
        else parts.push(`${r.matched} matching transactions totalling ${usd(r.total_out)} out.`);
        break;
      case 'get_obligations':
        parts.push(`Fixed monthly obligations total ${usd(r.monthly_total)} across ${r.count} items.`);
        break;
      case 'get_credit_profiles':
        parts.push(`Credit scores: ${(r.profiles ?? []).map((p: { member: string; score: number; utilization_pct: number }) => `${p.member} ${p.score} (${p.utilization_pct}% utilization)`).join(', ')}.`);
        break;
    }
  }
  if (!parts.length) return `I looked at the household data but did not find anything specific for: "${question}".`;
  return `${parts.join(' ')}\n\n(This is a rule-based answer from the offline fallback; add an NVIDIA_API_KEY for Nemotron's full reasoning.)`;
}

function textOf(m: Msg | undefined): string {
  return m && 'content' in m ? m.content : '';
}

function handle(req: ChatRequest): Partial_ {
  const task = req.task ?? '';
  const local = (req.local ?? {}) as Record<string, any>;

  if (task === 'huddle.extract') {
    const lines = (local.lines ?? []) as Line[];
    return { content: '', toolCalls: [call(req, extractFromLines(lines, String(local.asOf ?? new Date().toISOString().slice(0, 10))))] };
  }
  if (task === 'scenario.parse') {
    const scn: Scenario = parseScenarioPrompt(String(local.prompt ?? ''));
    return { content: '', toolCalls: [call(req, scn)] };
  }
  // a structured step whose offline answer the caller computed itself (onboarding insights, ...): hand it back as the tool call
  if (local.structured !== undefined) return { content: '', toolCalls: [call(req, local.structured)] };
  if (task.endsWith('.explain')) return { content: '', toolCalls: [call(req, { items: [] })] };
  if (task === 'narrative') {
    return { content: '', toolCalls: [call(req, { summary: String(local.summary ?? ''), suggestion: String(local.suggestion ?? '') })] };
  }
  if (task === 'coach.plan') {
    const route = routeCoach(String(local.question ?? ''), String(local.asOf ?? ''));
    return { content: route.map((r, i) => `${i + 1}. ${r.why} (${r.tool})`).join('\n'), toolCalls: [] };
  }
  if (task === 'coach.step') {
    const c = local as unknown as CoachLocal;
    const route = routeCoach(c.question, c.asOf);
    const done = toolResults(req.messages);
    if (done.length < route.length && req.tools?.length) {
      const next = route[done.length]!;
      return { content: '', reasoning: `Rule-based routing: ${next.why}`, toolCalls: [{ id: `call_local_${done.length}`, name: next.tool, arguments: JSON.stringify(next.args) }] };
    }
    return { content: composeCoachAnswer(c.question, done), toolCalls: [] };
  }
  if (task.endsWith('.plan') && Array.isArray(local.plan)) {
    return { content: (local.plan as string[]).map((s, i) => `${i + 1}. ${s}`).join('\n'), toolCalls: [] };
  }
  if (typeof local.text === 'string') return { content: local.text, toolCalls: [] };
  // generic fallback: echo the last user message so callers never get an empty answer
  return { content: textOf([...req.messages].reverse().find((m) => m.role === 'user')).slice(0, 400), toolCalls: [] };
}

/** A forced tool call (structured output) carrying `args` for whichever tool the request named. */
function call(req: ChatRequest, args: unknown): ToolCall {
  const name = req.toolChoice && typeof req.toolChoice === 'object' ? req.toolChoice.name : (req.tools?.[0]?.name ?? 'result');
  return { id: 'call_local_0', name, arguments: JSON.stringify(args) };
}

export class LocalProvider implements LLMProvider {
  readonly id = 'local' as const;
  modelFor(): string {
    return LOCAL_MODEL;
  }
  async call(req: ChatRequest): Promise<ChatResult> {
    const t0 = Date.now();
    const out = handle(req);
    const inChars = req.messages.reduce((s, m) => s + textOf(m).length, 0);
    const outChars = out.content.length + out.toolCalls.reduce((s, t) => s + t.arguments.length, 0);
    return {
      content: out.content,
      ...(out.reasoning ? { reasoning: out.reasoning } : {}),
      toolCalls: out.toolCalls,
      provider: 'local',
      model: LOCAL_MODEL,
      latencyMs: Math.max(1, Date.now() - t0),
      tokensIn: approxTokens(' '.repeat(inChars)),
      tokensOut: approxTokens(' '.repeat(outChars)),
    };
  }
}
