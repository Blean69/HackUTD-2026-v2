// npm run seed: load data/seed/*.json into SpacetimeDB through the seed_* reducers, then recompute each household.
// Idempotent: the reducers skip ids that already exist; recompute is deterministic.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadEnv } from './config.js';
import { connectWorker } from './db/connection.js';

const MAX_BATCH_BYTES = 400_000; // well under 1 MB per reducer call

export function batches(rows: unknown[], maxBytes = MAX_BATCH_BYTES, maxRows = 800): unknown[][] {
  const out: unknown[][] = [];
  let cur: unknown[] = [];
  let size = 2;
  for (const r of rows) {
    const n = JSON.stringify(r).length + 1;
    if (cur.length && (size + n > maxBytes || cur.length >= maxRows)) {
      out.push(cur);
      cur = [];
      size = 2;
    }
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

function readRows(dir: string, file: string): unknown[] {
  const v = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  if (!Array.isArray(v)) throw new Error(`${file} must contain a JSON array`);
  return v;
}

async function main(): Promise<void> {
  loadEnv();
  const cfg = loadConfig();
  const { conn } = await connectWorker(cfg);
  const r = conn.reducers;
  const steps: [string, string, (a: { rowsJson: string }) => Promise<void>][] = [
    ['households', 'households.json', (a) => r.seedHouseholds(a)],
    ['members', 'members.json', (a) => r.seedMembers(a)],
    ['accounts', 'accounts.json', (a) => r.seedAccounts(a)],
    ['credit profiles', 'credit_profiles.json', (a) => r.seedCredit(a)],
    ['transactions', 'transactions.json', (a) => r.seedTxns(a)],
    ['obligations', 'obligations.json', (a) => r.seedObligations(a)],
    ['conversations', 'conversations.json', (a) => r.seedConversations(a)],
  ];
  let households: string[] = [];
  for (const [label, file, call] of steps) {
    const rows = readRows(cfg.dataDir, file);
    if (label === 'households') households = rows.map((h) => String((h as { id: string }).id));
    const parts = batches(rows);
    for (const part of parts) await call({ rowsJson: JSON.stringify(part) });
    console.log(`[seed] ${label}: ${rows.length} rows in ${parts.length} call(s)`);
  }
  for (const id of households) {
    await r.recomputeHousehold({ householdId: id });
    console.log(`[seed] recomputed ${id}`);
  }
  conn.disconnect();
  console.log('[seed] done');
}

// run only when executed directly (tests import `batches`)
if (process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error('[seed] failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
