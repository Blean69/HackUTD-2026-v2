// Everything the Plaid code writes to / reads from SpacetimeDB, behind one interface so the workflow and the routes are
// testable with MemoryPlaidStore. SpacetimePlaidStore maps each method to one worker-only reducer (or the client reducers
// request_bank_sync / recompute_household). Tokens come back through the `worker_plaid_items` view, never `plaid_item`.
import { subscribeAndWait } from '../db/connection.js';
import type { DbConnection } from '../module_bindings/index.js';
import type { AccountRow, TxnRow } from './mapping.js';

export interface PlaidItem {
  itemId: string;
  householdId: string;
  accessToken: string;
  institutionId: string;
  institutionName: string;
  /** /transactions/sync cursor; "" before the first sync. */
  cursor: string;
}

export type ConnectionStatus = 'linking' | 'selecting' | 'syncing' | 'ok' | 'error';
export interface ConnectionUpdate {
  itemId: string;
  householdId: string;
  institutionName: string;
  status: ConnectionStatus;
  accountsCount: number;
  txnsCount: number;
  error?: string;
}

/** One bank account offered to the family during onboarding (bank_account_option). */
export interface AccountOption {
  accountId: string;
  name: string;
  officialName: string;
  mask: string;
  type: string;
  subtype: string;
  balance: number;
}

export interface PlaidStore {
  /** True when the household row exists (the routes check this before touching Plaid). */
  householdExists(householdId: string): Promise<boolean>;
  /** The Plaid items stored for a household (empty when none or when this worker is not registered). */
  items(householdId: string): Promise<PlaidItem[]>;
  /** Create or update an item. Empty accessToken / institutionId / institutionName keep the stored values; cursor is always overwritten. */
  saveItem(item: PlaidItem): Promise<void>;
  setConnection(c: ConnectionUpdate): Promise<void>;
  upsertAccounts(rows: AccountRow[]): Promise<void>;
  upsertTxns(rows: TxnRow[]): Promise<void>;
  removeTxns(ids: string[]): Promise<void>;
  recompute(householdId: string): Promise<void>;
  /** The client reducer request_bank_sync: queues a plaid_sync job. */
  requestSync(householdId: string): Promise<void>;
  /** Plaid-sourced transactions currently stored on these accounts, or null when unknown. */
  countTxns(householdId: string, accountIds: string[]): Promise<number | null>;
  /** The worker-only reducer agent_set_account_options: the accounts the family can choose from (onboarding). */
  setAccountOptions(householdId: string, itemId: string, options: AccountOption[]): Promise<void>;
  /** Plaid account ids the family selected for this item, or null when no selection exists (import everything). */
  selectedAccountIds(householdId: string, itemId: string): Promise<Set<string> | null>;
}

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export class SpacetimePlaidStore implements PlaidStore {
  /** Items written by this process win over the view (the view can lag a reducer call by a moment). */
  private written = new Map<string, PlaidItem>();
  private subs = new Map<string, Promise<unknown>>();
  private viewSub: Promise<unknown> | null = null;

  constructor(private conn: DbConnection) {}

  /** Subscribe to the token view. Call once the worker is registered. */
  attach(): Promise<unknown> {
    this.viewSub ??= subscribeAndWait(this.conn, ['SELECT * FROM worker_plaid_items']).catch((e) => {
      this.viewSub = null;
      throw e;
    });
    return this.viewSub;
  }

  async householdExists(householdId: string): Promise<boolean> {
    const sub = await subscribeAndWait(this.conn, [`SELECT * FROM household WHERE id = ${sqlStr(householdId)}`], 15_000);
    const found = this.conn.db.household.id.find(householdId) !== undefined;
    if (!found) {
      try {
        sub.unsubscribe();
      } catch {
        /* ignore */
      }
    }
    return found;
  }

  async items(householdId: string): Promise<PlaidItem[]> {
    await this.attach();
    const out = new Map<string, PlaidItem>();
    for (const r of this.conn.db.workerPlaidItems.iter()) {
      if (r.householdId === householdId) out.set(r.itemId, { itemId: r.itemId, householdId: r.householdId, accessToken: r.accessToken, institutionId: r.institutionId, institutionName: r.institutionName, cursor: r.cursor });
    }
    for (const w of this.written.values()) if (w.householdId === householdId) out.set(w.itemId, w);
    return [...out.values()];
  }

  async saveItem(item: PlaidItem): Promise<void> {
    await this.conn.reducers.agentSavePlaidItem({ itemId: item.itemId, householdId: item.householdId, accessToken: item.accessToken, institutionId: item.institutionId, institutionName: item.institutionName, cursor: item.cursor });
    const prev = this.written.get(item.itemId) ?? [...this.conn.db.workerPlaidItems.iter()].map((r) => ({ itemId: r.itemId, householdId: r.householdId, accessToken: r.accessToken, institutionId: r.institutionId, institutionName: r.institutionName, cursor: r.cursor })).find((r) => r.itemId === item.itemId);
    this.written.set(item.itemId, {
      itemId: item.itemId,
      householdId: item.householdId,
      accessToken: item.accessToken || prev?.accessToken || '',
      institutionId: item.institutionId || prev?.institutionId || '',
      institutionName: item.institutionName || prev?.institutionName || '',
      cursor: item.cursor,
    });
  }

  setConnection(c: ConnectionUpdate): Promise<void> {
    return this.conn.reducers.agentSetBankConnection({ itemId: c.itemId, householdId: c.householdId, institutionName: c.institutionName, status: c.status, accountsCount: c.accountsCount, txnsCount: c.txnsCount, error: c.error ?? '' });
  }
  upsertAccounts(rows: AccountRow[]): Promise<void> {
    return this.conn.reducers.agentUpsertAccounts({ rowsJson: JSON.stringify(rows) });
  }
  upsertTxns(rows: TxnRow[]): Promise<void> {
    return this.conn.reducers.agentUpsertTxns({ rowsJson: JSON.stringify(rows) });
  }
  removeTxns(ids: string[]): Promise<void> {
    return this.conn.reducers.agentRemoveTxns({ idsJson: JSON.stringify(ids) });
  }
  recompute(householdId: string): Promise<void> {
    return this.conn.reducers.recomputeHousehold({ householdId });
  }
  requestSync(householdId: string): Promise<void> {
    return this.conn.reducers.requestBankSync({ householdId });
  }

  setAccountOptions(householdId: string, itemId: string, options: AccountOption[]): Promise<void> {
    const rows = options.map((o) => ({ account_id: o.accountId, name: o.name, official_name: o.officialName, mask: o.mask, type: o.type, subtype: o.subtype, balance: o.balance }));
    return this.conn.reducers.agentSetAccountOptions({ householdId, itemId, rowsJson: JSON.stringify(rows) });
  }

  async selectedAccountIds(householdId: string, itemId: string): Promise<Set<string> | null> {
    // a fresh snapshot each time: select_bank_accounts just changed these rows and the job started right after it
    const sub = await subscribeAndWait(this.conn, [`SELECT * FROM bank_account_option WHERE household_id = ${sqlStr(householdId)}`], 15_000);
    try {
      const mine = [...this.conn.db.bankAccountOption.iter()].filter((o) => o.householdId === householdId && o.itemId === itemId);
      if (!mine.length) return null;
      return new Set(mine.filter((o) => o.selected).map((o) => o.accountId));
    } finally {
      try {
        sub.unsubscribe();
      } catch {
        /* ignore */
      }
    }
  }

  async countTxns(householdId: string, accountIds: string[]): Promise<number | null> {
    try {
      let p = this.subs.get(householdId);
      if (!p) {
        p = subscribeAndWait(this.conn, [`SELECT * FROM txn WHERE household_id = ${sqlStr(householdId)}`], 30_000).catch((e) => {
          this.subs.delete(householdId);
          throw e;
        });
        this.subs.set(householdId, p);
      }
      await p;
      const ids = new Set(accountIds);
      let n = 0;
      for (const t of this.conn.db.txn.iter()) if (t.householdId === householdId && t.source === 'plaid' && ids.has(t.accountId)) n++;
      return n;
    } catch {
      return null;
    }
  }
}

/** In-memory store for tests: records every call and applies it to plain maps. */
export class MemoryPlaidStore implements PlaidStore {
  itemsById = new Map<string, PlaidItem>();
  connections = new Map<string, ConnectionUpdate>();
  connectionLog: ConnectionUpdate[] = [];
  accounts = new Map<string, AccountRow>();
  txns = new Map<string, TxnRow>();
  upsertTxnBatches: number[] = [];
  removeBatches: string[][] = [];
  recomputed: string[] = [];
  syncRequests: string[] = [];
  calls: string[] = [];
  failOn: string | null = null;
  households = new Set<string>(['hh_test']);
  options = new Map<string, AccountOption[]>();
  /** itemId -> selected Plaid account ids (absent = no selection exists). */
  selection = new Map<string, Set<string>>();

  private hit(name: string): void {
    this.calls.push(name);
    if (this.failOn === name) throw new Error(`${name} failed (test)`);
  }

  async householdExists(householdId: string): Promise<boolean> {
    return this.households.has(householdId);
  }
  async items(householdId: string): Promise<PlaidItem[]> {
    return [...this.itemsById.values()].filter((i) => i.householdId === householdId);
  }
  async saveItem(item: PlaidItem): Promise<void> {
    this.hit('saveItem');
    const prev = this.itemsById.get(item.itemId);
    this.itemsById.set(item.itemId, { ...item, accessToken: item.accessToken || prev?.accessToken || '', institutionId: item.institutionId || prev?.institutionId || '', institutionName: item.institutionName || prev?.institutionName || '' });
  }
  async setConnection(c: ConnectionUpdate): Promise<void> {
    this.hit('setConnection');
    this.connections.set(c.itemId, c);
    this.connectionLog.push(c);
  }
  async upsertAccounts(rows: AccountRow[]): Promise<void> {
    this.hit('upsertAccounts');
    for (const r of rows) this.accounts.set(r.id, r);
  }
  async upsertTxns(rows: TxnRow[]): Promise<void> {
    this.hit('upsertTxns');
    this.upsertTxnBatches.push(rows.length);
    for (const r of rows) this.txns.set(r.id, r);
  }
  async removeTxns(ids: string[]): Promise<void> {
    this.hit('removeTxns');
    this.removeBatches.push(ids);
    for (const id of ids) this.txns.delete(id);
  }
  async recompute(householdId: string): Promise<void> {
    this.hit('recompute');
    this.recomputed.push(householdId);
  }
  async requestSync(householdId: string): Promise<void> {
    this.hit('requestSync');
    this.syncRequests.push(householdId);
  }
  async setAccountOptions(_householdId: string, itemId: string, options: AccountOption[]): Promise<void> {
    this.hit('setAccountOptions');
    this.options.set(itemId, options);
  }
  async selectedAccountIds(_householdId: string, itemId: string): Promise<Set<string> | null> {
    return this.selection.get(itemId) ?? null;
  }
  async countTxns(householdId: string, accountIds: string[]): Promise<number | null> {
    const ids = new Set(accountIds);
    return [...this.txns.values()].filter((t) => t.household_id === householdId && ids.has(t.account_id)).length;
  }
}
