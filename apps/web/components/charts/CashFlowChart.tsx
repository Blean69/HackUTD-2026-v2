"use client";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { usd } from "@/lib/format";
import type { CashMonth } from "@/lib/finance";

function Tip({ active, payload }: { active?: boolean; payload?: { payload: CashMonth }[] }) {
  if (!active || !payload?.length) return null;
  const m = payload[0].payload;
  return (
    <div className="rounded-md border border-line-strong bg-surface px-3 py-2 text-[0.78rem]">
      <p className="font-semibold">{m.label}{m.forecast ? " (forecast)" : ""}</p>
      <p className="num text-ink-2">Income: <span className="font-semibold text-ink">{usd(m.income)}</span></p>
      <p className="num text-ink-2">Expenses: <span className="font-semibold text-ink">{usd(m.expenses)}</span></p>
      <p className="num text-ink-2">Net: <span className={m.net >= 0 ? "font-semibold text-good" : "font-semibold text-risk"}>{usd(m.net, { sign: true })}</span></p>
    </div>
  );
}

/** Monthly income and expense bars with a net cash-flow line. Forecast months are lighter. */
export function CashFlowChart({ months, height = 220 }: { months: readonly CashMonth[]; height?: number }) {
  if (!months.length) return <div className="skeleton" style={{ height }} aria-busy="true" />;
  const firstForecast = months.find((m) => m.forecast);
  const summary = months.map((m) => `${m.label}${m.forecast ? " forecast" : ""}: income ${usd(m.income)}, expenses ${usd(m.expenses)}`).join("; ");
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.72rem] text-ink-2" aria-hidden="true">
        <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[var(--c1)]" /> Income</li>
        <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[var(--c3)]" /> Expenses</li>
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-ink" /> Net cash flow</li>
        {firstForecast ? <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border border-line-strong bg-surface-2" /> Projected</li> : null}
      </ul>
      <div style={{ height }} role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={months as CashMonth[]} margin={{ top: 8, right: 6, left: 0, bottom: 0 }} barGap={1} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--ink-3)" }} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} interval={0} />
            <YAxis tickFormatter={(v: number) => usd(v, { compact: true })} tick={{ fontSize: 11, fill: "var(--ink-3)" }} tickLine={false} axisLine={false} width={44} />
            <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
            {firstForecast ? <ReferenceLine x={firstForecast.label} stroke="var(--line-strong)" strokeDasharray="3 3" /> : null}
            <Bar dataKey="income" fill="var(--c1)" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {months.map((m) => <Cell key={m.key} fillOpacity={m.forecast ? 0.5 : 1} />)}
            </Bar>
            <Bar dataKey="expenses" fill="var(--c3)" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {months.map((m) => <Cell key={m.key} fillOpacity={m.forecast ? 0.55 : 1} />)}
            </Bar>
            <Line type="monotone" dataKey="net" stroke="var(--ink)" strokeWidth={1.75} dot={{ r: 3, fill: "var(--surface)", stroke: "var(--ink)", strokeWidth: 1.5 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
