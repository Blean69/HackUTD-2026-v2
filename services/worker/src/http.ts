// Small HTTP router with open CORS. Core routes: GET /health, POST /asr. Other route modules (e.g. /plaid/*)
// register themselves with router.add(...) / router.addPrefix(...) before the server starts.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { handleAsr, MAX_AUDIO_BYTES, type AsrDeps } from './asr.js';

export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  /** Reads the raw body (capped at `maxBytes`). */
  body(maxBytes?: number): Promise<Buffer>;
}
export interface HttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
export type Handler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

export class Router {
  private exact = new Map<string, Handler>();
  private prefixes: { prefix: string; method: string | '*'; handler: Handler }[] = [];

  add(method: string, path: string, handler: Handler): this {
    this.exact.set(`${method.toUpperCase()} ${path}`, handler);
    return this;
  }
  /** e.g. addPrefix('POST', '/plaid/', handler) handles everything under /plaid/. */
  addPrefix(method: string | '*', prefix: string, handler: Handler): this {
    this.prefixes.push({ prefix, method: method === '*' ? '*' : method.toUpperCase(), handler });
    return this;
  }
  find(method: string, path: string): Handler | undefined {
    return this.exact.get(`${method} ${path}`) ?? this.prefixes.find((p) => path.startsWith(p.prefix) && (p.method === '*' || p.method === method))?.handler;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '600',
};

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createHttpServer(router: Router): Server {
  return createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
        const isBuf = Buffer.isBuffer(body);
        const payload = isBuf ? body : typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(status, { ...CORS, 'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', ...extra });
        res.end(payload);
      };
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = (req.method ?? 'GET').toUpperCase();
        if (method === 'OPTIONS') return send(204, '');
        const handler = router.find(method, url.pathname);
        if (!handler) return send(404, { error: 'not_found' });
        const out = await handler({ method, path: url.pathname, query: url.searchParams, headers: req.headers, body: (max = 1024 * 1024) => readBody(req, max) });
        send(out.status, out.body, out.headers);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        send(status, { error: status === 413 ? 'too_large' : 'internal_error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}

export interface HealthSource {
  health(): Record<string, unknown>;
}

/** Register the core routes. */
export function registerCoreRoutes(router: Router, health: HealthSource, asr: () => AsrDeps): void {
  router.add('GET', '/health', () => ({ status: 200, body: health.health() }));
  router.add('POST', '/asr', async (req) => {
    const body = await req.body(MAX_AUDIO_BYTES + 1024);
    const r = await handleAsr({ huddleId: req.query.get('huddle_id') ?? '', speaker: req.query.get('speaker') ?? '', body, contentType: String(req.headers['content-type'] ?? '') }, asr());
    return { status: r.status, body: r.body };
  });
}
