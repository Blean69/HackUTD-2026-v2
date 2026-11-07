import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealExternalApis } from './external.js';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ks-ext-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('FRED', () => {
  it('without a key uses the fixed table and says so', async () => {
    const f = vi.fn();
    const api = new RealExternalApis({ fredApiKey: '', dataGovApiKey: 'DEMO_KEY', cacheDir: dir, fetch: f as never });
    const r = await api.fred('mortgage30us');
    expect(r.source).toBe('fixed_table');
    expect(r.note).toMatch(/not live/);
    expect(f).not.toHaveBeenCalled();
  });
  it('with a key parses observations, caches them, and falls back to the cache when FRED fails', async () => {
    const ok = vi.fn().mockResolvedValue(json({ observations: [{ date: '2026-11-05', value: '6.31' }, { date: '2026-10-29', value: '6.25' }] }));
    let now = 1_000_000;
    const api = new RealExternalApis({ fredApiKey: 'k', dataGovApiKey: 'DEMO_KEY', cacheDir: dir, fetch: ok as never, now: () => now, fredTtlMs: 1000 });
    const live = await api.fred('MORTGAGE30US');
    expect(live).toMatchObject({ source: 'fred_live', latest: { date: '2026-11-05', value: 6.31 }, previous: { value: 6.25 } });
    expect(String(ok.mock.calls[0]![0])).toContain('series_id=MORTGAGE30US');
    expect(await readdir(dir)).toContain('fred_MORTGAGE30US.json');
    now += 5000; // TTL expired, FRED now down
    const down = new RealExternalApis({ fredApiKey: 'k', dataGovApiKey: 'DEMO_KEY', cacheDir: dir, fetch: vi.fn().mockRejectedValue(new Error('boom')) as never, now: () => now, fredTtlMs: 1000 });
    const cached = await down.fred('MORTGAGE30US');
    expect(cached.source).toBe('fred_cache');
    expect(cached.latest.value).toBe(6.31);
  });
});

describe('College Scorecard', () => {
  const body = { results: [{ id: 228787, 'school.name': 'The University of Texas at Dallas', 'school.city': 'Richardson', 'school.state': 'TX', 'latest.cost.attendance.academic_year': 29648, 'latest.cost.tuition.in_state': 14664, 'latest.cost.tuition.out_of_state': 40164, 'latest.cost.avg_net_price.overall': 15271, 'latest.admissions.admission_rate.overall': 0.65, 'latest.student.size': 21751 }] };
  it('resolves UT Dallas by alias, hits the API once, then serves from the disk cache', async () => {
    const f = vi.fn().mockResolvedValue(json(body));
    const api = new RealExternalApis({ fredApiKey: '', dataGovApiKey: 'DEMO_KEY', cacheDir: dir, fetch: f as never });
    const a = await api.scorecard({ school_name: 'UT Dallas' });
    expect(a).toMatchObject({ source: 'scorecard_live', school_id: 228787, cost_of_attendance: 29648 });
    expect(String(f.mock.calls[0]![0])).toContain('id=228787');
    expect(String(f.mock.calls[0]![0])).toContain('api_key=DEMO_KEY');
    const b = await api.scorecard({ school_name: 'UT Dallas' });
    expect(b.source).toBe('scorecard_cache');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('falls back to the fixed table when the API is down and nothing is cached', async () => {
    const api = new RealExternalApis({ fredApiKey: '', dataGovApiKey: 'DEMO_KEY', cacheDir: dir, fetch: vi.fn().mockResolvedValue(json({}, 429)) as never });
    const r = await api.scorecard({ school_name: 'UT Austin' });
    expect(r.source).toBe('fixed_table');
    expect(r.note).toMatch(/not live/);
  });
  it('an unknown school with no data fails loudly', async () => {
    const api = new RealExternalApis({ fredApiKey: '', dataGovApiKey: 'DEMO_KEY', cacheDir: dir, fetch: vi.fn().mockRejectedValue(new Error('offline')) as never });
    await expect(api.scorecard({ school_name: 'Nowhere College' })).rejects.toThrow(/no offline data/);
  });
});
