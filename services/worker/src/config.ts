// Environment -> typed config. `loadEnv()` reads the repo-root .env (and ./.env) without overriding real env vars.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(): void {
  for (const p of [resolve(PKG_ROOT, '../../.env'), resolve(PKG_ROOT, '.env')]) {
    if (existsSync(p)) {
      try {
        process.loadEnvFile(p); // Node >= 21.7; does not override variables that are already set
      } catch (e) {
        console.warn(`[config] could not read ${p}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

export type ProviderId = 'nvidia' | 'tenvor_nemotron' | 'tenvor_qwen' | 'local';
export const REMOTE_PROVIDERS = ['nvidia', 'tenvor_nemotron', 'tenvor_qwen'] as const;

export interface ProviderConfig {
  id: Exclude<ProviderId, 'local'>;
  baseUrl: string;
  apiKey: string;
  /** Model for planning + tool use. */
  agentModel: string;
  /** Model for extraction + classification. */
  fastModel: string;
  /** Requests per minute this provider allows (0 = unlimited). */
  rpm: number;
  enabled: boolean;
}

export interface Config {
  providerOrder: ProviderId[];
  providers: ProviderConfig[];
  /** Always append the keyless local provider as the last resort (default true). */
  localFallback: boolean;
  llmTimeoutMs: number;
  llmRetriesPerProvider: number;
  /** On HTTP 429, keep waiting/backing off on the same provider for up to this long before failing over. */
  rateLimitWaitMs: number;
  llmConcurrency: number;
  demoMode: 'cache_first' | 'live';
  port: number;
  dataDir: string;
  cacheDir: string;
  spacetime: { uri: string; db: string; workerSecret: string; tokenFile: string };
  fredApiKey: string;
  dataGovApiKey: string;
  asr: { apiKey: string; functionId: string; timeoutMs: number };
  maxAgentSteps: number;
  /** Turn Nemotron reasoning on for planning and tool-loop steps (surfaced as `thought` events). */
  agentThinking: boolean;
  workerLabel: string;
}

/** nemotron-asr-streaming (the .env.example default) is gRPC-only; the documented HTTP route belongs to Parakeet CTC. */
const NEMOTRON_ASR_STREAMING_FN = 'bb0837de-8c7b-481f-9ec8-ef5663e9c1fa';
export const PARAKEET_CTC_FN = '1598d209-5e27-4d3c-8079-4751568b1081';
function asrHttpFunctionId(env: NodeJS.ProcessEnv): string {
  const explicit = (env.NVIDIA_ASR_HTTP_FUNCTION_ID ?? '').trim();
  if (explicit) return explicit;
  const fn = (env.NVIDIA_ASR_FUNCTION_ID ?? '').trim();
  return !fn || fn === NEMOTRON_ASR_STREAMING_FN ? PARAKEET_CTC_FN : fn;
}

const num = (v: string | undefined, d: number): number => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v: string | undefined, d = ''): string => (v === undefined || v.trim() === '' ? d : v.trim());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const order = str(env.LLM_PROVIDER_ORDER, 'nvidia,tenvor_qwen')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ProviderId => ['nvidia', 'tenvor_nemotron', 'tenvor_qwen', 'local'].includes(s));

  const nvKey = str(env.NVIDIA_API_KEY);
  const tvKey = str(env.TENVOR_API_KEY);
  // An absent TENVOR_BASE_URL falls back to the documented placeholder; an EMPTY one means "not configured".
  const tvBase = env.TENVOR_BASE_URL === undefined ? 'https://api.tenvor.io/v1' : env.TENVOR_BASE_URL.trim();
  const nvBase = env.NVIDIA_BASE_URL === undefined ? 'https://integrate.api.nvidia.com/v1' : env.NVIDIA_BASE_URL.trim();
  const nemotron = str(env.NEMOTRON_MODEL, 'nvidia/nemotron-3-ultra-550b-a55b');
  const fast = str(env.NEMOTRON_FAST_MODEL, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  const tvNemotron = str(env.TENVOR_NEMOTRON_MODEL);
  const tvQwen = str(env.TENVOR_QWEN_MODEL);

  const providers: ProviderConfig[] = [
    {
      id: 'nvidia',
      baseUrl: nvBase,
      apiKey: nvKey,
      agentModel: nemotron,
      fastModel: fast,
      rpm: num(env.NVIDIA_RPM, 36), // free tier is ~40/min; leave headroom
      enabled: nvKey !== '' && nvBase !== '' && nemotron !== '',
    },
    {
      id: 'tenvor_nemotron',
      baseUrl: tvBase,
      apiKey: tvKey,
      agentModel: tvNemotron,
      fastModel: tvNemotron,
      rpm: num(env.TENVOR_RPM, 0),
      enabled: tvKey !== '' && tvBase !== '' && tvNemotron !== '',
    },
    {
      id: 'tenvor_qwen',
      baseUrl: tvBase,
      apiKey: tvKey,
      agentModel: tvQwen,
      fastModel: tvQwen,
      rpm: num(env.TENVOR_RPM, 0),
      enabled: tvKey !== '' && tvBase !== '' && tvQwen !== '',
    },
  ];

  const demo = str(env.DEMO_MODE, 'cache_first');
  return {
    providerOrder: order.length ? order : ['nvidia', 'tenvor_qwen'],
    providers,
    localFallback: str(env.LLM_LOCAL_FALLBACK, '1') !== '0',
    llmTimeoutMs: num(env.LLM_TIMEOUT_MS, 60_000),
    llmRetriesPerProvider: Math.max(0, Math.floor(num(env.LLM_RETRIES, 1))),
    rateLimitWaitMs: Math.max(0, num(env.LLM_429_WAIT_MS, 3000)),
    llmConcurrency: Math.max(1, Math.floor(num(env.LLM_CONCURRENCY, 4))),
    demoMode: demo === 'live' ? 'live' : 'cache_first',
    port: num(env.WORKER_PORT, 8787),
    dataDir: resolve(PKG_ROOT, str(env.DATA_DIR, '../../data/seed')),
    cacheDir: resolve(PKG_ROOT, str(env.WORKER_CACHE_DIR, '.cache')),
    spacetime: {
      uri: str(env.SPACETIME_URI, 'ws://localhost:3000'),
      db: str(env.SPACETIME_DB, 'keystone'),
      workerSecret: str(env.WORKER_SECRET, 'keystone-dev-secret'),
      tokenFile: resolve(PKG_ROOT, str(env.WORKER_TOKEN_FILE, '.worker-token')),
    },
    fredApiKey: str(env.FRED_API_KEY),
    dataGovApiKey: str(env.DATA_GOV_API_KEY, 'DEMO_KEY'),
    asr: {
      apiKey: nvKey,
      functionId: asrHttpFunctionId(env),
      timeoutMs: num(env.ASR_TIMEOUT_MS, 20_000),
    },
    maxAgentSteps: Math.max(1, Math.floor(num(env.AGENT_MAX_STEPS, 6))),
    agentThinking: str(env.AGENT_THINKING, '1') !== '0',
    workerLabel: str(env.WORKER_LABEL, 'keystone-worker'),
  };
}
