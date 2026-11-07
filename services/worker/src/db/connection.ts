// SpacetimeDB client connection for the worker: persisted identity token, automatic reconnect, worker registration.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Config } from '../config.js';
import { DbConnection } from '../module_bindings/index.js';

export interface Connected {
  conn: DbConnection;
  identity: string;
}

function readToken(file: string): string | undefined {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function open(cfg: Config['spacetime'], token: string | undefined, onStatus: (s: string) => void): Promise<Connected> {
  return new Promise<Connected>((resolve, reject) => {
    let settled = false;
    const builder = DbConnection.builder()
      .withUri(cfg.uri)
      .withDatabaseName(cfg.db)
      .withAutomaticReconnect()
      .onConnect((conn, identity, tok) => {
        try {
          writeFileSync(cfg.tokenFile, tok, { mode: 0o600 });
        } catch {
          /* token persistence is best effort */
        }
        settled = true;
        onStatus('connected');
        resolve({ conn, identity: identity.toHexString() });
      })
      .onAutomaticReconnect(() => onStatus('connected'))
      .onConnectError((_ctx, err) => {
        onStatus('error');
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .onDisconnect((_ctx, err, attempt) => onStatus(attempt === undefined ? `disconnected${err ? `: ${String(err)}` : ''}` : `reconnecting (attempt ${attempt})`));
    if (token) builder.withToken(token);
    builder.build();
  });
}

/** Connect (reusing the saved identity token), retrying once without a stale token, then register as a worker. */
export async function connectWorker(cfg: Config, onStatus: (s: string) => void = () => undefined): Promise<Connected> {
  const sp = cfg.spacetime;
  let connected: Connected;
  const token = readToken(sp.tokenFile);
  try {
    connected = await open(sp, token, onStatus);
  } catch (e) {
    if (!token) throw e;
    try {
      rmSync(sp.tokenFile, { force: true });
    } catch {
      /* ignore */
    }
    connected = await open(sp, undefined, onStatus);
  }
  await connected.conn.reducers.registerWorker({ secret: sp.workerSecret, label: cfg.workerLabel });
  return connected;
}

/** Subscribe and resolve when the initial rows are in the client cache. */
export function subscribeAndWait(conn: DbConnection, queries: string[], timeoutMs = 15_000): Promise<{ unsubscribe(): void }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`subscription timed out: ${queries[0]}`)), timeoutMs);
    const handle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        clearTimeout(timer);
        resolve({ unsubscribe: () => handle.unsubscribe() });
      })
      .onError((ctx) => {
        clearTimeout(timer);
        const ev = (ctx as { event?: unknown }).event;
        reject(new Error(`subscription failed: ${queries.join(' | ')} ${ev instanceof Error ? ev.message : String(ev ?? '')}`));
      })
      .subscribe(queries);
  });
}
