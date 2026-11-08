"use client";
import { useMemo } from "react";
import { CashFlowChart } from "@/components/charts/lazy";
import { Empty, Panel, Progress, Skeleton, TableScroll } from "@/components/ui";
import { useToday } from "@/lib/data/finance-hooks";
import { useAccounts, useMembers, useObligations, useRoomTables, useTxns } from "@/lib/data/hooks";
import { HISTORY_MONTHS, cleanTxns, isoDay, monthlyCashFlow } from "@/lib/finance";
import { usd } from "@/lib/format";

const DAY = 86_400_000;
/** Money moving between the household's own accounts is not spending. */
const NOT_SPENDING = new Set(["transfer", "savings", "credit_card_payment", "loan_payment", "mortgage"]);
const NOT_A_CHARGE = new Set(["transfer", "savings", "credit_card_payment"]);
const label = (c: string) => {
  const s = c.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Other";
};
const TOP = 6;

/** Monthly income and expenses, then the last 90 days by category and merchant. */
export function SpendingTab({ householdId }: { householdId: string }) {
  const ready = useRoomTables(householdId, ["txn", "obligation"]);
  const txns = useTxns(householdId);
  const accounts = useAccounts(householdId);
  const obligations = useObligations(householdId);
  const members = useMembers(householdId);
  const today = useToday();

  const cash = useMemo(() => monthlyCashFlow(txns, accounts, obligations, members, today, HISTORY_MONTHS), [txns, accounts, obligations, members, today]);
  const spend = useMemo(() => {
    const from = isoDay(new Date(today.getTime() - 90 * DAY));
    const byCat = new Map<string, number>();
    const byMerchant = new Map<string, { total: number; count: number; cats: Map<string, number> }>();
    const recurring = new Map<string, number>();
    let total = 0;
    for (const t of cleanTxns(txns, today)) {
      if (t.date <= from || t.amount >= 0) continue;
      const amt = -t.amount;
      if (t.is_recurring && !NOT_A_CHARGE.has(t.category)) recurring.set(t.merchant, (recurring.get(t.merchant) ?? 0) + amt);
      if (NOT_SPENDING.has(t.category)) continue;
      total += amt;
      byCat.set(t.category, (byCat.get(t.category) ?? 0) + amt);
      const m = byMerchant.get(t.merchant) ?? { total: 0, count: 0, cats: new Map<string, number>() };
      m.total += amt;
      m.count += 1;
      m.cats.set(t.category, (m.cats.get(t.category) ?? 0) + amt);
      byMerchant.set(t.merchant, m);
    }
    return {
      total,
      categories: [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([category, value]) => ({ category, value })),
      merchants: [...byMerchant.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, TOP).map(([merchant, m]) => ({
        merchant, total: m.total, count: m.count, category: [...m.cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
      })),
      recurringCount: recurring.size,
      recurringMonthly: [...recurring.values()].reduce((s, v) => s + v, 0) / 3,
    };
  }, [txns, today]);

  if (!ready) return <Skeleton className="h-96 !rounded-lg" />;
  const maxCat = spend.categories[0]?.value ?? 1;

  return (
    <div className="space-y-3">
      <Panel id="income-expenses" title="Income and expenses" sub="By month; the lighter bars are projected">
        {cash.length ? <CashFlowChart months={cash} height={220} /> : <Empty title="No cash flow yet">Income and expenses appear once checking or savings activity is available.</Empty>}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel id="spend-cat" title="Where it went" sub={spend.total ? `Last 90 days · ${usd(spend.total)}` : "Last 90 days"}>
          {spend.categories.length ? (
            <ul className="space-y-2.5" aria-label="Spending by category, last 90 days">
              {spend.categories.map((c) => (
                <li key={c.category}>
                  <div className="flex items-baseline justify-between gap-3 text-[0.84rem]">
                    <span className="min-w-0 truncate font-medium">{label(c.category)}</span>
                    <span className="num shrink-0 font-semibold">{usd(c.value)}</span>
                  </div>
                  <Progress value={(c.value / maxCat) * 100} label={`${label(c.category)}: ${usd(c.value)}`} className="mt-1" height="h-1.5" />
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No spending yet">Purchases show up here by category.</Empty>
          )}
          {spend.recurringCount ? (
            <p className="mt-3 text-[0.78rem] text-ink-3">{spend.recurringCount} recurring charges, about <span className="num">{usd(spend.recurringMonthly)}</span> a month. Transfers, savings and loan payments are left out.</p>
          ) : null}
        </Panel>

        <Panel id="merchants" title="Top merchants" sub="Last 90 days">
          {spend.merchants.length ? (
            <TableScroll>
              <table className="tbl">
                <thead><tr><th scope="col">Merchant</th><th scope="col" className="r">Txns</th><th scope="col" className="r">Total</th></tr></thead>
                <tbody>
                  {spend.merchants.map((m) => (
                    <tr key={m.merchant}>
                      <td><span className="font-medium">{m.merchant}</span><span className="block text-[0.74rem] text-ink-3">{label(m.category)}</span></td>
                      <td className="r num">{m.count}</td>
                      <td className="r num whitespace-nowrap font-semibold">{usd(m.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          ) : (
            <Empty title="No merchants yet">The places you spend the most appear here.</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}
