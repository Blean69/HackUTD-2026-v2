// Finished runs and their trace events, read from the client cache (for DEMO_MODE=cache_first replays).
import type { CachedRun, CachedTraceEvent, RunHistory } from '../agent/cache.js';
import type { Effect } from '../agent/run.js';
import type { DbConnection } from '../module_bindings/index.js';
import { subscribeAndWait } from './connection.js';

export class SpacetimeHistory implements RunHistory {
  private ready: Promise<unknown>;
  constructor(private conn: DbConnection) {
    this.ready = subscribeAndWait(conn, ['SELECT * FROM agent_run']);
  }

  async findCompletedRun(workflow: string, cacheKey: string, excludeRunId: string, allowLocalOnly: boolean): Promise<CachedRun | null> {
    await this.ready;
    const candidates: { run: CachedRun; usedRemote: boolean; at: bigint }[] = [];
    for (const r of this.conn.db.agentRun.iter()) {
      if (r.workflow !== workflow || r.status !== 'done' || r.runId === excludeRunId || !r.resultJson) continue;
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(r.resultJson) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (result.cache_key !== cacheKey || result.replayed_from) continue;
      let usedRemote = false;
      try {
        usedRemote = (JSON.parse(r.providersJson) as { provider: string }[]).some((p) => p.provider !== 'local' && p.provider !== 'cache');
      } catch {
        /* ignore */
      }
      if (!usedRemote && !allowLocalOnly) continue;
      candidates.push({ run: { runId: r.runId, effects: (result.effects as Effect[] | undefined) ?? [], result }, usedRemote, at: r.startedAt.microsSinceUnixEpoch });
    }
    // prefer runs a real Nemotron answered, then the most recent
    candidates.sort((a, b) => Number(b.usedRemote) - Number(a.usedRemote) || (a.at < b.at ? 1 : -1));
    return candidates[0]?.run ?? null;
  }

  async traceEvents(runId: string): Promise<CachedTraceEvent[]> {
    const sub = await subscribeAndWait(this.conn, [`SELECT * FROM trace_event WHERE run_id = '${runId.replace(/'/g, "''")}'`]);
    try {
      return [...this.conn.db.traceEvent.iter()]
        .filter((e) => e.runId === runId)
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ seq: e.seq, tsMs: Number(e.ts.microsSinceUnixEpoch / 1000n), agent: e.agent, type: e.type, title: e.title, dataJson: e.dataJson, model: e.model, provider: e.provider, latencyMs: e.latencyMs }));
    } finally {
      sub.unsubscribe();
    }
  }
}
