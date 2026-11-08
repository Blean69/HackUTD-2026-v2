"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { IconArrowRight, IconRepeat } from "@/components/icons";
import { Button, Empty, Skeleton, selectCls } from "@/components/ui";
import { useToday } from "@/lib/data/finance-hooks";
import { useAccounts, useRoomTables, useTxns } from "@/lib/data/hooks";
import { categoryLabel, recentLedger } from "@/lib/finance-analytics";
import { cx, longDate, usd } from "@/lib/format";

const PAGE = 30;

/**
 * The ledger: the newest transactions, filterable by account. Patterns (categories, merchants, income vs expenses) are
 * on Analytics, so this tab only answers "what just happened".
 */
export function ActivityTab({ householdId }: { householdId: string }) {
  const ready = useRoomTables(householdId, ["txn"]);
  const txns = useTxns(householdId);
  const accounts = useAccounts(householdId);
  const today = useToday();
  const [account, setAccount] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const ledger = useMemo(() => recentLedger(txns, accounts, today, limit, account || undefined), [txns, accounts, today, limit, account]);

  const days = useMemo(() => {
    const out: { date: string; rows: typeof ledger.rows }[] = [];
    for (const r of ledger.rows) {
      const last = out[out.length - 1];
      if (last && last.date === r.date) last.rows.push(r);
      else out.push({ date: r.date, rows: [r] });
    }
    return out;
  }, [ledger]);

  if (!ready) return <Skeleton className="h-96 !rounded-lg" />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-label text-ink-2">
          <span className="sr-only sm:not-sr-only">Account</span>
          <select className={selectCls} value={account} onChange={(e) => { setAccount(e.target.value); setLimit(PAGE); }}>
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.nickname}</option>)}
          </select>
        </label>
        <Link href={`/room/${householdId}/analytics`} className="inline-flex items-center gap-1 text-label font-medium text-brand-strong hover:underline">
          Spending patterns in Analytics <IconArrowRight size={13} />
        </Link>
      </div>

      {!ledger.rows.length ? (
        <Empty title="No transactions yet">Activity from linked accounts lands here.</Empty>
      ) : (
        <div className="card overflow-hidden rounded-lg border border-line bg-surface">
          {days.map((d) => (
            <section key={d.date} aria-label={longDate(d.date)}>
              <h3 className="num border-b border-line bg-surface-2 px-4 py-1.5 text-caption font-medium text-ink-3">{longDate(d.date)}</h3>
              <ul className="divide-y divide-line">
                {d.rows.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-body font-medium">{r.merchant}</span>
                        {r.recurring ? <><IconRepeat size={13} className="shrink-0 text-ink-3" /><span className="sr-only">recurring</span></> : null}
                      </span>
                      <span className="block truncate text-caption text-ink-3">{categoryLabel(r.category)}{r.account ? ` · ${r.account}` : ""}</span>
                    </span>
                    <span className={cx("num shrink-0 text-body font-semibold", r.amount > 0 ? "text-good" : "text-ink")}>{usd(r.amount, { cents: true, sign: r.amount > 0 })}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {ledger.total > ledger.rows.length ? (
            <div className="border-t border-line p-3 text-center">
              <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, ledger.total - ledger.rows.length)} more</Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
