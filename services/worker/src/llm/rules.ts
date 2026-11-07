// Deterministic text understanding used by the keyless `local` provider (and by tests): spoken numbers, dates,
// goal extraction from a conversation, and natural-language -> Scenario parsing. Pure functions, no I/O.
import { z } from 'zod';
import { addMonthsIso, formatDay, parseDay, truncate } from '../util.js';
import type { Scenario } from '../tools/simulate.js';

// ---- schemas shared with the LLM path -------------------------------------------------------------------------------
export const GOAL_KINDS = ['business', 'college', 'home', 'care', 'debt', 'emergency_fund', 'retirement', 'vehicle', 'repair', 'travel', 'scam_recovery', 'other'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const HuddleExtractSchema = z.object({
  goals: z
    .array(
      z.object({
        title: z.string().min(3).max(120).describe('Short goal title in plain language'),
        kind: z.enum(GOAL_KINDS),
        target_amount: z.number().min(0).describe('Dollar amount needed; 0 if no amount was said'),
        target_date: z.string().describe('YYYY-MM-DD deadline; empty string if none was said'),
        priority: z.number().int().min(1).max(9).describe('1 = most important'),
        evidence_quote: z.string().max(240).describe('Short verbatim quote from the conversation that supports this goal'),
        school: z.string().optional().describe('For college goals: the school if one was named'),
      }),
    )
    .max(8),
  concerns: z.array(z.object({ text: z.string().max(200), speaker: z.string().optional() })).max(6),
  key_dates: z.array(z.object({ label: z.string().max(100), date: z.string() })).max(6),
});
export type HuddleExtract = z.infer<typeof HuddleExtractSchema>;

// ---- numbers ---------------------------------------------------------------------------------------------------------
const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE: Record<string, number> = { thousand: 1_000, million: 1_000_000, grand: 1_000 };

export interface Money {
  value: number;
  index: number;
  raw: string;
}

/** Dollar amounts in a sentence: "$14,500", "$250k", "two hundred fifty thousand", "9 thousand". Ignores percents, ages, years. */
export function findMoney(text: string): Money[] {
  const out: Money[] = [];
  const re = /(\$\s*)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s*(?:k\b|K\b|thousand|million|grand|mil\b|m\b))?(\s*(?:dollars|bucks))?/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14).toLowerCase();
    if (/^\s*(%|percent|years?|yrs?|months?|days?|weeks?|am\b|pm\b|o'?clock|minutes?|points?|st\b|nd\b|rd\b|th\b)/.test(after)) continue;
    const hasDollar = !!m[1] || !!m[4];
    const scale = m[3]?.trim().toLowerCase();
    let v = Number(m[2]!.replace(/,/g, ''));
    if (scale) v *= scale.startsWith('m') && scale !== 'million' && scale !== 'mil' ? 1_000_000 : scale === 'million' || scale === 'mil' ? 1_000_000 : 1_000;
    const isYear = !hasDollar && !scale && v >= 1900 && v <= 2100 && !m[2]!.includes(',');
    if (isYear) continue;
    if (!hasDollar && !scale && v < 1000) continue; // "3" or "250" alone is not money
    out.push({ value: Math.round(v * 100) / 100, index: m.index, raw: m[0].trim() });
  }
  // spoken numbers
  const tokens = [...text.matchAll(/[A-Za-z']+|\d+|[^\sA-Za-z\d]/g)];
  let i = 0;
  while (i < tokens.length) {
    const w = tokens[i]![0].toLowerCase();
    if (!(w in UNITS) && !(w in TENS) && w !== 'hundred' && w !== 'a' && !(w in SCALE)) {
      i++;
      continue;
    }
    let j = i;
    let total = 0;
    let cur = 0;
    let sawScale = false;
    let any = false;
    while (j < tokens.length) {
      const t = tokens[j]![0].toLowerCase();
      const next = tokens[j + 1]?.[0].toLowerCase() ?? '';
      if (t in UNITS) {
        cur += UNITS[t]!;
        any = true;
      } else if (t in TENS) {
        cur += TENS[t]!;
        any = true;
      } else if (t === 'hundred') {
        cur = (cur || 1) * 100;
        any = true;
        sawScale = true;
      } else if (t in SCALE) {
        total += (cur || 1) * SCALE[t]!;
        cur = 0;
        any = true;
        sawScale = true;
      } else if (t === 'point' && any && next in UNITS) {
        // "one point three million": the digits after "point" are a decimal fraction of the following scale word
        let frac = 0;
        let place = 0.1;
        let k = j + 1;
        while (k < tokens.length && (tokens[k]![0].toLowerCase() in UNITS)) {
          frac += UNITS[tokens[k]![0].toLowerCase()]! * place;
          place /= 10;
          k++;
        }
        const sc = tokens[k]?.[0].toLowerCase() ?? '';
        if (sc in SCALE) {
          total += (cur + frac) * SCALE[sc]!;
          cur = 0;
          sawScale = true;
          j = k;
        } else break;
      } else if (t === 'a' && (next === 'hundred' || next === 'thousand' || next === 'million')) {
        /* "a hundred" */
      } else if (t === 'and' && any && (next in UNITS || next in TENS)) {
        /* "five hundred and fifty" */
      } else if (t === '-' || t === ',') {
        if (!any) break;
      } else break;
      j++;
    }
    total += cur;
    const next = tokens[j]?.[0].toLowerCase() ?? '';
    if (any && (sawScale || /^(dollars|bucks)$/.test(next)) && total >= 100 && !/^(percent|%|years?|months?)$/.test(next)) {
      const index = tokens[i]!.index ?? 0;
      out.push({ value: total, index, raw: text.slice(index, (tokens[j - 1]!.index ?? 0) + tokens[j - 1]![0].length) });
    }
    i = Math.max(j, i + 1);
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---- dates -----------------------------------------------------------------------------------------------------------
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const SEASONS: Record<string, [number, number]> = { spring: [4, 15], summer: [6, 30], fall: [8, 15], autumn: [8, 15], winter: [1, 31] };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty-first': 21, 'twenty-second': 22, 'twenty-third': 23, 'twenty-fourth': 24, 'twenty-fifth': 25, 'twenty-sixth': 26, 'twenty-seventh': 27, 'twenty-eighth': 28, 'twenty-ninth': 29, thirtieth: 30, 'thirty-first': 31 };

const monthNum = (s: string): number => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3))) + 1;
const pad = (n: number): string => String(n).padStart(2, '0');
const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** First date mentioned in `text`, as YYYY-MM-DD, resolved relative to `asOf`. Returns '' when none. */
export function findDate(text: string, asOf: string): string {
  const t = text.toLowerCase();
  const today = parseDay(asOf) ?? 0;
  const ay = new Date(today * 86_400_000).getUTCFullYear();
  const am = new Date(today * 86_400_000).getUTCMonth() + 1;
  const nextOccurrence = (m: number, d: number): string => {
    let y = ay;
    if (m < am || (m === am && d < new Date(today * 86_400_000).getUTCDate())) y++;
    return `${y}-${pad(m)}-${pad(Math.min(d, lastDay(y, m)))}`;
  };
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\b`).exec(t)) && Number(m[2]) <= 31) {
    const mo = monthNum(m[1]!);
    const d = Number(m[2]);
    return m[3] ? `${m[3]}-${pad(mo)}-${pad(Math.min(d, lastDay(Number(m[3]), mo)))}` : nextOccurrence(mo, d);
  }
  if ((m = new RegExp(`\\b${MONTH_RE}\\.?\\s+(${Object.keys(ORDINALS).join('|')})\\b`).exec(t))) return nextOccurrence(monthNum(m[1]!), ORDINALS[m[2]!]!);
  if ((m = new RegExp(`\\b(?:end of |late |early |mid[- ])?${MONTH_RE}\\s+(?:of\\s+)?(20\\d\\d)\\b`).exec(t))) {
    const mo = monthNum(m[1]!);
    return `${m[2]}-${pad(mo)}-${pad(lastDay(Number(m[2]), mo))}`;
  }
  if ((m = new RegExp(`\\b(spring|summer|fall|autumn|winter)\\s+(?:of\\s+)?(20\\d\\d)\\b`).exec(t))) {
    const [mo, d] = SEASONS[m[1]!]!;
    return `${m[2]}-${pad(mo)}-${pad(d)}`;
  }
  if ((m = new RegExp(`\\b(?:end of |by |in |before )?${MONTH_RE}\\s+next year\\b`).exec(t))) {
    const mo = monthNum(m[1]!);
    return `${ay + 1}-${pad(mo)}-${pad(lastDay(ay + 1, mo))}`;
  }
  if ((m = new RegExp(`\\b(?:by|before|in|until|through)\\s+(?:the end of\\s+)?(20\\d\\d)\\b`).exec(t))) return `${m[1]}-12-31`;
  if ((m = /\bin\s+(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten)\s+(year|yr|month)s?\b/.exec(t))) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : m[1] === 'a' ? 1 : (UNITS[m[1]!] ?? 1);
    return addMonthsIso(asOf, m[2]!.startsWith('y') ? n * 12 : n);
  }
  if ((m = new RegExp(`\\b(?:by |before |this |next )?(spring|summer|fall|autumn|winter)\\b`).exec(t)) && /\b(by|before|next|this)\b/.test(t)) {
    const [mo, d] = SEASONS[m[1]!]!;
    const y = mo < am ? ay + 1 : ay;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  if (/\bnext year\b/.test(t)) return `${ay + 1}-12-31`;
  if ((m = new RegExp(`\\b(?:by|before|in|end of)\\s+${MONTH_RE}\\b`).exec(t))) {
    const mo = monthNum(m[1]!);
    const y = mo < am ? ay + 1 : ay;
    return `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`;
  }
  return '';
}

// ---- goal extraction -------------------------------------------------------------------------------------------------
interface Topic {
  kind: GoalKind;
  re: RegExp;
  title: (detail: string) => string;
}
const TOPICS: Topic[] = [
  { kind: 'scam_recovery', re: /\bscam|fraud|report(?:ing)?\s+(?:the\s+)?(?:\w+\s+){0,3}purchases|police report|call[- ]?back rule|call the family back|recover the money|dispute the|alerts? on all|code word/i, title: () => 'Report the scam and lock down the accounts' },
  { kind: 'other', re: /\bcds?\b[^.]{0,40}\b(?:matur|decide|renew)|certificate of deposit|(?:matur|decide)[^.]{0,40}\bcd\b/i, title: () => 'Decide what to do with the maturing CD' },
  { kind: 'business', re: /second (?:bakery|location|store|shop)|new location|build-?out|expansion|sba\b|7\(?a\)?\b|open (?:a |the )?(?:new|second)/i, title: (d) => (/second|new/i.test(d) ? 'Open a second business location' : 'Fund the business expansion') },
  { kind: 'college', re: /college|529|tuition|universit|ut dallas|utd\b|ut austin|school fund|scholarship|dorm/i, title: (d) => (/529/.test(d) ? 'Close the gap on the college 529 plan' : 'Build the college fund') },
  { kind: 'care', re: /medicare|medical|home[- ]?care|care costs?|nursing|abuela|grandma|grandpa|pop'?s care|assisted living|caregiver|hospice|elder care/i, title: () => 'Set aside funds for a parent or grandparent\'s care' },
  { kind: 'home', re: /first home|buy (?:a |our |the )?(?:house|home)|down payment|closing costs|house hunting|mortgage pre/i, title: () => 'Save for a home purchase' },
  { kind: 'repair', re: /\broof\b|furnace|hvac|plumbing|foundation|repair|renovat|remodel/i, title: (d) => `Pay for the ${/roof/i.test(d) ? 'roof replacement' : 'home repair'}` },
  { kind: 'vehicle', re: /\b(?:buy|get|replace|help|first|new|used|purchase)\b[^.]{0,30}\b(?:car|truck|vehicle)\b|\b(?:car|truck|vehicle)\b[^.]{0,20}\b(?:fund|purchase|match)/i, title: () => 'Buy or replace a vehicle' },
  { kind: 'debt', re: /pay(?:ing)? (?:off|down)|credit cards?|utilization|\bdebt\b|loan balance/i, title: () => 'Pay down high-interest debt' },
  { kind: 'emergency_fund', re: /emergency fund|cushion|rainy day|safety net|buffer|\breserve\b/i, title: () => 'Build an emergency cushion' },
  { kind: 'retirement', re: /retire|\bira\b|401\(?k\)?|pension/i, title: () => 'Boost retirement savings' },
  { kind: 'travel', re: /vacation|\btrip\b|cruise|honeymoon|wedding/i, title: () => 'Plan and save for a trip' },
];
const INTENT = /\b(want to|wanna|need to|needs to|plan to|planning to|going to|gonna|goal|let'?s|we should|hope to|would like|save|saving|set aside|put (?:away|aside)|pay off|pay down|buy|open|build|replace|fund|cover|get (?:both|the|under)|apply|enroll|compare|start|report|decide|close the gap|grow|matures?|maturing)\b/i;
const MONEY_CUE = /\b(cost|costs|price|total|quote|estimate|about|around|need|needs|set aside|save|saving|budget|build-?out|down|target|to cover|fund|raise|borrow|gap)\b/i;
const INCOME_CUE = /\b(revenue|sales|income|earn|earned|make|makes|made|paycheck|salary|draw|per month|a month|monthly|payment)\b/i;
const WORRY = /\b(worried|worry|afraid|scared|nervous|concerned|stress(?:ed)?|can'?t afford|don'?t know how|too much|risky|tight|behind|overdraft|not sure)\b/i;

export interface Line {
  speaker: string;
  text: string;
}

function sentences(line: Line): { speaker: string; text: string }[] {
  return line.text
    .split(/(?<=[.!?])\s+|,\s*(?:and|but|plus)\s+|;\s*/)
    .map((t) => t.trim())
    .filter((t) => t.length > 8)
    .map((t) => ({ speaker: line.speaker, text: t }));
}

export function extractFromLines(lines: Line[], asOf: string): HuddleExtract {
  const sents = lines.flatMap(sentences);
  interface Cluster {
    topic: Topic;
    firstAt: number;
    hits: { s: string; speaker: string; at: number; money: Money[]; date: string; intent: boolean }[];
    detail: string;
  }
  const clusters = new Map<GoalKind, Cluster>();
  sents.forEach((s, at) => {
    const topic = TOPICS.find((t) => t.re.test(s.text));
    if (!topic) return;
    const money = findMoney(s.text);
    const intent = INTENT.test(s.text);
    if (!intent && !money.length) return;
    const c = clusters.get(topic.kind) ?? { topic, firstAt: at, hits: [], detail: '' };
    c.hits.push({ s: s.text, speaker: s.speaker, at, money, date: findDate(s.text, asOf), intent });
    c.detail += ` ${s.text}`;
    clusters.set(topic.kind, c);
  });

  const goals: HuddleExtract['goals'] = [];
  const ranked = [...clusters.values()].filter((c) => c.hits.some((h) => h.intent || h.money.length)).sort((a, b) => a.firstAt - b.firstAt);
  for (const c of ranked) {
    // amount: prefer sentences that talk about cost / saving and not about income
    let best: { v: number; score: number; s: string } | null = null;
    for (const h of c.hits) {
      for (const m of h.money) {
        if (m.value > 5_000_000 || m.value < 50) continue;
        const score = (MONEY_CUE.test(h.s) ? 2 : 0) + (INCOME_CUE.test(h.s) && !MONEY_CUE.test(h.s) ? -3 : 0) + (h.intent ? 1 : 0);
        if (!best || score > best.score || (score === best.score && m.value > best.v)) best = { v: m.value, score, s: h.s };
      }
    }
    const withAmount = best && best.score >= 0 ? best : null;
    let dateHit: { date: string } | undefined = c.hits.find((h) => h.date && h.intent) ?? c.hits.find((h) => h.date);
    if (!dateHit) {
      // a deadline is often said in the next sentence ("...the second location. We want to open by September next year.")
      for (const h of c.hits) {
        for (const k of [h.at + 1, h.at - 1, h.at + 2]) {
          const near = sents[k];
          const d = near ? findDate(near.text, asOf) : '';
          if (d) {
            dateHit = { date: d };
            break;
          }
        }
        if (dateHit) break;
      }
    }
    const evidence = withAmount?.s ?? c.hits.find((h) => h.intent)?.s ?? c.hits[0]!.s;
    const school = c.topic.kind === 'college' ? /\b(ut dallas|utd|ut austin|university of texas[ a-z]*|texas a&m|unt|smu)\b/i.exec(c.detail)?.[0] : undefined;
    goals.push({
      title: c.topic.title(c.detail),
      kind: c.topic.kind,
      target_amount: withAmount ? withAmount.v : 0,
      target_date: dateHit?.date ?? '',
      priority: Math.min(9, goals.length + 1),
      evidence_quote: truncate(evidence, 230),
      ...(school ? { school } : {}),
    });
  }
  const concerns = sents
    .filter((s) => WORRY.test(s.text))
    .slice(0, 5)
    .map((s) => ({ text: truncate(s.text, 190), speaker: s.speaker }));
  const keyDates: HuddleExtract['key_dates'] = [];
  for (const s of sents) {
    const d = findDate(s.text, asOf);
    if (d && /deadline|by|until|closes|enrollment|hold|due|before/i.test(s.text) && keyDates.length < 5 && !keyDates.some((k) => k.date === d)) keyDates.push({ label: truncate(s.text, 90), date: d });
  }
  return { goals: goals.slice(0, 8), concerns, key_dates: keyDates };
}

// ---- natural language -> Scenario ------------------------------------------------------------------------------------
export function parseScenarioPrompt(prompt: string): Scenario {
  const p = prompt.trim();
  const lower = p.toLowerCase();
  const money = findMoney(p);
  const first = money[0]?.value;
  const pct = [...p.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/gi)].map((m) => {
    const idx = m.index ?? 0;
    const after = lower.slice(idx + m[0].length, idx + m[0].length + 12);
    const before = lower.slice(Math.max(0, idx - 16), idx);
    const isDown = /^\s*(?:as a )?down/.test(after) || /down payment (?:of|is)\s*$/.test(before);
    const isRate = !isDown && (/^\s*(?:apr|apy|interest|rate)/.test(after) || /(?:rate of|apr of|interest of|rate at|rate is|at)\s*$/.test(before));
    return { v: Number(m[1]), idx, ctx: `${before} ${after}`, isDown, isRate };
  });
  const months = /(\d+)\s*(?:-|\s)?(year|yr|month|mo)/i.exec(p);
  const termMonths = months ? (months[2]!.toLowerCase().startsWith('y') ? Number(months[1]) * 12 : Number(months[1])) : undefined;
  const label = truncate(p.replace(/\s+/g, ' ').replace(/[?.!]+$/, ''), 90);

  let kind: Scenario['kind'] = 'purchase';
  if (/\b(pay(?:ing)? off|payoff|pay down|paying down|clear the)\b/.test(lower)) kind = 'payoff';
  else if (/\b(rates?|apr)\b.*\b(go|goes|going|rise|rises|increase|jump|climb|up|down|drop|fall|cut)\b|\binterest rates?\b/.test(lower) && !/(buy|purchase)/.test(lower)) kind = 'rate_change';
  else if (/\b(lose[sd]?|lost|laid off|layoff|job loss|raise|promotion|pay cut|salary|income|paycheck|revenue|sales|bonus|quit|retire|part[- ]time|hours cut)\b/.test(lower) && !/\b(buy|purchase)\b/.test(lower)) kind = 'income_change';
  else if (/\b(take (?:out )?an? |new loan|borrow|sba loan|line of credit|personal loan|loan for)\b/.test(lower) && !/\b(buy|purchase|afford)\b/.test(lower)) kind = 'new_loan';

  const scn: Scenario = { kind, label };
  const apr = pct.find((x) => x.isRate);
  if (kind === 'purchase') {
    if (first !== undefined) scn.amount = first;
    const downPct = pct.find((x) => x.isDown);
    const downMoney = money.find((m) => /down/.test(lower.slice(m.index, m.index + m.raw.length + 12)) && m.value !== first);
    if (downPct && first) scn.down_payment = Math.round((first * downPct.v) / 100);
    else if (downMoney) scn.down_payment = downMoney.value;
    scn.financed = /financ|loan|monthly payment|mortgage|lease|payments?\b|down\b/.test(lower) || undefined;
    if (apr) scn.apr_pct = apr.v;
    if (termMonths && termMonths >= 6) scn.term_months = termMonths;
    if (scn.financed || scn.term_months) scn.months = 24;
  } else if (kind === 'new_loan') {
    if (first !== undefined) scn.amount = first;
    if (apr) scn.apr_pct = apr.v;
    if (termMonths && termMonths >= 6) scn.term_months = termMonths;
    scn.months = 24;
  } else if (kind === 'income_change') {
    const down = /\b(lose[sd]?|lost|laid off|layoff|drop|drops|dropped|cut|cuts|lower|less|decrease|fall|falls|reduced?|quit|slow|slump)\b/.test(lower);
    const up = /\b(raise|promotion|bonus|increase|more|higher|grows?)\b/.test(lower) && !down;
    const allLost = /\b(lose[sd]? (?:my|his|her|our|their) job|laid off|layoff|job loss|quit)\b/.test(lower);
    if (pct[0]) scn.income_change_pct = (up ? 1 : -1) * pct[0].v;
    else if (first !== undefined) scn.income_change_monthly = (up ? 1 : -1) * (/\b(per year|a year|annual|yearly)\b/.test(lower) ? first / 12 : first);
    else if (allLost) scn.income_change_pct = -50; // one earner's job: assume about half the household income
    else scn.income_change_pct = up ? 10 : -20;
    scn.start_month = 1;
    if (months && months[2]!.toLowerCase().startsWith('m')) scn.duration_months = Number(months[1]);
    else if (months && months[2]!.toLowerCase().startsWith('y')) scn.duration_months = Number(months[1]) * 12;
    scn.months = 12;
  } else if (kind === 'payoff') {
    if (first !== undefined) scn.amount = first;
    scn.account_hint = /car|auto|truck|vehicle/.test(lower) ? 'auto_loan' : /card/.test(lower) ? 'credit_card' : /mortgage|house|home/.test(lower) ? 'mortgage' : /personal|student/.test(lower) ? 'personal_loan' : undefined;
    if (!scn.account_hint) delete scn.account_hint;
    scn.months = 12;
  } else if (kind === 'rate_change') {
    const pts = /(\d+(?:\.\d+)?)\s*(?:points?|percentage points?|pts?|%|percent)/i.exec(p);
    const down = /\b(drop|fall|cut|lower|down|decrease)\b/.test(lower);
    scn.rate_delta_pct = (down ? -1 : 1) * (pts ? Number(pts[1]) : 1);
    scn.months = 12;
    if (/mortgage/.test(lower)) scn.account_hint = 'mortgage';
  }
  return scn;
}

export { formatDay };
