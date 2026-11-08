// Shared by every tool that changes data for the family (kids.ts, goals.ts, studio.ts, family.ts): the spoken-yes gate and the
// spelling-tolerant "which one did they mean" lookup. Nothing here touches the database; the writes go through ToolContext.act.
import { MS_DAY, parseDay, truncate } from '../util.js';
import type { ToolContext } from './registry.js';

export type Act = NonNullable<ToolContext['act']>;

export function needsAct(ctx: ToolContext): asserts ctx is ToolContext & { act: Act } {
  if (!ctx.act) throw new Error("Changing the family's records is only possible on a call with Brian.");
}

/**
 * The two-step confirmation, shared. The FIRST call for an action (or any call whose key was not proposed at least 2.5 s ago)
 * returns the question to say back and proposes the key; only a call with `confirmed: true` AFTER that proceeds (returns null).
 * The key names the action by its essentials (what + which + how much), never free text, so a changed amount needs its own yes.
 */
export const ASK_NOTE = 'Not done yet: ask the caller exactly this and wait for a yes, then call again with confirmed true.';
export function gate(act: Act, key: string, confirmed: boolean, ask: string): { done: false; ask: string; note: string } | null {
  if (confirmed && act.confirmable(key)) return null;
  act.propose(key);
  return { done: false, ask, note: ASK_NOTE };
}
/** After the write: the yes is used up, so a repeated call asks again instead of writing twice. */
export const spend = (act: Act, key: string): void => act.consume?.(key);

// ---- names ----------------------------------------------------------------------------------------------------------------
/** Spelling-blind form of a name, for what speech recognition writes: "Sophia" = "Sofia", "Matteo" = "Mateo". */
export const sounds = (s: string): string => s.toLowerCase().replace(/'s$/, '').replace(/ph/g, 'f').replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

const STOP = new Set(['the', 'a', 'an', 'our', 'my', 'your', 'their', 'this', 'that', 'one', 'goal', 'goals', 'chore', 'chores', 'alert', 'alerts', 'proposal', 'proposals', 'about', 'for', 'to', 'of', 'and', 'on', 'in', 'please', 'new', 'called', 'named']);
const wordsOf = (s: string): string[] => s.toLowerCase().replace(/'s\b/g, '').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const x = sounds(a);
  const y = sounds(b);
  return x.length >= 4 && y.length >= 4 && (x === y || editDistance(x, y) <= 1); // "trips" = "trip", "Hawai" = "Hawaii"
}

/**
 * The one item the caller meant, from a few of its words ("the Hawaii trip" finds "Family trip to Hawaii"). Case-, plural- and
 * spelling-tolerant. Nothing said and exactly one item: that one. No match, or two equally good matches: an error that lists
 * the choices, so the model can ask which one instead of guessing. `noun` is "goal", "alert", "proposal", "chore".
 */
export function pickByWords<T>(items: readonly T[], said: string, label: (t: T) => string, noun: string): T | { error: string } {
  const list = (xs: readonly T[]): string => xs.slice(0, 6).map((t) => `"${truncate(label(t), 50)}"`).join(', ');
  if (!items.length) return { error: `There are no ${noun}s to choose from.` };
  const want = wordsOf(said);
  if (!want.length) return items.length === 1 ? items[0]! : { error: `Which ${noun}? The ${noun}s are ${list(items)}.` };
  const scored = items.map((t) => {
    const have = wordsOf(label(t));
    const hit = want.filter((w) => have.some((h) => sameWord(w, h))).length;
    return { t, score: hit / want.length, exact: hit === want.length && have.length === want.length }; // exact: they said all of it and nothing else
  });
  const need = want.length === 1 ? 1 : 0.5;
  const ok = scored.filter((x) => x.score >= need).sort((a, b) => b.score - a.score);
  if (!ok.length) return { error: `No ${noun} matching "${truncate(said, 60)}". The ${noun}s are ${list(items)}.` };
  // the best score wins; equally good matches are only told apart by an exact one ("college fund" among "College fund" and "College savings")
  const best = ok.filter((x) => x.score === ok[0]!.score);
  const exact = best.filter((x) => x.exact);
  if (best.length === 1) return best[0]!.t;
  if (exact.length === 1) return exact[0]!.t;
  return { error: `More than one ${noun} fits "${truncate(said, 60)}": ${list(best.map((x) => x.t))}. Ask which one.` };
}

// ---- dates ----------------------------------------------------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2028-06-01" -> "June 1, 2028", the way the voice should say a date. Anything else comes back as given. */
export function niceDate(iso: string): string {
  const d = parseDay(iso);
  if (d === null) return iso;
  const t = new Date(d * MS_DAY);
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`;
}
