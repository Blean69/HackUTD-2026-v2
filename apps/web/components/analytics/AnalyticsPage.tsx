"use client";
import { useMemo, type ReactNode } from "react";
import { CashFlowChart } from "@/components/charts/CashFlowChart";
import { TrendChart } from "@/components/charts/TrendChart";
import { Card, Delta, Empty, PageHeader, Panel, Progress, TableScroll } from "@/components/ui";
import { useRoomFinance } from "@/lib/data/finance-hooks";
import { cleanTxns, isoDay } from "@/lib/finance";
import { cx, usd } from "@/lib/format";
import { useRange } from "@/lib/rangeUi";

const DAY = 86_400_000;
/** Money moving between the household's own accounts is not spending. */
const NOT_SPENDING = new Set(["transfer", "savings", "credit_card_payment", "loan_payment", "mortgage"]);
const NOT_A_CHARGE = new Set(["transfer", "savings", "credit_card_payment"]);

const label = (c: string) => {
  const s = c.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Other";
};
const share = (v: number) => (v > 0 && v < 0.5 ? "<1%" : `${Math.round(v)}%`);

function Kpi({ title, value, sub, tone }: { title: string; value: ReactNode; sub: ReactNode; tone?: "good" | "watch" | "risk" }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-[0.76rem] font-medium text-ink-2">{title}</p>
      <p className={cx("num mt-0.5 text-[1.3rem] font-semibold leading-tight tracking-tight", tone === "good" && "text-good", tone === "watch" && "text-watch", tone === "risk" && "text-risk")}>{value}</p>
      <p className="mt-0.5 text-[0.74rem] leading-snug text-ink-3">{sub}</p>
    </Card>
  );
}

export function AnalyticsPage({ householdId }: { householdId: string }) {
  const fin = useRoomFinance(householdId);
  const { label: rangeLabel } = useRange();
  const { txns, today, cash, trend, debt } = fin;

  // Spending over the last 90 days, from transactions (outflows on any account).
  const spend = useMemo(() => {
    const from = isoDay(new Date(today.getTime() - 90 * DAY));
    const rows = cleanTxns(txns, today).filter((t) => t.date > from && t.amount < 0);
    const byCat = new Map<string, number>();
    const byMerchant = new Map<string, { total: number; count: number; cats: Map<string, number> }>();
    const recurring = new Map<string, number>();
    let total = 0;
    for (const t of rows) {
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
    const categories = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([category, value]) => ({ category, value }));
    const merchants = [...byMerchant.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 8)
      .map(([merchant, m]) => ({ merchant, total: m.total, count: m.count, category: [...m.cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "" }));
    const recurringTotal = [...recurring.values()].reduce((s, v) => s + v, 0);
    return { categories, merchants, total, recurringCount: recurring.size, recurringMonthly: recurringTotal / 3 };
  }, [txns, today]);

  // KPIs from completed months of cash flow.
  const done = cash.filter((m) => !m.forecast);
  const incomeSum = done.reduce((s, m) => s + m.income, 0);
  const netSum = done.reduce((s, m) => s + m.net, 0);
  const avgNet = done.length ? netSum / done.length : null;
  const savingsRate = done.length && incomeSum > 0 ? (netSum / incomeSum) * 100 : null;
  const dti = debt.dti;
  const dtiStatus = debt.ratios.find((r) => r.key === "dti")?.status;
  const maxCat = spend.categories[0]?.value ?? 1;
  const hasTrend = trend.rows.filter((r) => r.actual !== undefined).length > 1;

  return (
    <div>
      <PageHeader title="Analytics" sub={`Trends and spending patterns for the household. Range: ${rangeLabel.toLowerCase()}`} />

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            title="Avg. monthly net cash flow"
            value={avgNet === null ? "n/a" : usd(avgNet, { sign: true })}
            tone={avgNet === null ? undefined : avgNet < 0 ? "risk" : "good"}
            sub={done.length ? `Average of ${done.length} completed ${done.length === 1 ? "month" : "months"}` : "Needs a completed month of history"}
          />
          <Kpi
            title="Savings rate (est.)"
            value={savingsRate === null ? "n/a" : `${savingsRate.toFixed(1)}%`}
            tone={savingsRate === null ? undefined : savingsRate >= 15 ? "good" : savingsRate >= 5 ? "watch" : "risk"}
            sub="Net cash flow as a share of income"
          />
          <Kpi
            title="Debt-to-income"
            value={dti === null ? "n/a" : `${dti.toFixed(1)}%`}
            tone={dtiStatus}
            sub="Monthly debt payments vs gross income"
          />
          <Kpi
            title="Recurring charges"
            value={spend.recurringCount}
            sub={spend.recurringCount ? `About ${usd(spend.recurringMonthly)} a month (est.), last 90 days` : "None found in the last 90 days"}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            id="nw-trend"
            title="Net worth trend"
            sub="Weekly history with a forward projection (est.)"
            right={hasTrend ? <Delta value={trend.change.pct} /> : undefined}
          >
            {hasTrend ? (
              <>
                <p className="sr-only">
                  Net worth is {usd(fin.nw.net)} today, {trend.change.abs >= 0 ? "up" : "down"} {usd(Math.abs(trend.change.abs))} ({Math.abs(trend.change.pct).toFixed(1)}%) over {rangeLabel.toLowerCase()}.
                </p>
                <div className="min-h-[220px]"><TrendChart model={trend} height={260} /></div>
              </>
            ) : (
              <Empty title="Not enough history yet">Net worth is drawn from transactions. It appears once there are a few weeks of data.</Empty>
            )}
          </Panel>

          <Panel id="cash-flow" title="Income vs expenses" sub="Monthly, checking and savings. Later months are projected (est.)">
            {cash.length ? (
              <>
                <p className="sr-only">
                  {done.length ? `Average monthly net cash flow over ${done.length} completed months is ${usd(avgNet ?? 0)}.` : "No completed months of history yet."} Later months are projections.
                </p>
                <div className="min-h-[220px]"><CashFlowChart months={cash} height={260} /></div>
              </>
            ) : (
              <Empty title="No cash flow yet">Income and expenses appear once checking or savings activity is available.</Empty>
            )}
          </Panel>

          <Panel
            id="spend-cat"
            title="Spending by category"
            sub={`Last 90 days${spend.total ? ` · ${usd(spend.total)} total` : ""}. Excludes transfers, savings, card and loan payments, and mortgage.`}
          >
            {spend.categories.length ? (
              <ul className="space-y-3" aria-label="Spending by category, last 90 days">
                {spend.categories.map((c) => {
                  const p = spend.total ? (c.value / spend.total) * 100 : 0;
                  return (
                    <li key={c.category}>
                      <div className="flex items-baseline justify-between gap-3 text-[0.84rem]">
                        <span className="min-w-0 truncate font-medium">{label(c.category)}</span>
                        <span className="num shrink-0">
                          <span className="font-semibold">{usd(c.value)}</span>
                          <span className="ml-2 inline-block w-9 text-right text-[0.78rem] text-ink-3">{share(p)}</span>
                        </span>
                      </div>
                      <Progress value={(c.value / maxCat) * 100} label={`${label(c.category)}: ${share(p)} of spending`} className="mt-1.5" height="h-2" />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty title="No spending in the last 90 days">Purchases show up here by category once transactions are available.</Empty>
            )}
          </Panel>

          <Panel id="merchants" title="Top merchants" sub="Last 90 days, by total spent">
            {spend.merchants.length ? (
              <TableScroll>
                <table className="tbl min-w-[22rem]">
                  <thead>
                    <tr>
                      <th scope="col">Merchant</th>
                      <th scope="col">Category</th>
                      <th scope="col" className="r">Txns</th>
                      <th scope="col" className="r">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spend.merchants.map((m) => (
                      <tr key={m.merchant}>
                        <td className="font-medium">{m.merchant}</td>
                        <td className="whitespace-nowrap text-ink-2">{label(m.category)}</td>
                        <td className="r num">{m.count}</td>
                        <td className="r num whitespace-nowrap font-semibold">{usd(m.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            ) : (
              <Empty title="No merchants yet">The merchants you spend the most with appear here.</Empty>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
