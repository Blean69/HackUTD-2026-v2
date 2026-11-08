"use client";
import { Sparkline } from "@/components/charts/Sparkline";
import { CountUp } from "@/components/motion";
import { Card, Chip, Delta, InfoTip } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { cx, shortDate, usd } from "@/lib/format";

function Label({ children, info }: { children: string; info?: string }) {
  return (
    <p className="flex items-center gap-1.5 text-[0.82rem] font-semibold text-ink">
      {children}
      {info ? <InfoTip text={info} label={children} /> : null}
    </p>
  );
}

/**
 * Four headline numbers, each shown once on the Dashboard: net worth (with what it is made of), monthly cash flow,
 * the health score, and the lowest cash balance the 90-day forecast reaches. Everything is derived from the household's rows.
 */
export function KpiRow({ fin }: { fin: RoomFinance }) {
  const { nw, trend, history, flow, forecast, healthModel: hm } = fin;
  const low = forecast.low_point;
  const lowTone = !low ? "" : low.balance < 0 ? "text-risk" : low.balance < 3000 ? "text-watch" : "";
  return (
    <section className="grid grid-cols-3 gap-2.5 sm:gap-3 lg:grid-cols-[1.6fr_1fr_1fr_1fr]" aria-label="Key figures">
      <Card className="col-span-3 p-4 lg:col-span-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label info="Everything you own minus everything you owe. Home and vehicle values are estimates on file.">Net worth</Label>
            <p className="num mt-1 text-[1.9rem] font-semibold leading-none tracking-tight"><CountUp value={nw.net} format={(n) => usd(n)} /></p>
            <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              {history.length > 1 ? <Delta value={trend.change.pct} text={`${trend.change.pct >= 0 ? "+" : ""}${trend.change.pct.toFixed(1)}%`} /> : null}
              <span className="num text-[0.78rem] text-ink-3">{usd(nw.assets, { compact: true })} assets · {usd(nw.liabilities, { compact: true })} owed</span>
            </p>
          </div>
          <div className="hidden w-28 shrink-0 sm:block xl:w-36">
            <Sparkline values={history.map((h) => h.value)} width={140} height={48} label="Net worth over the last six months" />
          </div>
        </div>
      </Card>

      <Card className="p-3 sm:p-4">
        <Label>Cash flow</Label>
        <p className={cx("num mt-1 text-[1.15rem] font-semibold leading-tight tracking-tight sm:text-[1.4rem]", flow.value < 0 && "text-risk")}><CountUp value={flow.value} format={(n) => usd(n, { sign: true })} /></p>
        <p className="mt-2 text-[0.76rem] leading-snug text-ink-3">a month{flow.basis > 1 ? `, ${flow.basis}-mo avg` : ""}</p>
      </Card>

      <Card className="p-3 sm:p-4">
        <Label>Health</Label>
        <p className="mt-1 flex items-baseline gap-1">
          <span className="num text-[1.5rem] font-semibold leading-none tracking-tight sm:text-[1.7rem]">{hm.score === null ? "—" : <CountUp value={hm.score} />}</span>
          <span className="text-[0.82rem] text-ink-3">/ 100</span>
        </p>
        <p className="mt-2"><Chip tone={hm.tone}>{hm.label}</Chip></p>
      </Card>

      <Card className="p-3 sm:p-4">
        <Label>Forecast low</Label>
        <p className={cx("num mt-1 text-[1.15rem] font-semibold leading-tight tracking-tight sm:text-[1.4rem]", lowTone)}>{low ? <CountUp value={low.balance} format={(n) => usd(n)} /> : "—"}</p>
        <p className="mt-2 text-[0.76rem] leading-snug text-ink-3">{low ? <>cash, around <span className="num">{shortDate(low.date)}</span></> : "No forecast yet"}</p>
      </Card>
    </section>
  );
}
