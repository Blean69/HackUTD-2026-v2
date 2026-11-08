// detect_scam_signals: phrase rules over what people said, cross-checked against recent gift-card / wire / crypto spending.
import { z } from 'zod';
import type { HouseholdData } from '../types.js';
import { parseDay, round2, truncate, usd } from '../util.js';
import { defineTool } from './registry.js';

interface Rule {
  type: string;
  label: string;
  weight: number;
  re: RegExp;
}

export const SCAM_RULES: Rule[] = [
  { type: 'gift_cards', label: 'Payment demanded in gift cards', weight: 3, re: /gift[\s-]*cards?|google\s*play|itunes|apple\s*cards?|steam\s*cards?|scratch\s*off the back|read (?:them )?the (?:card )?numbers?/i },
  { type: 'wire_or_crypto', label: 'Wire transfer, cash app or crypto requested', weight: 3, re: /wire (?:the )?money|wire transfer|western union|moneygram|bitcoin|crypto(?:currency)?(?: atm)?|zelle (?:it|them)|cash\s*app/i },
  { type: 'bail_or_jail', label: 'Someone is "in jail" or needs bail', weight: 3, re: /\bbail\b|in jail|arrested|lawyer|attorney|public defender|court fees?|bond money/i },
  { type: 'family_in_trouble', label: 'A grandchild or relative in trouble', weight: 2, re: /grand(?:son|daughter|child|kid)|your (?:nephew|niece)|it'?s me,? grandma|it'?s me,? grandpa|car (?:accident|crash)|in the hospital abroad/i },
  { type: 'government_impersonation', label: 'Caller claims to be the IRS or a government agency', weight: 3, re: /\birs\b|internal revenue|social security (?:administration|number)|\bssa\b|warrant for|medicare (?:number|card)|\bfbi\b|customs|sheriff/i },
  { type: 'urgency', label: 'Extreme urgency or a same-day deadline', weight: 2, re: /right now|immediately|today only|before (?:five|5|midnight|the end of the day)|same[\s-]day|within (?:the )?hour|no time|act now|deadline/i },
  { type: 'secrecy', label: 'Told to keep it secret', weight: 2, re: /don'?t tell|do not tell|keep (?:this|it) (?:a )?secret|between us|not to tell|tell (?:no one|anyone)|don'?t (?:call|talk to|let) (?:your|his|her) (?:mom|dad|parents)/i },
  { type: 'remote_access', label: 'Asked for remote access or one-time codes', weight: 2, re: /remote (?:access|desktop)|teamviewer|anydesk|one[\s-]time (?:code|passcode)|verification code|read (?:me )?the (?:six|6)[\s-]digit/i },
  { type: 'prize_or_romance', label: 'Prize, lottery or online-romance pressure', weight: 1, re: /you(?:'ve| have)? won|lottery|sweepstakes|processing fee|inheritance|overseas|deployed/i },
  { type: 'stay_on_the_line', label: 'Caller stayed on the line while paying', weight: 1, re: /stay on the line|stayed on the (?:phone|line)|don'?t hang up|coach(?:ed)? (?:me|us|her|him|them)/i },
];

const PAYMENT_MERCHANT = /gift\s*card|google\s*play|itunes|apple\s*(gift|card)|steam\s*(card|wallet)|green\s*dot|moneypak|vanilla|western\s*union|moneygram|\bwire\b|bitcoin|crypto|coinme|coinflip/i; // \bwire\b: "AT&T wireless" is a phone bill, not a wire

export const ScamArgs = z.object({
  text: z.string().optional().describe('What was said or received (call, text, email). Speaker prefixes like "Name: ..." are used for quotes.'),
  lines: z.array(z.object({ speaker: z.string(), text: z.string() })).optional().describe('Transcript lines, if available'),
  lookback_days: z.number().int().min(1).max(180).optional().describe('How far back to look for matching payments (default 45)'),
});

export interface ScamSignal {
  type: string;
  label: string;
  quote: string;
  speaker?: string;
}
export interface ScamResult {
  risk: 'none' | 'low' | 'medium' | 'high';
  score: number;
  signal_types: string[];
  signals: ScamSignal[];
  linked_transactions: { id: string; date: string; amount: number; merchant: string }[];
  linked_total: number;
  summary: string;
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function detectScamSignals(args: z.infer<typeof ScamArgs>, data: HouseholdData): ScamResult {
  const chunks: { speaker?: string; text: string }[] = [];
  for (const l of args.lines ?? []) chunks.push({ speaker: l.speaker, text: l.text });
  if (args.text) {
    for (const line of args.text.split('\n')) {
      const m = /^([A-Z][\w .'-]{0,30}):\s+(.*)$/.exec(line);
      chunks.push(m ? { speaker: m[1]!, text: m[2]! } : { text: line });
    }
  }
  const signals: ScamSignal[] = [];
  const seen = new Map<string, number>();
  for (const c of chunks) {
    for (const s of sentencesOf(c.text)) {
      for (const rule of SCAM_RULES) {
        if (!rule.re.test(s)) continue;
        const n = seen.get(rule.type) ?? 0;
        if (n >= 2) continue; // at most two quotes per signal type
        seen.set(rule.type, n + 1);
        signals.push({ type: rule.type, label: rule.label, quote: truncate(s, 180), ...(c.speaker ? { speaker: c.speaker } : {}) });
      }
    }
  }
  const types = [...seen.keys()];
  let score = SCAM_RULES.filter((r) => seen.has(r.type)).reduce((s, r) => s + r.weight, 0);

  const today = parseDay(data.asOf) ?? Infinity;
  const from = today - (args.lookback_days ?? 45);
  const linked = data.txns
    .filter((t) => {
      const d = parseDay(t.date);
      return d !== null && d >= from && d <= today && t.amount < 0 && (t.category === 'gift_cards' || PAYMENT_MERCHANT.test(t.merchant) || PAYMENT_MERCHANT.test(t.description));
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 8)
    .map((t) => ({ id: t.id, date: t.date.slice(0, 10), amount: t.amount, merchant: t.merchant }));
  const linkedTotal = round2(linked.reduce((s, t) => s - t.amount, 0));
  const linkable = types.some((t) => t === 'gift_cards' || t === 'wire_or_crypto' || t === 'bail_or_jail');
  if (linked.length && (linkable || score > 0)) score += 3;
  const risk: ScamResult['risk'] = score >= 7 ? 'high' : score >= 4 ? 'medium' : score >= 1 ? 'low' : 'none';
  // Spending alone (no conversation) is surfaced as a low-risk heads-up, not a scam call.
  const summary =
    risk === 'none'
      ? linked.length
        ? `No scam language found, but ${linked.length} recent gift-card or wire payment(s) totalling ${usd(linkedTotal)} are worth a look.`
        : 'No scam signals found.'
      : `${types.length} scam signal type(s): ${types.join(', ')}.${linked.length ? ` Linked to ${linked.length} recent payment(s) totalling ${usd(linkedTotal)}.` : ''}`;
  return { risk, score, signal_types: types, signals: signals.slice(0, 10), linked_transactions: linked, linked_total: linkedTotal, summary };
}

export const detectScamSignalsTool = defineTool({
  name: 'detect_scam_signals',
  description:
    'Scan a conversation, call description, text or email for scam patterns (gift cards, wires, bail, IRS, urgency, secrecy, a grandchild in trouble) and cross-check against recent gift-card, wire or crypto transactions.',
  schema: ScamArgs,
  describe: () => 'Scanning for scam language and matching recent payments',
  run: (a, { data }) => detectScamSignals(a, data),
  summarize: (r: ScamResult) => `Scam risk ${r.risk}: ${r.summary}`,
});
