import { readFileSync } from 'node:fs';
import { Configuration, PlaidApi, PlaidEnvironments, Products } from 'plaid/legacy';
import { loadEnv } from './src/config.js';
import { loadPlaidConfig } from './src/plaid/config.js';

loadEnv();
const c = loadPlaidConfig();
if (!c) throw new Error('plaid not configured');
const api = new PlaidApi(new Configuration({ basePath: (PlaidEnvironments as any)[c.env], baseOptions: { headers: { 'PLAID-CLIENT-ID': c.clientId, 'PLAID-SECRET': c.secret, 'Plaid-Version': '2020-09-14' } } }));
const base = JSON.parse(readFileSync('../../data/plaid/sandbox_user.json', 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const variants: [string, any][] = [['days_requested 180', { days_requested: 180 }], ['days_requested 365', { days_requested: 365 }], ['default 90', undefined]];
for (const [name, tx] of variants) {
  const pub = await api.sandboxPublicTokenCreate({ institution_id: 'ins_109508', initial_products: [Products.Transactions], options: { override_username: 'user_custom', override_password: JSON.stringify(base), ...(tx ? { transactions: tx } : {}) } });
  const ex = await api.itemPublicTokenExchange({ public_token: pub.data.public_token });
  let cursor = ''; const seen = new Map<string, string>(); const log: string[] = [];
  for (let attempt = 1; attempt <= 14; attempt++) {
    let more = true; let status = '';
    while (more) {
      const r = await api.transactionsSync({ access_token: ex.data.access_token, cursor: cursor || undefined, count: 500 });
      for (const t of [...r.data.added, ...r.data.modified]) seen.set(t.transaction_id, t.date);
      for (const t of r.data.removed) seen.delete(t.transaction_id);
      cursor = r.data.next_cursor; more = r.data.has_more; status = String((r.data as any).transactions_update_status).replace('_UPDATE_COMPLETE', '');
    }
    log.push(`${attempt}:${seen.size}${status.startsWith('HIST') ? 'H' : status.startsWith('INIT') ? 'I' : '?'}`);
    await sleep(3000);
  }
  const dates = [...seen.values()].sort();
  console.log(name.padEnd(20), log.join(' '), '|', dates[0], '..', dates.at(-1));
}
