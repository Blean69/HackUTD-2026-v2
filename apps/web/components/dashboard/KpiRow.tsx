"use client";
import { Sparkline } from "@/components/charts/Sparkline";
import { Card, Chip, Delta, InfoTip } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { usd } from "@/lib/format";

function Label({ children, info }: { children: string; info?: string }) {
  return (
    <p className="flex items-center gap-1.5 text-[0.82rem] font-semibold text-ink">
      {children}
      {info ? <InfoTip text={info} label={children} /> : null}
    </p>
  );
}

/** Five headline numbers. Everything is derived from the household's own rows; nothing here is hard-coded. */
export function KpiRow({ fin, rangeLabel }: { fin: RoomFinance; rangeLabel: string }) {
  const { nw, trend, history, flow, property, accounts, debt, healthModel: hm } = fin;
  const hasChange = history.length > 1;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-[1.7fr_1fr_1fr_1fr_1fr]" aria-label="Key figures">
      <Card className="col-span-2 p-4 lg:col-span-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label info="Everything you own minus everything you owe, including estimated home and vehicle value.">Net Worth</Label>
            <p className="num mt-1 text-[1.85rem] font-semibold leading-none tracking-tight sm:text-[2rem]">{usd(nw.net)}</p>
            {hasChange ? (
              <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Delta value={trend.change.pct} text={`${trend.change.pct >= 0 ? "+" : ""}${trend.change.pct.toFixed(1)}% (${usd(trend.change.abs, { sign: true })})`} />
                <span className="text-[0.74rem] text-ink-3">{rangeLabel.toLowerCase()}</span>
              </p>
            ) : null}
          </div>
          <div className="hidden w-32 shrink-0 sm:block lg:w-28 xl:w-36">
            <Sparkline values={history.map((h) => h.value)} width={140} height={48} label={`Net worth over ${rangeLabel.toLowerCase()}`} />
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <Label info="Cash, savings, CDs, retirement accounts and the estimated value of your home and vehicles.">Total Assets</Label>
        <p className="num mt-1 text-[1.4rem] font-semibold leading-tight tracking-tight">{usd(nw.assets)}</p>
        <p className="mt-2 text-[0.74rem] leading-snug text-ink-3">
          {property > 0 ? <>incl. <span className="num">{usd(property, { compact: true })}</span> home &amp; vehicles (est.)</> : <>{accounts.filter((a) => a.type !== "credit_card" && !["auto_loan", "personal_loan", "mortgage"].includes(a.type)).length} asset accounts</>}
        </p>
      </Card>

      <Card className="p-4">
        <Label info="Mortgage, auto and personal loans, and card balances.">Total Liabilities</Label>
        <p className="num mt-1 text-[1.4rem] font-semibold leading-tight tracking-tight">{usd(nw.liabilities)}</p>
        <p className="mt-2 text-[0.74rem] leading-snug text-ink-3"><span className="num">{usd(debt.monthlyPayments)}</span> a month in payments</p>
      </Card>

      <Card className="p-4">
        <Label info="Average of income minus cash spending over the last full months, from your checking and savings activity.">Monthly Cash Flow</Label>
        <p className={`num mt-1 text-[1.4rem] font-semibold leading-tight tracking-tight ${flow.value < 0 ? "text-risk" : ""}`}>{usd(flow.value, { sign: true })}</p>
        <p className="mt-2">
          {flow.change !== null ? <><Delta value={flow.change} text={usd(flow.change, { sign: true, compact: true })} /> <span className="text-[0.74rem] text-ink-3">vs prior {flow.basis} mo</span></> : <span className="text-[0.74rem] text-ink-3">{flow.basis > 1 ? `avg of last ${flow.basis} months` : "last full month"}</span>}
        </p>
      </Card>

      <Card className="p-4">
        <Label info="A 0 to 100 score blended from liquidity, savings, credit, debt, net worth trend, emergency fund and cash safety.">Household Health</Label>
        <p className="mt-1 flex items-baseline gap-1">
          <span className="num text-[1.7rem] font-semibold leading-none tracking-tight">{hm.score ?? "—"}</span>
          <span className="text-[0.9rem] text-ink-3">/ 100</span>
        </p>
        <p className="mt-2"><Chip tone={hm.tone === "neutral" ? "neutral" : hm.tone} className="!text-[0.78rem] !font-semibold">{hm.label}</Chip></p>
      </Card>
    </div>
  );
}
