// Link an item: public_token -> access_token -> agent_save_plaid_item -> agent_set_bank_connection (linking) -> request_bank_sync.
// With `select` (onboarding, docs/contracts.md section 7) it stops after listing the accounts: /accounts/get ->
// agent_set_account_options -> bank_connection "selecting"; the family picks accounts and select_bank_accounts queues the sync.
// Shared by POST /plaid/exchange and POST /plaid/sandbox_connect. The access token never leaves this process.
import { CUSTOM_SANDBOX_USER } from './custom_user.js';
import { isPlaidError, type PlaidClient, type PlaidConfig } from './types.js';
import type { AccountOption, PlaidStore } from './store.js';

export const SANDBOX_INSTITUTION = 'ins_109508'; // First Platypus Bank
export const SANDBOX_INSTITUTION_NAME = 'First Platypus Bank';
export const DEFAULT_SANDBOX_USER = 'user_transactions_dynamic';
export const FALLBACK_SANDBOX_USER = 'user_good';

export interface Linked {
  item_id: string;
  institution_id: string;
  institution_name: string;
  /** select mode only: how many accounts were offered to the family. */
  accounts?: number;
}

/** /accounts/get -> bank_account_option rows -> bank_connection "selecting". The sync waits for select_bank_accounts. */
export async function offerAccounts(client: PlaidClient, store: PlaidStore, o: { householdId: string; itemId: string; accessToken: string; institutionName: string }): Promise<number> {
  const { accounts } = await client.accountsGet(o.accessToken);
  const options: AccountOption[] = accounts.map((a) => ({
    accountId: a.account_id,
    name: a.name,
    officialName: a.official_name ?? '',
    mask: a.mask ?? '',
    type: a.type,
    subtype: a.subtype ?? '',
    balance: a.balances.current ?? a.balances.available ?? 0,
  }));
  await store.setAccountOptions(o.householdId, o.itemId, options);
  await store.setConnection({ itemId: o.itemId, householdId: o.householdId, institutionName: o.institutionName, status: 'selecting', accountsCount: options.length, txnsCount: 0 });
  return options.length;
}

export async function linkItem(client: PlaidClient, store: PlaidStore, o: { householdId: string; publicToken: string; institutionId?: string; institutionName?: string; select?: boolean }): Promise<Linked> {
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
  if (o.select) {
    const accounts = await offerAccounts(client, store, { householdId: o.householdId, itemId: ex.item_id, accessToken: ex.access_token, institutionName: name });
    return { item_id: ex.item_id, institution_id: institutionId, institution_name: name, accounts };
  }
  await store.requestSync(o.householdId);
  return { item_id: ex.item_id, institution_id: institutionId, institution_name: name };
}

export interface SandboxResult extends Linked {
  username: string;
  products: string[];
  /** true when the household already had this institution linked: no new item, just a fresh sync (or a fresh offer in select mode). */
  reused: boolean;
  /** Sandbox users Plaid rejected before this one worked (for example the custom user), with Plaid's error code. */
  rejected?: { username: string; code: string; detail: string }[];
}

/**
 * /sandbox/public_token/create on First Platypus Bank, then the same path as a Link exchange. Without an explicit username the
 * demo bank is the custom user (`customUser` = the contents of data/plaid/sandbox_user.json) when available; if Plaid rejects it
 * (or no file is configured) the worker falls back to user_transactions_dynamic, then user_good. `select` stops after offering
 * the accounts (onboarding).
 */
export async function sandboxConnect(rt: { client: PlaidClient; store: PlaidStore; config: PlaidConfig }, o: { householdId: string; username?: string; institutionId?: string; forceNew?: boolean; select?: boolean; customUser?: string | null }): Promise<SandboxResult> {
  const institution = o.institutionId || SANDBOX_INSTITUTION;
  // a second click on "quick connect" must not stack a second copy of the same sandbox bank on the household
  if (!o.forceNew) {
    const existing = (await rt.store.items(o.householdId)).find((i) => i.institutionId === institution);
    if (existing) {
      const accounts = o.select ? await offerAccounts(rt.client, rt.store, { householdId: o.householdId, itemId: existing.itemId, accessToken: existing.accessToken, institutionName: existing.institutionName }) : undefined;
      if (!o.select) await rt.store.requestSync(o.householdId);
      return { item_id: existing.itemId, institution_id: institution, institution_name: existing.institutionName, username: o.username ?? DEFAULT_SANDBOX_USER, products: rt.config.products, reused: true, ...(accounts !== undefined ? { accounts } : {}) };
    }
  }
  const users = o.username ? [o.username] : [...(o.customUser ? [CUSTOM_SANDBOX_USER] : []), DEFAULT_SANDBOX_USER, FALLBACK_SANDBOX_USER];
  const rejected: NonNullable<SandboxResult['rejected']> = [];
  const all = rt.config.products;
  const productSets = all.length > 1 || all[0] !== 'transactions' ? [all, ['transactions']] : [all];
  let last: unknown = new Error('no sandbox user could be created');
  for (const username of users) {
    for (const products of productSets) {
      try {
        const password = username === CUSTOM_SANDBOX_USER && o.customUser ? o.customUser : undefined;
        const pub = await rt.client.sandboxPublicTokenCreate({ institution_id: institution, initial_products: products, username, ...(password ? { password } : {}) });
        const linked = await linkItem(rt.client, rt.store, { householdId: o.householdId, publicToken: pub.public_token, institutionId: institution, ...(o.select ? { select: true } : {}), ...(institution === SANDBOX_INSTITUTION ? { institutionName: SANDBOX_INSTITUTION_NAME } : {}) });
        const before = rejected.filter((r) => r.username !== username); // a user that worked on a second try was not "rejected"
        return { ...linked, username, products, reused: false, ...(before.length ? { rejected: before } : {}) };
      } catch (e) {
        last = e;
        if (!isPlaidError(e)) throw e; // store / network problems are not a reason to try another user
        if (!rejected.some((r) => r.username === username)) rejected.push({ username, code: e.code, detail: e.message.slice(0, 200) });
      }
    }
  }
  throw last;
}
