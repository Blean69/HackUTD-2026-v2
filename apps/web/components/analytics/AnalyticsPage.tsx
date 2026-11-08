"use client";
import { useMemo } from "react";
import { BarList } from "@/components/charts/BarList";
import { CashFlowChart, TrendChart } from "@/components/charts/lazy";
import { CountUp } from "@/components/motion";
import { BENTO, Delta, Empty, PageHeader, Panel, Skeleton, StatCard, TableScroll } from "@/components/ui";
import { useRoomFinance } from "@/lib/data/finance-hooks";
import { cashSummary, categoryLabel, spendingBreakdown, withSharedSpending } from "@/lib/finance-analytics";
import { usd } from "@/lib/format";

type Tone = "good" | "watch" | "risk";
const share = (v: number) => (v > 0 && v < 0.5 ? "<1%" : `${Math.round(v)}%`);

function AnalyticsSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-3" aria-busy="true" aria-label="Loading analytics">
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="col-span-6 h-28 !rounded-lg xl:col-span-3" />)}
      <Skeleton className="col-span-12 h-80 !rounded-lg xl:col-span-6" />
      <Skeleton className="col-span-12 h-80 !rounded-lg xl:col-span-6" />
      <Skeleton className="col-span-12 h-72 !rounded-lg md:col-span-6" />
      <Skeleton className="col-span-12 h-72 !rounded-lg md:col-span-6" />
    </div>
  );
}

/**
 * Trends and patterns: four KPIs, the net-worth trend, income against expenses, and the last 90 days by category and
 * merchant. The Dashboard keeps today's numbers; this page explains how they got there.
 */
export function AnalyticsPage({ householdId }: { householdId: string }) {
  const fin = useRoomFinance(householdId);
  const { txns, today, cash, trend, health, nw } = fin;
  const spend = useMemo(() => withSharedSpending(spendingBreakdown(txns, today, 90, 8), fin.cashFlow, 8), [txns, today, fin.cashFlow]);
  const sum = useMemo(() => cashSummary(cash), [cash]);
  // Monthly net from SpacetimeDB (same figure as the dashboard, the health card and Brian); calendar-month average without it
  const avgNet = fin.cashFlow ? fin.cashFlow.net_monthly : sum.avgNet;
  const dti = health.find((h) => h.key === "debt_to_income");
  // the household-health indicator (SpacetimeDB): same figure as the dashboard and Brian; card spending counted, own transfers not
  const savingsRate = health.find((h) => h.key === "savings_rate")?.value ?? sum.savingsRate;
  const hasTrend = trend.rows.filter((r) => r.actual !== undefined).length > 1;

  const header = <PageHeader title="Analytics" sub="How the money moved over the last six months." />;
  if (!fin.ready) return <>{header}<AnalyticsSkeleton /></>;

  const netTone: Tone | undefined = avgNet === null ? undefined : avgNet < 0 ? "risk" : "good";
  const srTone: Tone | undefined = savingsRate === null ? undefined : savingsRate >= 15 ? "good" : savingsRate >= 5 ? "watch" : "risk";

  return (
    <>
      {header}
      <div className="grid grid-cols-12 gap-3">
        <StatCard
          className={BENTO.quarter}
          label="Net cash flow"
          value={avgNet === null ? "n/a" : <CountUp value={avgNet} format={(n) => usd(n, { sign: true })} />}
          tone={netTone}
          sub={fin.cashFlow ? "a month, last 90 days" : sum.months ? `a month, ${sum.months}-month average` : "Needs a completed month"}
        />
        <StatCard
          className={BENTO.quarter}
          label="Savings rate"
          value={savingsRate === null ? "n/a" : `${savingsRate.toFixed(1)}%`}
          tone={srTone}
          sub="of income kept after spending"
          info="What is left of a month's income after all spending, card purchases included, over the last 3 months. The same figure as the Household health card."
        />
        <StatCard
          className={BENTO.quarter}
          label="Debt-to-income"
          value={dti ? `${dti.value.toFixed(1)}%` : "n/a"}
          tone={dti?.status}
          sub="monthly debt payments vs gross income"
        />
        <StatCard
          className={BENTO.quarter}
          label="Recurring charges"
          value={spend.recurringCount}
          sub={spend.recurringCount ? <>about <span className="num">{usd(spend.recurringMonthly)}</span> a month</> : "none in the last 90 days"}
        />

        <Panel
          id="nw-trend"
          title="Net worth"
          sub={hasTrend ? <span className="num">{usd(nw.net)} today · {trend.change.abs >= 0 ? "+" : "−"}{usd(Math.abs(trend.change.abs))} in six months</span> : undefined}
          right={hasTrend ? <Delta value={trend.change.pct} /> : undefined}
          className={BENTO.hero}
        >
          {hasTrend ? <TrendChart model={trend} height={260} mobileHeight={220} /> : <Empty title="Not enough history yet">Net worth is drawn from transactions and appears after a few weeks of data.</Empty>}
        </Panel>

        <Panel
          id="cash-flow"
          title="Income vs expenses"
          sub={sum.avgIncome !== null && sum.avgExpenses !== null ? <span className="num">{usd(sum.avgIncome)} in · {usd(sum.avgExpenses)} out, a month</span> : "Checking and savings, by month"}
          className={BENTO.hero}
        >
          {cash.length ? <CashFlowChart months={cash} height={260} /> : <Empty title="No cash flow yet">Income and expenses appear once checking or savings activity is available.</Empty>}
        </Panel>

        <Panel
          id="spend-cat"
          title="Spending by category"
          sub={spend.total ? <span className="num">Last 90 days · {usd(spend.total)}</span> : "Last 90 days"}
          className={BENTO.half}
        >
          {spend.categories.length ? (
            <>
              <BarList
                label="Spending by category, last 90 days"
                items={spend.categories.map((c) => ({
                  key: c.category,
                  label: categoryLabel(c.category),
                  value: c.value,
                  display: <>{usd(c.value)}<span className="ml-2 inline-block w-9 text-right text-caption font-normal text-ink-3">{share(c.share)}</span></>,
                }))}
              />
              <p className="mt-4 text-caption text-ink-3">Transfers, savings, card and loan payments and the mortgage are left out.</p>
            </>
          ) : (
            <Empty title="No spending in the last 90 days">Purchases show up here by category.</Empty>
          )}
        </Panel>

        <Panel id="merchants" title="Top merchants" sub="Last 90 days, by total spent" className={BENTO.half} flush>
          {spend.merchants.length ? (
            <TableScroll className="!mx-0 !px-0">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col" className="!pl-4">Merchant</th>
                    <th scope="col" className="r">Txns</th>
                    <th scope="col" className="r !pr-4">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {spend.merchants.map((m) => (
                    <tr key={m.merchant}>
                      <td className="!pl-4"><span className="font-medium">{m.merchant}</span><span className="block text-caption text-ink-3">{categoryLabel(m.category)}</span></td>
                      <td className="r num">{m.count}</td>
                      <td className="r num whitespace-nowrap !pr-4 font-semibold">{usd(m.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          ) : (
            <div className="px-4 pb-3"><Empty title="No merchants yet">The places you spend the most appear here.</Empty></div>
          )}
        </Panel>
      </div>
    </>
  );
}
