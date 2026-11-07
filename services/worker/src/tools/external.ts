// Real external APIs with 5 s timeouts, a disk cache and honest fallbacks (the `source` field says which path answered).
//   FRED:            https://api.stlouisfed.org/fred  (FRED_API_KEY; without it a fixed reference table, marked)
//   College Scorecard: https://api.data.gov/ed/collegescorecard/v1  (DATA_GOV_API_KEY, default DEMO_KEY: few calls/hour, so cached)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { round2, usd } from '../util.js';
import { defineTool } from './registry.js';

export const FETCH_TIMEOUT_MS = 5000;

export interface FredResult {
  series_id: string;
  title: string;
  unit: string;
  latest: { date: string; value: number };
  previous?: { date: string; value: number };
  source: 'fred_live' | 'fred_cache' | 'fixed_table';
  note?: string;
}

export interface ScorecardResult {
  school_id: number;
  name: string;
  city: string;
  state: string;
  cost_of_attendance: number | null;
  tuition_in_state: number | null;
  tuition_out_of_state: number | null;
  avg_net_price: number | null;
  admission_rate: number | null;
  student_size: number | null;
  source: 'scorecard_live' | 'scorecard_cache' | 'fixed_table';
  note?: string;
}

export interface ExternalApis {
  fred(seriesId: string): Promise<FredResult>;
  scorecard(query: { school_name?: string; school_id?: number }): Promise<ScorecardResult>;
}

// ---- fixed fallbacks (approximate reference values, clearly marked in results) ----------------------------------------
const FRED_FIXED: Record<string, { title: string; unit: string; value: number }> = {
  MORTGAGE30US: { title: '30-Year Fixed Rate Mortgage Average in the United States', unit: 'percent', value: 6.2 },
  MORTGAGE15US: { title: '15-Year Fixed Rate Mortgage Average in the United States', unit: 'percent', value: 5.5 },
  DPRIME: { title: 'Bank Prime Loan Rate', unit: 'percent', value: 6.75 },
  FEDFUNDS: { title: 'Federal Funds Effective Rate', unit: 'percent', value: 3.9 },
  DGS10: { title: 'Market Yield on U.S. Treasury Securities at 10-Year Constant Maturity', unit: 'percent', value: 4.1 },
  TERMCBCCALLNS: { title: 'Commercial Bank Interest Rate on Credit Card Plans, All Accounts', unit: 'percent', value: 21.5 },
  TERMCBPER24NS: { title: 'Finance Rate on Personal Loans at Commercial Banks, 24 Month', unit: 'percent', value: 12.3 },
};
const FIXED_AS_OF = '2026-10-01';

const SCORECARD_FIXED: Record<number, Omit<ScorecardResult, 'source' | 'note'>> = {
  228787: { school_id: 228787, name: 'The University of Texas at Dallas', city: 'Richardson', state: 'TX', cost_of_attendance: 29648, tuition_in_state: 14664, tuition_out_of_state: 40164, avg_net_price: 15271, admission_rate: 0.6513, student_size: 21751 },
  228778: { school_id: 228778, name: 'The University of Texas at Austin', city: 'Austin', state: 'TX', cost_of_attendance: 31000, tuition_in_state: 11678, tuition_out_of_state: 42778, avg_net_price: 18000, admission_rate: 0.29, student_size: 41000 },
};
const SCHOOL_ALIASES: [RegExp, number][] = [
  [/\b(ut\s*dallas|utd|university of texas (?:at|@) dallas|the university of texas at dallas)\b/i, 228787],
  [/\b(ut\s*austin|university of texas (?:at|@) austin|the university of texas at austin)\b/i, 228778],
];
const SCORECARD_FIELDS = [
  'id',
  'school.name',
  'school.city',
  'school.state',
  'latest.cost.attendance.academic_year',
  'latest.cost.tuition.in_state',
  'latest.cost.tuition.out_of_state',
  'latest.cost.avg_net_price.overall',
  'latest.admissions.admission_rate.overall',
  'latest.student.size',
].join(',');

type FetchFn = typeof fetch;
interface CacheEntry<T> {
  fetched_at: number;
  data: T;
}

export interface ExternalOptions {
  fredApiKey: string;
  dataGovApiKey: string;
  cacheDir: string;
  fetch?: FetchFn;
  now?: () => number;
  fredTtlMs?: number;
  scorecardTtlMs?: number;
}

export class RealExternalApis implements ExternalApis {
  private f: FetchFn;
  private now: () => number;
  constructor(private o: ExternalOptions) {
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  private async readCache<T>(name: string): Promise<CacheEntry<T> | null> {
    try {
      return JSON.parse(await readFile(join(this.o.cacheDir, name), 'utf8')) as CacheEntry<T>;
    } catch {
      return null;
    }
  }
  private async writeCache<T>(name: string, data: T): Promise<void> {
    try {
      await mkdir(this.o.cacheDir, { recursive: true });
      await writeFile(join(this.o.cacheDir, name), JSON.stringify({ fetched_at: this.now(), data } satisfies CacheEntry<T>));
    } catch {
      /* cache is best effort */
    }
  }
  private async getJson(url: string): Promise<unknown> {
    const res = await this.f(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async fred(seriesIdRaw: string): Promise<FredResult> {
    const seriesId = seriesIdRaw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    const cacheName = `fred_${seriesId}.json`;
    const cached = await this.readCache<FredResult>(cacheName);
    const ttl = this.o.fredTtlMs ?? 6 * 3600_000;
    if (cached && this.now() - cached.fetched_at < ttl) return { ...cached.data, source: this.o.fredApiKey ? 'fred_cache' : cached.data.source };

    if (this.o.fredApiKey) {
      try {
        const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(this.o.fredApiKey)}&file_type=json&sort_order=desc&limit=10`;
        const body = (await this.getJson(url)) as { observations?: { date: string; value: string }[] };
        const obs = (body.observations ?? []).filter((o) => o.value !== '.' && Number.isFinite(Number(o.value)));
        if (!obs.length) throw new Error('no observations');
        const fixed = FRED_FIXED[seriesId];
        const out: FredResult = {
          series_id: seriesId,
          title: fixed?.title ?? seriesId,
          unit: fixed?.unit ?? 'value',
          latest: { date: obs[0]!.date, value: Number(obs[0]!.value) },
          ...(obs[1] ? { previous: { date: obs[1].date, value: Number(obs[1].value) } } : {}),
          source: 'fred_live',
        };
        await this.writeCache(cacheName, out);
        return out;
      } catch (e) {
        if (cached) return { ...cached.data, source: 'fred_cache', note: `FRED unreachable (${errMsg(e)}); showing the last cached value.` };
      }
    }
    const fixed = FRED_FIXED[seriesId];
    if (!fixed) throw new Error(`Unknown FRED series ${seriesId} and no FRED_API_KEY configured. Known offline series: ${Object.keys(FRED_FIXED).join(', ')}`);
    return {
      series_id: seriesId,
      title: fixed.title,
      unit: fixed.unit,
      latest: { date: FIXED_AS_OF, value: fixed.value },
      source: 'fixed_table',
      note: this.o.fredApiKey ? 'FRED was unreachable; value comes from a fixed reference table, not live data.' : 'No FRED_API_KEY configured; value comes from a fixed reference table, not live data.',
    };
  }

  async scorecard(q: { school_name?: string; school_id?: number }): Promise<ScorecardResult> {
    let id = q.school_id;
    if (!id && q.school_name) for (const [re, sid] of SCHOOL_ALIASES) if (re.test(q.school_name)) id = sid;
    if (!id && !q.school_name) throw new Error('school_name or school_id is required');
    const key = id ? `id_${id}` : `name_${q.school_name!.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    const cacheName = `scorecard_${key}.json`;
    const cached = await this.readCache<ScorecardResult>(cacheName);
    const ttl = this.o.scorecardTtlMs ?? 30 * 24 * 3600_000; // DEMO_KEY allows few calls per hour; costs change yearly
    if (cached && this.now() - cached.fetched_at < ttl) return { ...cached.data, source: 'scorecard_cache' };

    try {
      const base = `https://api.data.gov/ed/collegescorecard/v1/schools.json?api_key=${encodeURIComponent(this.o.dataGovApiKey || 'DEMO_KEY')}&fields=${SCORECARD_FIELDS}&per_page=5`;
      const url = id ? `${base}&id=${id}` : `${base}&school.name=${encodeURIComponent(q.school_name!)}`;
      const body = (await this.getJson(url)) as { results?: Record<string, unknown>[] };
      const r = body.results?.[0];
      if (!r) throw new Error('no matching school');
      const n = (k: string): number | null => (typeof r[k] === 'number' ? (r[k] as number) : null);
      const out: ScorecardResult = {
        school_id: Number(r.id),
        name: String(r['school.name'] ?? q.school_name ?? ''),
        city: String(r['school.city'] ?? ''),
        state: String(r['school.state'] ?? ''),
        cost_of_attendance: n('latest.cost.attendance.academic_year'),
        tuition_in_state: n('latest.cost.tuition.in_state'),
        tuition_out_of_state: n('latest.cost.tuition.out_of_state'),
        avg_net_price: n('latest.cost.avg_net_price.overall'),
        admission_rate: n('latest.admissions.admission_rate.overall'),
        student_size: n('latest.student.size'),
        source: 'scorecard_live',
      };
      await this.writeCache(cacheName, out);
      return out;
    } catch (e) {
      if (cached) return { ...cached.data, source: 'scorecard_cache', note: `College Scorecard unreachable (${errMsg(e)}); showing the last cached value.` };
      const fixed = id ? SCORECARD_FIXED[id] : undefined;
      if (fixed) return { ...fixed, source: 'fixed_table', note: `College Scorecard unreachable (${errMsg(e)}); using a fixed reference table, not live data.` };
      throw new Error(`College Scorecard lookup failed (${errMsg(e)}) and no offline data for "${q.school_name ?? id}". Offline schools: UT Dallas, UT Austin.`);
    }
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? (e.name === 'TimeoutError' ? 'timed out after 5 s' : e.message) : String(e));

/** Offline implementation for tests and for running with no network at all. */
export class FixedExternalApis implements ExternalApis {
  async fred(seriesId: string): Promise<FredResult> {
    const id = seriesId.toUpperCase();
    const f = FRED_FIXED[id];
    if (!f) throw new Error(`Unknown FRED series ${id}`);
    return { series_id: id, title: f.title, unit: f.unit, latest: { date: FIXED_AS_OF, value: f.value }, source: 'fixed_table', note: 'fixed reference table, not live data' };
  }
  async scorecard(q: { school_name?: string; school_id?: number }): Promise<ScorecardResult> {
    let id = q.school_id;
    if (!id && q.school_name) for (const [re, sid] of SCHOOL_ALIASES) if (re.test(q.school_name)) id = sid;
    const f = id ? SCORECARD_FIXED[id] : undefined;
    if (!f) throw new Error(`No offline data for "${q.school_name ?? id}"`);
    return { ...f, source: 'fixed_table', note: 'fixed reference table, not live data' };
  }
}

export const fredSeries = defineTool({
  name: 'fred_series',
  description:
    'Latest value of a FRED economic series, e.g. MORTGAGE30US (30-year mortgage rate), MORTGAGE15US, DPRIME (bank prime rate), FEDFUNDS, DGS10, TERMCBCCALLNS (credit card APR), TERMCBPER24NS (personal loan rate). The result says whether it is live or a fixed fallback.',
  schema: z.object({ series_id: z.string().describe('FRED series id, e.g. MORTGAGE30US') }),
  describe: (a) => `Looking up FRED series ${a.series_id.toUpperCase()}`,
  run: (a, { external }) => external.fred(a.series_id),
  summarize: (r: FredResult) => `${r.title}: ${r.latest.value}${r.unit === 'percent' ? '%' : ''} on ${r.latest.date} (${r.source.replace('_', ' ')})`,
});

export const collegeScorecard = defineTool({
  name: 'college_scorecard',
  description:
    'U.S. College Scorecard data for a school: cost of attendance, in-state and out-of-state tuition, average net price. Works by name (e.g. "UT Dallas", "UT Austin") or school_id.',
  schema: z.object({ school_name: z.string().optional(), school_id: z.number().int().optional() }),
  describe: (a) => `Looking up College Scorecard for ${a.school_name ?? `school ${a.school_id}`}`,
  run: (a, { external }) => external.scorecard(a),
  summarize: (r: ScorecardResult) =>
    `${r.name}: cost of attendance ${r.cost_of_attendance ? usd(r.cost_of_attendance) : 'n/a'}/yr, net price ${r.avg_net_price ? usd(r.avg_net_price) : 'n/a'} (${r.source.replace('_', ' ')})`,
});

export const externalTools = [fredSeries, collegeScorecard];
export { round2 };
