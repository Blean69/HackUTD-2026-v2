// Live phone/voice calls: internal /phone/* routes for the Pipecat voice service (services/voice), see docs/voice-agent.md.
// Importing this module registers the routes on the shared router; attachPhone(conn, deps) turns them on once the worker
// is connected. They answer 503 until then, and always require the x-voice-secret header (VOICE_SHARED_SECRET).
import type { WorkerSink } from '../agent/sink.js';
import type { LLMClient } from '../llm/client.js';
import type { DbConnection } from '../module_bindings/index.js';
import type { ExternalApis } from '../tools/external.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { HouseholdData } from '../types.js';
import { sleep } from '../util.js';
import { SpacetimePhoneCodes } from './access.js';
import { SpacetimeAlertSource } from './callback.js';
import { getPhoneRuntime, setPhoneRuntime } from './routes.js';
import { PhoneService } from './session.js';

export { getPhoneRuntime, resetPhoneRuntime, setPhoneRuntime } from './routes.js';
export { loadPhoneConfig, parsePins } from './config.js';
export { PhoneService, PhoneError } from './session.js';
export { PHONE_TOOLS, voiceView } from './voice_view.js';
export { buildAlertCandidates, SpacetimeAlertSource, StaticAlertSource, type AlertCandidate, type AlertRow, type AlertSource } from './callback.js';
export { hashPin, matchStoredPin, PHONE_PIN_PEPPER, SpacetimePhoneCodes, StaticPhoneCodes, type PhoneCodeRow, type PhoneCodeSource } from './access.js';

export interface AttachPhoneDeps {
  sink: WorkerSink;
  registry: ToolRegistry;
  external: ExternalApis;
  llm: LLMClient;
  loader: { load(householdId: string): Promise<HouseholdData> };
}

/** agent_enqueue_job, then find the new row in the client cache (reducers return no value; the module refuses a duplicate queued call). */
async function enqueueViaConnection(conn: DbConnection, workflow: string, householdId: string, subjectId: string, input: Record<string, unknown>): Promise<bigint> {
  await conn.reducers.agentEnqueueJob({ workflow, householdId, subjectId, inputJson: JSON.stringify(input) });
  const deadline = Date.now() + 5000;
  for (;;) {
    for (const row of conn.db.agentJob.iter()) if (row.workflow === workflow && row.subjectId === subjectId && row.status === 'queued') return row.id;
    if (Date.now() > deadline) throw new Error('the queued phone job did not show up in the client cache');
    await sleep(50);
  }
}

export function attachPhone(conn: DbConnection, deps: AttachPhoneDeps): PhoneService {
  const cfg = getPhoneRuntime().cfg;
  getPhoneRuntime().service?.stopReaper();
  // The household codes families set in the app: a worker-only view, subscribed in the background (identify waits for it, briefly).
  const codes = new SpacetimePhoneCodes(conn);
  void codes.attach();
  const service = new PhoneService({
    codes,
    alerts: new SpacetimeAlertSource(conn),
    sink: deps.sink,
    registry: deps.registry,
    external: deps.external,
    llm: deps.llm,
    loadData: (id) => deps.loader.load(id),
    enqueueJob: (w, h, s, i) => enqueueViaConnection(conn, w, h, s, i),
    cfg,
  });
  service.startReaper();
  setPhoneRuntime({ service });
  console.log(`[phone] ${!cfg.enabled ? 'disabled (VOICE_ENABLED=0)' : !cfg.secret ? 'VOICE_SHARED_SECRET is not set: /phone/* answers 503 voice_unconfigured' : `ready (${cfg.pins.size} PIN(s), up to ${cfg.maxSessions} live calls)`}`);
  return service;
}
