// Link an item: public_token -> access_token -> agent_save_plaid_item -> agent_set_bank_connection (linking) -> request_bank_sync.
// Shared by POST /plaid/exchange and POST /plaid/sandbox_connect. The access token never leaves this process.
import { isPlaidError, type PlaidClient, type PlaidConfig } from './types.js';
import type { PlaidStore } from './store.js';

export const SANDBOX_INSTITUTION = 'ins_109508'; // First Platypus Bank
export const SANDBOX_INSTITUTION_NAME = 'First Platypus Bank';
export const DEFAULT_SANDBOX_USER = 'user_transactions_dynamic';
export const FALLBACK_SANDBOX_USER = 'user_good';

export interface Linked {
  item_id: string;
  institution_id: string;
  institution_name: string;
}

export async function linkItem(client: PlaidClient, store: PlaidStore, o: { householdId: string; publicToken: string; institutionId?: string; institutionName?: string }): Promise<Linked> {
  const ex = await client.itemPublicTokenExchange(o.publicToken);
  let institutionId = o.institutionId ?? '';
  let name = o.institutionName ?? '';
  if (!institutionId || !name) {
    const found = institutionId ? { institution_id: institutionId, name: await client.institutionName(institutionId) } : await client.itemInstitution(ex.access_token);
    institutionId = institutionId || found?.institution_id || '';
    name = name || found?.name || '';
  }
  if (!name) name = institutionId === SANDBOX_INSTITUTION ? SANDBOX_INSTITUTION_NAME : 'Linked bank';
  await store.saveItem({ itemId: ex.item_id, householdId: o.householdId, accessToken: ex.access_token, institutionId, institutionName: name, cursor: '' });
  await store.setConnection({ itemId: ex.item_id, householdId: o.householdId, institutionName: name, status: 'linking', accountsCount: 0, txnsCount: 0 });
  await store.requestSync(o.householdId);
  return { item_id: ex.item_id, institution_id: institutionId, institution_name: name };
}

export interface SandboxResult extends Linked {
  username: string;
  products: string[];
  /** true when the household already had this institution linked: no new item, just a fresh sync. */
  reused: boolean;
}

/** /sandbox/public_token/create on First Platypus Bank, then the same path as a Link exchange. */
export async function sandboxConnect(rt: { client: PlaidClient; store: PlaidStore; config: PlaidConfig }, o: { householdId: string; username?: string; institutionId?: string; forceNew?: boolean }): Promise<SandboxResult> {
  const institution = o.institutionId || SANDBOX_INSTITUTION;
  // a second click on "quick connect" must not stack a second copy of the same sandbox bank on the household
  if (!o.forceNew) {
    const existing = (await rt.store.items(o.householdId)).find((i) => i.institutionId === institution);
    if (existing) {
      await rt.store.requestSync(o.householdId);
      return { item_id: existing.itemId, institution_id: institution, institution_name: existing.institutionName, username: o.username ?? DEFAULT_SANDBOX_USER, products: rt.config.products, reused: true };
    }
  }
  const users = o.username ? [o.username] : [DEFAULT_SANDBOX_USER, FALLBACK_SANDBOX_USER];
  const all = rt.config.products;
  const productSets = all.length > 1 || all[0] !== 'transactions' ? [all, ['transactions']] : [all];
  let last: unknown = new Error('no sandbox user could be created');
  for (const username of users) {
    for (const products of productSets) {
      try {
        const pub = await rt.client.sandboxPublicTokenCreate({ institution_id: institution, initial_products: products, username });
        const linked = await linkItem(rt.client, rt.store, { householdId: o.householdId, publicToken: pub.public_token, institutionId: institution, ...(institution === SANDBOX_INSTITUTION ? { institutionName: SANDBOX_INSTITUTION_NAME } : {}) });
        return { ...linked, username, products, reused: false };
      } catch (e) {
        last = e;
        if (!isPlaidError(e)) throw e; // store / network problems are not a reason to try another user
      }
    }
  }
  throw last;
}
