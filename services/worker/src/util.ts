// Small shared helpers: dates, rounding, JSON size fitting, hashing, abort-safe sleep.
import { createHash } from 'node:crypto';

export const MS_DAY = 86_400_000;
export const DAYS_PER_MONTH = 30.4375;

export const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
export const round1 = (x: number): number => Math.round((x + Number.EPSILON) * 10) / 10;
export const round0 = (x: number): number => Math.round(x);

export function usd(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(n);
  const body = (abs >= 100 ? Math.round(abs).toString() : abs.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${body}`;
}

/** Days since epoch for the leading YYYY-MM-DD of `s`, or null if it is not a real calendar date. */
export function parseDay(s: string): number | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(s ?? '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  if (new Date(ms).getUTCMonth() !== mo - 1) return null;
  return Math.floor(ms / MS_DAY);
}
export const formatDay = (day: number): string => new Date(day * MS_DAY).toISOString().slice(0, 10);
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The next date a monthly bill falls due, as people say it ("November 9"): this month if the day is still ahead (or today), else next
 *  month, clamped to the month's length. The voice reads "November 9" as "November ninth"; a bare "day 9" came out as "day nine". */
export function nextDueLabel(dueDay: number, asOf: string): string {
  const today = parseDay(asOf);
  if (today === null || !Number.isFinite(dueDay) || dueDay < 1) return `the ${Math.max(1, Math.round(dueDay || 1))}${ordinalSuffix(Math.round(dueDay || 1))}`;
  const t = new Date(today * MS_DAY);
  let y = t.getUTCFullYear();
  let m = t.getUTCMonth();
  if (Math.round(dueDay) < t.getUTCDate()) m += 1;
  if (m > 11) { m = 0; y += 1; }
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${MONTHS[m]} ${Math.min(Math.round(dueDay), last)}`;
}
function ordinalSuffix(n: number): string {
  const r = n % 100;
  if (r >= 11 && r <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
}
/** "2027-01-08" -> "January 2027". */
export function monthYear(iso: string): string {
  const d = parseDay(iso);
  if (d === null) return iso;
  const t = new Date(d * MS_DAY);
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** Whole months (fractional) between two ISO dates, never below 0. */
export function monthsBetween(fromIso: string, toIso: string): number {
  const a = parseDay(fromIso);
  const b = parseDay(toIso);
  if (a === null || b === null) return 0;
  return Math.max(0, (b - a) / DAYS_PER_MONTH);
}

export function addMonthsIso(iso: string, months: number): string {
  const d = parseDay(iso);
  if (d === null) return iso;
  return formatDay(Math.round(d + months * DAYS_PER_MONTH));
}

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
export function shortHash(s: string, n = 10): string {
  return sha1(s).slice(0, n);
}

export function slug(s: string, max = 40): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** "1 goal", "3 goals", "1 inquiry" / "2 inquiries": counts people read, never "goal(s)". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function listWords(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** How a workflow is named in trace titles and summaries people read. The workflow id `huddle` stays internal: the product calls it Table Mode. */
export function workflowLabel(workflow: string): string {
  return workflow === 'huddle' ? 'Table Mode' : workflow.replace(/_/g, ' ');
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Serialize `value` to JSON no longer than `maxLen`, shrinking long strings and arrays (never producing invalid
 * JSON). Used for trace data_json (4 KB cap) and tool results sent back to the model.
 */
export function fitJson(value: unknown, maxLen = 3800): string {
  let s = safeStringify(value);
  if (s.length <= maxLen) return s;
  let strMax = 240;
  let arrMax = 12;
  for (let i = 0; i < 8 && s.length > maxLen; i++) {
    s = safeStringify(shrink(value, strMax, arrMax, 0));
    strMax = Math.max(24, Math.floor(strMax * 0.6));
    arrMax = Math.max(2, Math.floor(arrMax * 0.7));
  }
  if (s.length > maxLen) s = JSON.stringify({ truncated: true, preview: s.slice(0, Math.max(0, maxLen - 60)) });
  return s;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}

function shrink(v: unknown, strMax: number, arrMax: number, depth: number): unknown {
  if (typeof v === 'string') return truncate(v, strMax);
  if (Array.isArray(v)) {
    const out = v.slice(0, arrMax).map((x) => shrink(x, strMax, arrMax, depth + 1));
    if (v.length > arrMax) out.push(`… ${v.length - arrMax} more` as unknown);
    return out;
  }
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = shrink(x, strMax, arrMax, depth + 1);
    return o;
  }
  return v;
}

/** Strip a leading ```json fence and parse the first JSON object/array found in free text. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = t.search(/[{[]/);
  if (start >= 0) {
    for (let end = t.length; end > start; end--) {
      const ch = t[end - 1];
      if (ch !== '}' && ch !== ']') continue;
      try {
        return JSON.parse(t.slice(start, end));
      } catch {
        /* keep shrinking */
      }
    }
  }
  throw new Error('no JSON found in text');
}
