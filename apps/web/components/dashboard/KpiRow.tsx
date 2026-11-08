"use client";
import { Sparkline } from "@/components/charts/Sparkline";
import { CountUp } from "@/components/motion";
import { Delta, StatCard } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { shortDate, usd } from "@/lib/format";

/**
 * The headline numbers, each shown once: net worth (the hero, with what it is made of and six months of trend), monthly
 * cash flow, and the lowest cash balance the 90-day forecast reaches. The health score lives on its own card.
 */
const T = "col-span-6 md:col-span-3 xl:col-span-2";

export function KpiTiles({ fin, householdId }: { fin: RoomFinance; householdId: string }) {
  const { nw, trend, history, flow, forecast } = fin;
  const low = forecast.low_point;
  const lowTone = !low ? undefined : low.balance < 0 ? "risk" : low.balance < 3000 ? "watch" : undefined;
  return (
    <>
      <StatCard
        className="col-span-12 xl:col-span-4"
        size="lg"
        label="Net worth"
        info="Everything you own minus everything you owe. Home and vehicle values are estimates on file."
        value={<CountUp value={nw.net} format={(n) => usd(n)} />}
        delta={history.length > 1 ? <Delta value={trend.change.pct} text={`${trend.change.pct >= 0 ? "+" : ""}${trend.change.pct.toFixed(1)}% in 6 mo`} /> : undefined}
        sub={<span className="num">{usd(nw.assets, { compact: true })} assets · {usd(nw.liabilities, { compact: true })} owed</span>}
        chart={<Sparkline values={history.map((h) => h.value)} width={150} height={52} color="var(--chart-1)" label="Net worth over the last six months" />}
      />
      <StatCard className={T} label="Total assets" value={<CountUp value={nw.assets} format={(n) => usd(n, { compact: true })} />} tone="good" sub={`${fin.accounts.length} accounts`} />
      <StatCard className={T} label="Total liabilities" value={<CountUp value={nw.liabilities} format={(n) => usd(n, { compact: true })} />} tone={nw.liabilities > nw.assets * 0.5 ? "watch" : undefined} sub="loans and cards" />
      <StatCard
        className={T}
        href={`/room/${householdId}/analytics`}
        label="Cash flow"
        value={<CountUp value={flow.value} format={(n) => usd(n, { sign: true })} />}
        tone={flow.value < 0 ? "risk" : "good"}
        sub={`a month${flow.basis > 1 ? `, ${flow.basis}-mo avg` : ""}`}
      />
      <StatCard
        className={T}
        href={`/room/${householdId}/picture?tab=bills`}
        label="Forecast low"
        value={low ? <CountUp value={low.balance} format={(n) => usd(n, { compact: true })} /> : "—"}
        tone={lowTone}
        sub={low ? <>cash, <span className="num">{shortDate(low.date)}</span></> : "No forecast yet"}
      />
    </>
  );
}
