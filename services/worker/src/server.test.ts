import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleAsr, extensionFor, textFromAsrResponse } from './asr.js';
import { loadConfig } from './config.js';
import { createHttpServer, registerCoreRoutes, Router } from './http.js';
import { batches } from './seed.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const cfgWithKey = { apiKey: 'nvapi-test', functionId: '1598d209-5e27-4d3c-8079-4751568b1081', timeoutMs: 5000 };

function makeWav(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'ks-wav-'));
  const out = join(dir, 'tone.webm');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'libopus', out]);
  return readFileSync(out);
}

describe('ASR', () => {
  it('503 asr_unavailable without an API key (browser falls back to Web Speech)', async () => {
    const r = await handleAsr({ huddleId: 'h', speaker: 'Ana', body: Buffer.from('x'), contentType: 'audio/webm' }, { cfg: { ...cfgWithKey, apiKey: '' }, appendTranscript: vi.fn() });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('asr_unavailable');
  });
  it('503 when ffmpeg is missing', async () => {
    const r = await handleAsr({ huddleId: 'h', speaker: 'Ana', body: Buffer.from('x'), contentType: 'audio/webm' }, { cfg: cfgWithKey, appendTranscript: vi.fn(), ffmpeg: '/nonexistent/ffmpeg' });
    expect(r.status).toBe(503);
    expect(String(r.body.reason)).toMatch(/ffmpeg/);
  });
  it('400 on missing params, 413 on huge chunks', async () => {
    expect((await handleAsr({ huddleId: '', speaker: 'a', body: Buffer.from('x'), contentType: '' }, { cfg: cfgWithKey, appendTranscript: vi.fn() })).status).toBe(400);
    expect((await handleAsr({ huddleId: 'h', speaker: 'a', body: Buffer.alloc(11 * 1024 * 1024), contentType: '' }, { cfg: cfgWithKey, appendTranscript: vi.fn() })).status).toBe(413);
  });
  it('helpers', () => {
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionFor('audio/ogg')).toBe('ogg');
    expect(extensionFor('audio/wav')).toBe('wav');
    expect(textFromAsrResponse({ text: 'hello there' })).toBe('hello there');
    expect(textFromAsrResponse({ results: [{ alternatives: [{ transcript: 'a' }] }, { alternatives: [{ transcript: 'b' }] }] })).toBe('a b');
  });
  (hasFfmpeg ? it : it.skip)('converts with real ffmpeg, calls the NVCF HTTP route with a bearer token and appends the transcript', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    let url = '';
    let auth = '';
    let bytes = 0;
    const fakeFetch = vi.fn(async (u: unknown, init?: RequestInit) => {
      url = String(u);
      auth = String((init!.headers as Record<string, string>).Authorization);
      const file = (init!.body as FormData).get('file') as Blob;
      bytes = file.size;
      return new Response(JSON.stringify({ text: 'we want to open a second bakery' }), { status: 200 });
    });
    const r = await handleAsr({ huddleId: 'hud_1', speaker: 'Marisol', body: makeWav(), contentType: 'audio/webm' }, { cfg: cfgWithKey, appendTranscript: append, fetch: fakeFetch as never });
    expect(r).toEqual({ status: 200, body: { text: 'we want to open a second bakery', appended: true } });
    expect(url).toBe('https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions');
    expect(auth).toBe('Bearer nvapi-test');
    expect(bytes).toBeGreaterThan(10_000); // 0.5 s of 16 kHz mono s16 PCM is ~16 KB: ffmpeg really converted it
    expect(append).toHaveBeenCalledWith('hud_1', 'Marisol', 'we want to open a second bakery');
  });
  (hasFfmpeg ? it : it.skip)('503 when the NVIDIA call fails', async () => {
    const r = await handleAsr({ huddleId: 'h', speaker: 'a', body: makeWav(), contentType: 'audio/webm' }, { cfg: cfgWithKey, appendTranscript: vi.fn(), fetch: vi.fn(async () => new Response('nope', { status: 401 })) as never });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('asr_unavailable');
  });
});

describe('config', () => {
  it('uses the Parakeet CTC function for the HTTP route when the env points at the gRPC-only streaming model', () => {
    expect(loadConfig({ NVIDIA_ASR_FUNCTION_ID: 'bb0837de-8c7b-481f-9ec8-ef5663e9c1fa' }).asr.functionId).toBe('1598d209-5e27-4d3c-8079-4751568b1081');
    expect(loadConfig({ NVIDIA_ASR_FUNCTION_ID: 'bb0837de-8c7b-481f-9ec8-ef5663e9c1fa', NVIDIA_ASR_HTTP_FUNCTION_ID: 'abc' }).asr.functionId).toBe('abc');
  });
  it('defaults match .env.example', () => {
    const c = loadConfig({});
    expect(c.demoMode).toBe('cache_first');
    expect(c.port).toBe(8787);
    expect(c.providers[0]!.agentModel).toBe('nvidia/nemotron-3-super-120b-a12b');
    expect(c.providers[0]!.rpm).toBeLessThanOrEqual(40);
    expect(c.dataGovApiKey).toBe('DEMO_KEY');
  });
});

describe('HTTP server', () => {
  const router = new Router();
  let base = '';
  let close: () => void = () => undefined;
  beforeAll(async () => {
    registerCoreRoutes(router, { health: () => ({ ok: true, nvidia: 'not_configured', spacetime: 'connected' }) }, () => ({ cfg: { ...cfgWithKey, apiKey: '' }, appendTranscript: vi.fn() }));
    router.addPrefix('POST', '/plaid/', () => ({ status: 200, body: { plaid: 'hook works' } }));
    const server = createHttpServer(router);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it('GET /health with open CORS', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(await r.json()).toMatchObject({ ok: true, spacetime: 'connected' });
  });
  it('OPTIONS preflight, 404, and POST /asr -> 503 asr_unavailable', async () => {
    const pre = await fetch(`${base}/asr?huddle_id=h&speaker=a`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3001', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toMatch(/POST/);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const asr = await fetch(`${base}/asr?huddle_id=hud_1&speaker=Ana`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([1, 2, 3]) });
    expect(asr.status).toBe(503);
    expect(await asr.json()).toMatchObject({ error: 'asr_unavailable' });
  });
  it('extra route modules can register under a prefix (hook for /plaid/*)', async () => {
    const r = await fetch(`${base}/plaid/link-token`, { method: 'POST' });
    expect(await r.json()).toEqual({ plaid: 'hook works' });
  });
});

describe('seed batching', () => {
  it('keeps every reducer call well under 1 MB and loses no rows', () => {
    const rows = Array.from({ length: 5000 }, (_v, i) => ({ id: `txn_${i}`, merchant: 'x'.repeat(100), description: 'y'.repeat(100), amount: -i }));
    const parts = batches(rows);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat()).toHaveLength(rows.length);
    for (const p of parts) expect(JSON.stringify(p).length).toBeLessThan(500_000);
  });
});
