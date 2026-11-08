// The briefing the voice agent gets before the first question: a few plain lines built from the same tools the caller can
// ask for (health indicators, forecast, obligations). Deterministic text, no LLM, so common questions need zero tool calls.
import type { HouseholdData } from '../types.js';
import { nextDueLabel, parseDay, truncate } from '../util.js';

const money = (x: number): string => `$${Math.round(Math.abs(x)).toLocaleString('en-US')}`;
const rec = (x: unknown): Record<string, any> => (x && typeof x === 'object' ? (x as Record<string, any>) : {});
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);

/** "Rivera Family" -> "Rivera family", "Okafor Household" -> "Okafor household". */
export function familyLabel(name: string): string {
  return name.replace(/\b(Family|Household)\b/i, (m) => m.toLowerCase()).trim() || 'the family';
}

export function buildBrief(data: HouseholdData, tools: { health?: unknown; forecast?: unknown; obligations?: unknown }): string[] {
  const lines: string[] = [`Household: ${familyLabel(data.household.name)}, ${data.household.city}, ${data.household.state}. Today is ${data.asOf}.`];
  const members = data.members.filter((m) => m.role === 'parent' || m.role === 'grandparent').map((m) => m.name.split(' ')[0]);
  if (members.length) lines.push(`Adults: ${members.join(', ')}.`);

  const health = arr(rec(tools.health).indicators);
  const by = (key: string) => health.find((h) => h.key === key);
  const runway = by('liquidity_runway');
  if (runway) lines.push(`Cushion: about ${Math.round(runway.value * 10) / 10} months of spending covered by cash (${runway.status}).`);
  const watch = health.filter((h) => h.status === 'risk' || h.status === 'watch').slice(0, 3);
  for (const h of watch) lines.push(`${h.status === 'risk' ? 'At risk' : 'Keep an eye on'}: ${h.label}. ${truncate(String(h.explanation ?? ''), 140)}`);
  const good = health.filter((h) => h.status === 'good').slice(0, 2).map((h) => h.label);
  if (good.length) lines.push(`Doing well: ${good.join(', ')}.`);

  const fc = rec(tools.forecast);
  if (fc.available) {
    lines.push(`Next 90 days: cash starts near ${money(fc.start?.balance ?? 0)}, ends near ${money(fc.end?.balance ?? 0)}; the lowest point is about ${money(fc.lowest?.balance ?? 0)} on ${fc.lowest?.date}.`);
    lines.push(fc.days_below_zero > 0 ? `Warning: the forecast dips below zero on ${fc.days_below_zero} ${fc.days_below_zero === 1 ? 'day' : 'days'}.` : 'The forecast never dips below zero.');
  }

  const obl = rec(tools.obligations);
  if (obl.count) {
    const today = parseDay(data.asOf);
    const dayOfMonth = today === null ? 1 : new Date(today * 86_400_000).getUTCDate();
    const upcoming = arr(obl.obligations)
      .map((o) => ({ ...o, in: ((Number(o.due_day) - dayOfMonth + 31) % 31) }))
      .sort((a, b) => a.in - b.in)
      .slice(0, 3)
      .map((o) => `${o.name} ${money(o.amount)} on ${nextDueLabel(Number(o.due_day), data.asOf)}`);
    lines.push(`Bills and payments: about ${money(obl.monthly_total ?? 0)} a month. Coming up next: ${upcoming.join('; ')}.`);
  }
  return lines.slice(0, 10);
}
