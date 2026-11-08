"use client";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { usd } from "@/lib/format";
import type { CashMonth } from "@/lib/finance";
import { ChartLegend, ChartTooltip } from "./parts";
import { chartTheme, SERIES } from "./theme";

const INCOME = SERIES[0];
const SPEND = SERIES[1];
const NET = "var(--ink)";

function Tip({ active, payload }: { active?: boolean; payload?: { payload: CashMonth }[] }) {
  if (!active || !payload?.length) return null;
  const m = payload[0].payload;
  return (
    <ChartTooltip
      title={`${m.label}${m.forecast ? " · projected" : ""}`}
      rows={[
        { label: "Income", value: usd(m.income), color: INCOME },
        { label: "Expenses", value: usd(m.expenses), color: SPEND },
        { label: "Net", value: usd(m.net, { sign: true }), color: NET, kind: "line", strong: true },
      ]}
    />
  );
}

/** Monthly income and expense columns with a net cash-flow line. Projected months are lighter, behind a "projected" marker. */
export function CashFlowChart({ months, height = 220 }: { months: readonly CashMonth[]; height?: number }) {
  if (!months.length) return <div className="skeleton" style={{ height }} aria-busy="true" />;
  const firstForecast = months.find((m) => m.forecast);
  const summary = months.map((m) => `${m.label}${m.forecast ? " forecast" : ""}: income ${usd(m.income)}, expenses ${usd(m.expenses)}`).join("; ");
  return (
    <div>
      <ChartLegend
        items={[
          { label: "Income", color: INCOME },
          { label: "Expenses", color: SPEND },
          { label: "Net cash flow", color: NET, kind: "line" },
          ...(firstForecast ? [{ label: "Projected (lighter)", color: "var(--chart-muted)", kind: "band" as const }] : []),
        ]}
      />
      <div style={{ height }} role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={months as CashMonth[]} margin={chartTheme.margin} barGap={2} barCategoryGap="24%">
            <CartesianGrid {...chartTheme.grid} />
            <XAxis dataKey="label" {...chartTheme.axisX} interval={0} minTickGap={0} />
            <YAxis tickFormatter={chartTheme.tickUsd} {...chartTheme.axisY} width={46} tickCount={5} />
            <Tooltip content={<Tip />} cursor={chartTheme.cursorBand} isAnimationActive={false} />
            <ReferenceLine y={0} stroke="var(--chart-axis)" />
            {firstForecast ? <ReferenceLine x={firstForecast.label} stroke="var(--ink-3)" strokeOpacity={0.6} strokeDasharray="2 3" label={{ value: "Projected", position: "insideTopLeft", fill: "var(--ink-3)", fontSize: 10, offset: 6 }} /> : null}
            <Bar dataKey="income" fill={INCOME} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false}>
              {months.map((m) => <Cell key={m.key} fillOpacity={m.forecast ? 0.4 : 1} />)}
            </Bar>
            <Bar dataKey="expenses" fill={SPEND} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false}>
              {months.map((m) => <Cell key={m.key} fillOpacity={m.forecast ? 0.4 : 1} />)}
            </Bar>
            <Line type="monotone" dataKey="net" stroke={NET} strokeWidth={2} dot={{ r: 3.5, fill: NET, stroke: "var(--surface)", strokeWidth: 2 }} activeDot={chartTheme.activeDot(NET)} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
