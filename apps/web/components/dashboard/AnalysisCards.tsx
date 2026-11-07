"use client";
import Link from "next/link";
import { CashFlowChart } from "@/components/charts/CashFlowChart";
import { Donut } from "@/components/charts/Donut";
import { RadarChart } from "@/components/charts/RadarChart";
import { RingGauge } from "@/components/charts/RingGauge";
import { TrendChart } from "@/components/charts/TrendChart";
import { Chip, Panel, Progress, TONE_TEXT } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { cx, pct, usd } from "@/lib/format";

export function TrendCard({ fin, rangeLabel, className }: { fin: RoomFinance; rangeLabel: string; className?: string }) {
  return (
    <Panel
      id="net-worth-trend"
      title="Net Worth Trend & Forecast"
      info="History is rebuilt from your transactions. The forward line follows the 90-day cash forecast; best and worst cases are estimates."
      sub={`${rangeLabel} of history (as available), then 90 days ahead`}
      className={className}
    >
      <TrendChart model={fin.trend} height={270} mobileHeight={220} />
    </Panel>
  );
}

export function AllocationCard({ fin, className }: { fin: RoomFinance; className?: string }) {
  const total = fin.allocation.reduce((s, x) => s + x.value, 0);
  return (
    <Panel id="asset-allocation" title="Asset Allocation" info="Where your assets sit. Home and vehicle values are estimates on file." className={className}>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center 2xl:flex-col">
        <Donut slices={fin.allocation} centerLabel={usd(total, { compact: true })} centerSub="Total Assets" size={168} />
        <ul className="w-full max-w-xs space-y-2 text-[0.8rem] sm:w-auto sm:max-w-none 2xl:w-full">
          {fin.allocation.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-ink-2">{s.label}</span>
              <span className="num font-semibold">{total ? ((s.value / total) * 100).toFixed(1) : "0.0"}%</span>
            </li>
          ))}
          {!fin.allocation.length ? <li className="text-ink-3">No assets on file yet.</li> : null}
        </ul>
      </div>
    </Panel>
  );
}

const STATUS_TONE = { good: "good", watch: "watch", risk: "risk" } as const;

export function HealthCard({ fin, className }: { fin: RoomFinance; className?: string }) {
  const hm = fin.healthModel;
  return (
    <Panel
      id="financial-health"
      title="Financial Health"
      info="Each indicator is computed inside the database from your accounts, transactions and credit profile, then scored 0 to 100."
      className={className}
      right={
        hm.score !== null ? (
          <div className={cx("rounded-md px-2.5 py-1 text-center", hm.tone === "good" ? "bg-good-soft text-good" : hm.tone === "watch" ? "bg-watch-soft text-watch" : "bg-risk-soft text-risk")}>
            <p className="num text-[1.05rem] font-semibold leading-tight">{hm.score}<span className="text-[0.7rem] font-medium opacity-80"> / 100</span></p>
            <p className="text-[0.7rem] font-semibold leading-tight">{hm.label}</p>
          </div>
        ) : null
      }
    >
      <div className="@container">
        <div className="flex flex-col gap-4 @lg:flex-row @lg:items-center">
          <div className="min-w-0 flex-1">
            <RadarChart axes={hm.axes} size={230} />
            <p className="mt-1 flex items-center justify-center gap-4 text-[0.7rem] text-ink-3" aria-hidden="true">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-[var(--c2)]" /> Household</span>
              <span className="flex items-center gap-1.5"><span className="w-3.5 border-t border-dashed border-ink-3" /> Healthy line (70)</span>
            </p>
          </div>
          <ul className="space-y-2 @lg:w-52" aria-label="Indicator scores">
            {hm.rows.map((r) => (
              <li key={r.key} title={r.explanation}>
                <div className="flex items-baseline justify-between gap-2 text-[0.76rem]">
                  <span className="truncate text-ink-2">{r.label}</span>
                  <span className={cx("num font-semibold", TONE_TEXT[STATUS_TONE[r.status]])}>{r.score}</span>
                </div>
                <Progress value={r.score} tone={STATUS_TONE[r.status]} label={`${r.label}: ${r.score} out of 100`} height="h-1" className="mt-0.5" />
              </li>
            ))}
            {!hm.rows.length ? <li className="text-[0.8rem] text-ink-3">Indicators are being calculated.</li> : null}
          </ul>
        </div>
      </div>
    </Panel>
  );
}

export function CashFlowCard({ fin, className }: { fin: RoomFinance; className?: string }) {
  return (
    <Panel
      id="cash-flow"
      title="Cash Flow Forecast"
      info="Past months come from checking and savings activity. Later months project recent income against your obligation schedule plus usual spending (est.)."
      className={className}
    >
      <CashFlowChart months={fin.cash} height={230} />
    </Panel>
  );
}

const toneOf = (s: "good" | "watch" | "risk"): "good" | "watch" | "risk" => s;

export function DebtCard({ fin, className }: { fin: RoomFinance; className?: string }) {
  const { debt } = fin;
  const dti = debt.ratios[0];
  return (
    <Panel id="debt-profile" title="Debt Profile & Ratios" info="Ratios lenders look at. Thresholds: debt-to-income 36%, utilization 30%, loan-to-value 80%." className={className}>
      <div className="flex flex-col items-center gap-4 sm:flex-row 2xl:flex-col 2xl:items-center">
        <RingGauge value={dti.value ?? 0} max={60} label={dti.value === null ? "—" : `${Math.round(dti.value)}%`} sub="Debt-to-Income" tone={toneOf(dti.status)} size={124} />
        <dl className="w-full min-w-0 flex-1 text-[0.8rem]">
          {debt.ratios.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-2 border-b border-line py-1.5 first:pt-0">
              <dt className="min-w-0 truncate text-ink-2" title={r.hint}>{r.label}</dt>
              <dd className={cx("num font-semibold", r.value === null ? "text-ink-3" : r.status === "good" ? "" : TONE_TEXT[toneOf(r.status)])}>{r.value === null ? "—" : pct(r.value)}</dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 border-b border-line py-1.5">
            <dt className="text-ink-2">Total Debt</dt>
            <dd className="num font-semibold">{usd(debt.totalDebt)}</dd>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1.5">
            <dt className="text-ink-2">Monthly Debt Payments</dt>
            <dd className="num font-semibold">{usd(debt.monthlyPayments)}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}

export function EstChip({ children = "est." }: { children?: string }) {
  return <Chip title="An estimate derived from the data we have">{children}</Chip>;
}

export function ViewAll({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className="text-[0.78rem] font-semibold text-brand-strong hover:underline">
      {children} →
    </Link>
  );
}
