// Process-wide Plaid wiring: the config + client (built lazily from env, after index.ts has loaded .env) and the store
// (set once SpacetimeDB is connected). The routes and the plaid_sync workflow both read it; tests replace the parts.
import type { DbConnection } from '../module_bindings/index.js';
import { sleep } from '../util.js';
import { createPlaidClient } from './client.js';
import { loadPlaidConfig } from './config.js';
import { SpacetimePlaidStore, type PlaidStore } from './store.js';
import type { PlaidClient, PlaidConfig } from './types.js';

export interface PlaidRuntime {
  /** null when PLAID_CLIENT_ID / PLAID_SECRET are not set. */
  config: PlaidConfig | null;
  client: PlaidClient | null;
  /** null until SpacetimeDB is connected. */
  store: PlaidStore | null;
  sleep(ms: number): Promise<void>;
  /** Fresh-item polling for historical transactions: attempts x interval. */
  pollAttempts: number;
  pollMs: number;
}

const int = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};

/** A runtime where Plaid is configured. */
export interface ConfiguredRuntime extends PlaidRuntime {
  config: PlaidConfig;
  client: PlaidClient;
}

let current: PlaidRuntime | null = null;
let override: Partial<PlaidRuntime> = {};

function build(): PlaidRuntime {
  const config = loadPlaidConfig();
  let client: PlaidClient | null = null;
  if (config) {
    try {
      client = createPlaidClient(config);
    } catch (e) {
      console.warn(`[plaid] not usable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { config, client, store: null, sleep, pollAttempts: int(process.env.PLAID_POLL_ATTEMPTS, 10), pollMs: int(process.env.PLAID_POLL_MS, 3000) };
}

export function getPlaidRuntime(): PlaidRuntime {
  current ??= build();
  return { ...current, ...override };
}

/** Tests (and attachPlaid) set parts of the runtime; `undefined` clears nothing, pass `null` to clear. */
export function setPlaidRuntime(parts: Partial<PlaidRuntime>): void {
  override = { ...override, ...parts };
}
export function resetPlaidRuntime(): void {
  current = null;
  override = {};
}

/** Wire the Plaid code to a connected, registered worker: stores tokens/cursors/accounts/txns through reducers. */
export async function attachPlaid(conn: DbConnection): Promise<void> {
  const store = new SpacetimePlaidStore(conn);
  setPlaidRuntime({ store });
  try {
    await store.attach();
    const rt = getPlaidRuntime();
    console.log(`[plaid] ${rt.client ? `ready (${rt.config?.env}, products ${rt.config?.products.join(',')})` : 'not configured (PLAID_CLIENT_ID / PLAID_SECRET missing): /plaid/* answers 503 plaid_unconfigured'}`);
  } catch (e) {
    console.warn(`[plaid] token view subscription failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
