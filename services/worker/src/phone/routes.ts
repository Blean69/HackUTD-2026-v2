// /phone/* HTTP routes (internal: the voice service calls them with the x-voice-secret header; Caddy answers 404 for
// /worker/phone/* from outside). Registered on the shared router when this module is imported (phone/index.ts).
//   POST /phone/identify {call_id, caller_hash, pin}              -> {ok, household_id, member_id, first_name, ...} | {ok:false, tries_left, locked}
//   POST /phone/start    {call_id, household_id, member_id?, ...} -> {run_id, brief[], family, ...}
//   GET  /phone/tools                                             -> [{name, description, parameters}]
//   POST /phone/tool     {run_id, name, args}                     -> {ok, result (voiceView), summary, ms}
//   POST /phone/trace    {run_id, events[]}                       -> {ok, accepted, dropped}
//   POST /phone/end      {run_id, reason, stats}                  -> {ok, turns, tool_calls, p50_ms, p95_ms}
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Handler, HttpRequest, HttpResponse, Router } from '../http.js';
import { router as sharedRouter } from '../router.js';
import { loadPhoneConfig, type PhoneConfig } from './config.js';
import { PhoneError, type PhoneService, type StartRequest, type TraceItem } from './session.js';

const json = (status: number, body: unknown): HttpResponse => ({ status, body });
const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

export interface PhoneRuntime {
  cfg: PhoneConfig;
  /** null until SpacetimeDB is connected and attachPhone ran. */
  service: PhoneService | null;
}

async function readJson(req: HttpRequest, max = 64 * 1024): Promise<Record<string, unknown>> {
  const raw = (await req.body(max)).toString('utf8').trim();
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new PhoneError(400, 'bad_request', 'body must be JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PhoneError(400, 'bad_request', 'body must be a JSON object');
  return v as Record<string, unknown>;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function registerPhoneRoutes(router: Router, getRuntime: () => PhoneRuntime): void {
  const guarded =
    (fn: (svc: PhoneService, req: HttpRequest, rt: PhoneRuntime) => Promise<HttpResponse> | HttpResponse): Handler =>
    async (req) => {
      const rt = getRuntime();
      if (!rt.cfg.enabled) return json(503, { error: 'voice_disabled', detail: 'VOICE_ENABLED=0' });
      if (!rt.cfg.secret) return json(503, { error: 'voice_unconfigured', detail: 'set VOICE_SHARED_SECRET on the worker' });
      const given = req.headers['x-voice-secret'];
      const secret = Array.isArray(given) ? (given[0] ?? '') : (given ?? '');
      if (!timingSafeEqual(sha(secret), sha(rt.cfg.secret))) return json(401, { error: 'unauthorized' });
      if (!rt.service) return json(503, { error: 'spacetime_unavailable', detail: 'the worker is not connected to SpacetimeDB yet' });
      try {
        return await fn(rt.service, req, rt);
      } catch (e) {
        if (e instanceof PhoneError) return json(e.status, { error: e.code, detail: e.message });
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[phone] ${req.method} ${req.path} failed: ${msg}`);
        return json(500, { error: 'internal_error', detail: msg });
      }
    };

  router.add(
    'POST',
    '/phone/identify',
    guarded(async (svc, req) => {
      const b = await readJson(req);
      return json(200, await svc.identify({ call_id: str(b.call_id), caller_hash: str(b.caller_hash), pin: str(b.pin) }));
    }),
  );
  router.add(
    'POST',
    '/phone/start',
    guarded(async (svc, req) => {
      const b = await readJson(req);
      const llm = b.llm && typeof b.llm === 'object' ? (b.llm as { provider?: string; model?: string }) : undefined;
      const r: StartRequest = { call_id: str(b.call_id), household_id: str(b.household_id), member_id: str(b.member_id), first_name: str(b.first_name), display_name: str(b.display_name), transport: str(b.transport), caller: str(b.caller), ...(llm ? { llm } : {}) };
      return json(200, await svc.start(r));
    }),
  );
  router.add(
    'GET',
    '/phone/tools',
    guarded((svc) => json(200, svc.tools())),
  );
  router.add(
    'POST',
    '/phone/tool',
    guarded(async (svc, req) => {
      const b = await readJson(req);
      return json(200, await svc.tool({ run_id: str(b.run_id), name: str(b.name), args: b.args }));
    }),
  );
  router.add(
    'POST',
    '/phone/trace',
    guarded(async (svc, req) => {
      const b = await readJson(req, 256 * 1024);
      return json(200, svc.trace({ run_id: str(b.run_id), events: Array.isArray(b.events) ? (b.events as TraceItem[]) : [] }));
    }),
  );
  router.add(
    'POST',
    '/phone/end',
    guarded(async (svc, req) => {
      const b = await readJson(req);
      return json(200, await svc.end({ run_id: str(b.run_id), reason: str(b.reason), ...(b.stats && typeof b.stats === 'object' ? { stats: b.stats as Record<string, unknown> } : {}) }));
    }),
  );
}

// ---- the process-wide wiring (like plaid/runtime.ts): config from env now, the service once SpacetimeDB is connected ------
let runtime: PhoneRuntime | null = null;
export function getPhoneRuntime(): PhoneRuntime {
  runtime ??= { cfg: loadPhoneConfig(), service: null };
  return runtime;
}
/** Tests (and attachPhone) replace parts of the runtime. */
export function setPhoneRuntime(parts: Partial<PhoneRuntime>): void {
  runtime = { ...getPhoneRuntime(), ...parts };
}
export function resetPhoneRuntime(): void {
  runtime?.service?.stopReaper();
  runtime = null;
}

registerPhoneRoutes(sharedRouter, getPhoneRuntime);
