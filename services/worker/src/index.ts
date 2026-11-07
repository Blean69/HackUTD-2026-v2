// Keystone agent worker: connects to SpacetimeDB, claims queued agent jobs, runs Nemotron workflows, serves /health and /asr.
import { runJob, type RunnerDeps } from './agent/runner.js';
import { SpacetimeSink } from './db/sink.js';
import { buildLLMClient } from './llm/client.js';
import { loadConfig, loadEnv } from './config.js';
import { connectWorker, subscribeAndWait } from './db/connection.js';
import { HouseholdLoader } from './db/household.js';
import { SpacetimeHistory } from './db/history.js';
import { createHttpServer, registerCoreRoutes } from './http.js';
import { router } from './router.js';
import { attachPlaid } from './plaid/index.js'; // also registers the /plaid/* routes
import { attachPhone } from './phone/index.js'; // also registers the internal /phone/* routes (voice service)
import { JobQueue, parseJobInput } from './jobs.js';
import { RealExternalApis } from './tools/external.js';
import { buildRegistry } from './tools/index.js';
import { getWorkflow, workflowNames } from './workflows/index.js';
import type { DbConnection } from './module_bindings/index.js';
import { sleep } from './util.js';

loadEnv();
const cfg = loadConfig();
const llm = buildLLMClient(cfg);
const registry = buildRegistry();
const external = new RealExternalApis({ fredApiKey: cfg.fredApiKey, dataGovApiKey: cfg.dataGovApiKey, cacheDir: cfg.cacheDir });

const state: { conn: DbConnection | null; spacetime: string; identity: string; jobsRun: number; startedAt: number } = { conn: null, spacetime: 'connecting', identity: '', jobsRun: 0, startedAt: Date.now() };

// ---- HTTP (starts first so /health works even while SpacetimeDB is down) ------------------------------------------
registerCoreRoutes(
  router,
  {
    health: () => {
      const st = llm.status();
      const pick = (id: string): string => {
        const s = st.find((p) => p.provider === id);
        const configured = cfg.providers.find((p) => p.id === id)?.enabled;
        if (!configured || !s) return 'not_configured';
        return s.state === 'cooling_down' ? `cooling_down (${s.last_error})` : s.failed > s.ok && s.failed > 0 ? `degraded (${s.last_error})` : 'ok';
      };
      return {
        ok: true,
        nvidia: pick('nvidia'),
        brev: pick('brev'),
        tenvor_nemotron: pick('tenvor_nemotron'),
        tenvor_qwen: pick('tenvor_qwen'),
        local: 'always_available',
        spacetime: state.spacetime,
        identity: state.identity,
        provider_order: llm.providers.map((p) => p.id),
        models: { agent: cfg.providers[0]!.agentModel, fast: cfg.providers[0]!.fastModel },
        demo_mode: cfg.demoMode,
        workflows: workflowNames(),
        tools: registry.names(),
        asr: { configured: Boolean(cfg.asr.apiKey), function_id: cfg.asr.functionId },
        jobs_run: state.jobsRun,
        uptime_s: Math.round((Date.now() - state.startedAt) / 1000),
      };
    },
  },
  () => ({
    cfg: cfg.asr,
    appendTranscript: async (huddleId, speaker, text) => {
      if (!state.conn) throw new Error('SpacetimeDB is not connected');
      await state.conn.reducers.appendTranscript({ huddleId, speaker, text });
    },
  }),
);
createHttpServer(router).listen(cfg.port, () => console.log(`[worker] HTTP on :${cfg.port} (GET /health, POST /asr)`));

// ---- SpacetimeDB + jobs ---------------------------------------------------------------------------------------------
async function start(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { conn, identity } = await connectWorker(cfg, (s) => (state.spacetime = s));
      state.conn = conn;
      state.identity = identity;
      state.spacetime = 'connected';
      console.log(`[worker] connected to ${cfg.spacetime.uri}/${cfg.spacetime.db} as worker ${identity.slice(0, 12)}…`);
      await run(conn);
      return;
    } catch (e) {
      state.spacetime = `error: ${e instanceof Error ? e.message : String(e)}`;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      console.error(`[worker] SpacetimeDB not ready (${state.spacetime}); retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

async function run(conn: DbConnection): Promise<void> {
  await attachPlaid(conn);
  const sink = new SpacetimeSink(conn);
  const loader = new HouseholdLoader(conn);
  const history = new SpacetimeHistory(conn);
  attachPhone(conn, { sink, registry, external, llm, loader });
  const deps: RunnerDeps = {
    sink,
    llm,
    registry,
    external,
    loadData: (id) => loader.load(id),
    env: { transcript: (id) => loader.transcript(id) },
    history,
    // offline-only workers may replay local-rule runs; a worker with a real provider only replays runs a real model answered
    allowLocalCache: !llm.providers.some((p) => p.id !== 'local'),
    demoMode: cfg.demoMode,
    maxAgentSteps: cfg.maxAgentSteps,
    agentThinking: cfg.agentThinking,
    primary: () => llm.primary(),
  };
  const queue = new JobQueue({
    claim: (id) => sink.claimJob(id),
    supports: (w) => Boolean(getWorkflow(w)),
    concurrency: 2,
    run: async (job) => {
      const out = await runJob(job, deps);
      state.jobsRun++;
      console.log(`[worker] job ${job.id} ${job.workflow}: ${out.status}${out.replayed ? ' (replayed from cache)' : ''} run=${out.runId}${out.error ? ` error=${out.error}` : ''}`);
    },
  });
  const offer = (row: { id: bigint; workflow: string; householdId: string; subjectId: string; inputJson: string; status: string }) => {
    if (row.status !== 'queued') return;
    queue.offer({ id: row.id, workflow: row.workflow, householdId: row.householdId, subjectId: row.subjectId, input: parseJobInput(row.inputJson) });
  };
  conn.db.agentJob.onInsert((_ctx, row) => offer(row));
  conn.db.agentJob.onUpdate((_ctx, _old, row) => offer(row));
  await subscribeAndWait(conn, ["SELECT * FROM agent_job WHERE status = 'queued'"]);
  for (const row of conn.db.agentJob.iter()) offer(row);
  console.log(`[worker] ready. Workflows: ${workflowNames().join(', ')}. Providers: ${llm.providers.map((p) => `${p.id}(${p.modelFor('agent')})`).join(' -> ')}. DEMO_MODE=${cfg.demoMode}`);
}

void start();

process.on('unhandledRejection', (e) => console.error('[worker] unhandled rejection:', e));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig}, shutting down`);
    try {
      state.conn?.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}
