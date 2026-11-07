// POST /plaid/link_token, /plaid/exchange, /plaid/sandbox_connect (docs/contracts.md sections 5 and 7) on the shared router.
// exchange and sandbox_connect accept `select: true` (onboarding): they list the bank's accounts as bank_account_option rows and
// stop at bank_connection "selecting"; select_bank_accounts then queues the sync of just the chosen accounts.
// Registered when this module is imported (src/plaid/index.ts). Without PLAID_CLIENT_ID / PLAID_SECRET every route
// answers 503 {"error":"plaid_unconfigured"}. Access tokens are never returned.
import type { Handler, HttpRequest, HttpResponse, Router } from '../http.js';
import { router as sharedRouter } from '../router.js';
import { linkItem, sandboxConnect } from './connect.js';
import { loadSandboxUserJson } from './custom_user.js';
import { getPlaidRuntime, type ConfiguredRuntime, type PlaidRuntime } from './runtime.js';
import { PlaidApiError } from './types.js';

const json = (status: number, body: unknown): HttpResponse => ({ status, body });
const UNCONFIGURED = (): HttpResponse => json(503, { error: 'plaid_unconfigured', detail: 'Set PLAID_CLIENT_ID and PLAID_SECRET (Plaid Sandbox keys) in .env' });

async function readJson(req: HttpRequest): Promise<{ body: Record<string, unknown> } | { res: HttpResponse }> {
  const raw = (await req.body(64 * 1024)).toString('utf8').trim();
  if (!raw) return { body: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { body: v as Record<string, unknown> };
  } catch {
    /* fall through */
  }
  return { res: json(400, { error: 'bad_request', detail: 'body must be a JSON object' }) };
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function plaidFailure(e: unknown): HttpResponse {
  if (e instanceof PlaidApiError) {
    const clientError = e.type === 'INVALID_REQUEST' || e.type === 'INVALID_INPUT';
    return json(clientError ? 400 : 502, { error: 'plaid_error', code: e.code, type: e.type, detail: e.message, ...(e.requestId ? { request_id: e.requestId } : {}) });
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/unknown household/i.test(msg)) return json(404, { error: 'unknown_household', detail: msg });
  return json(500, { error: 'internal_error', detail: msg });
}

/** Common prologue: configured? JSON body? household_id present (and, when `needStore`, a real household)? */
function guarded(needStore: boolean, handler: (req: HttpRequest, rt: ConfiguredRuntime, body: Record<string, unknown>, householdId: string) => Promise<HttpResponse>, getRt: () => PlaidRuntime): Handler {
  return async (req) => {
    const rt = getRt();
    if (!rt.config || !rt.client) return UNCONFIGURED();
    const parsed = await readJson(req);
    if ('res' in parsed) return parsed.res;
    const body = parsed.body;
    const householdId = str(body.household_id);
    if (!householdId) return json(400, { error: 'household_id_required' });
    if (needStore) {
      if (!rt.store) return json(503, { error: 'spacetime_unavailable', detail: 'the worker is not connected to SpacetimeDB yet' });
      if (!(await rt.store.householdExists(householdId).catch(() => false))) return json(404, { error: 'unknown_household', detail: `no household "${householdId}"` });
    }
    try {
      return await handler(req, rt as ConfiguredRuntime, body, householdId);
    } catch (e) {
      return plaidFailure(e);
    }
  };
}

export function registerPlaidRoutes(router: Router = sharedRouter, getRt: () => PlaidRuntime = getPlaidRuntime, getCustomUser: () => string | null = () => loadSandboxUserJson()): void {
  router.add(
    'POST',
    '/plaid/link_token',
    guarded(
      false,
      async (_req, rt, _body, householdId) => {
        const r = await rt.client.linkTokenCreate({ client_user_id: householdId, products: rt.config.products, country_codes: rt.config.countryCodes });
        return json(200, { link_token: r.link_token, ...(r.expiration ? { expiration: r.expiration } : {}) });
      },
      getRt,
    ),
  );

  router.add(
    'POST',
    '/plaid/exchange',
    guarded(
      true,
      async (_req, rt, body, householdId) => {
        const publicToken = str(body.public_token);
        if (!publicToken) return json(400, { error: 'public_token_required' });
        const select = body.select === true;
        const linked = await linkItem(rt.client, rt.store!, { householdId, publicToken, select });
        return json(200, { ok: true, status: select ? 'selecting' : 'linking', ...linked });
      },
      getRt,
    ),
  );

  router.add(
    'POST',
    '/plaid/sandbox_connect',
    guarded(
      true,
      async (_req, rt, body, householdId) => {
        if (rt.config.env !== 'sandbox') return json(400, { error: 'sandbox_only', detail: `PLAID_ENV is "${rt.config.env}"; sandbox_connect only works against the Plaid Sandbox` });
        const username = str(body.username);
        const institutionId = str(body.institution_id);
        const select = body.select === true;
        const customUser = username ? null : getCustomUser();
        const r = await sandboxConnect({ client: rt.client, store: rt.store!, config: rt.config }, { householdId, ...(username ? { username } : {}), ...(institutionId ? { institutionId } : {}), forceNew: body.new_item === true, select, customUser });
        return json(200, { ok: true, status: select ? 'selecting' : r.reused ? 'syncing' : 'linking', ...r });
      },
      getRt,
    ),
  );

  router.add('GET', '/plaid/status', () => {
    const rt = getRt();
    return json(200, { configured: Boolean(rt.config && rt.client), env: rt.config?.env ?? null, products: rt.config?.products ?? [], spacetime: Boolean(rt.store) });
  });
}

registerPlaidRoutes();
