"use client";
import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { longDate, usd } from "@/lib/format";
import type { TrendModel, TrendRow } from "@/lib/finance";
import { ChartLegend, ChartTooltip, type TooltipRow } from "./parts";
import { chartTheme } from "./theme";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });
const monthOf = (d: string) => MONTH.format(new Date(`${d}T12:00:00`));
const C = "var(--chart-1)";

type Row = TrendRow & { range?: [number, number] };

function Tip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const rows: TooltipRow[] = [];
  if (p.actual !== undefined) rows.push({ label: "Net worth", value: usd(p.actual), color: C, kind: "line", strong: true });
  else {
    if (p.forecast !== undefined) rows.push({ label: "Forecast", value: usd(p.forecast), color: C, kind: "dash", strong: true });
    if (p.best !== undefined) rows.push({ label: "Best case", value: usd(p.best), color: C, kind: "band" });
    if (p.worst !== undefined) rows.push({ label: "Worst case", value: usd(p.worst), color: C, kind: "band" });
  }
  return <ChartTooltip title={longDate(p.date)} rows={rows} note={p.actual === undefined ? "Estimate from the 90-day forecast" : undefined} />;
}

/** Net worth: derived history (solid line on a faint wash), the 90-day forecast (dashed) inside its best-to-worst range band. */
/** `height` is the size from `sm` up; `mobileHeight` below it. One chart is mounted either way. */
export function TrendChart({ model, height = 260, mobileHeight }: { model: TrendModel; height?: number; mobileHeight?: number }) {
  const rows = useMemo<Row[]>(
    () => model.rows.map((r) => (r.best !== undefined && r.worst !== undefined ? { ...r, range: [Math.min(r.worst, r.best), Math.max(r.worst, r.best)] } : r)),
    [model.rows],
  );
  if (rows.length < 2) return <div className="skeleton" style={{ height: mobileHeight ?? height }} aria-busy="true" />;
  const ticks: string[] = [];
  let lastMonth = "";
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    if (m !== lastMonth) {
      ticks.push(r.date);
      lastMonth = m;
    }
  }
  const todayRow = rows.find((r) => r.date === model.today);
  const hasForecast = rows.some((r) => r.forecast !== undefined);
  const summary = `Net worth ${usd(todayRow?.actual ?? 0)} today${model.forecastEnd !== undefined ? `, forecast ${usd(model.forecastEnd)} in 90 days (estimate)` : ""}.`;
  return (
    <div>
      <ChartLegend
        items={[
          { label: "Actual", color: C, kind: "line" },
          ...(hasForecast ? [{ label: "90-day forecast", color: C, kind: "dash" as const }, { label: "Best to worst case", color: C, kind: "band" as const }] : []),
        ]}
      />
      <div style={{ ["--h" as string]: `${mobileHeight ?? height}px`, ["--hd" as string]: `${height}px` }} className="h-[var(--h)] sm:h-[var(--hd)]" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={rows} margin={{ ...chartTheme.margin, top: 16, right: 10 }}>
            <CartesianGrid {...chartTheme.grid} />
            <XAxis dataKey="date" ticks={ticks} tickFormatter={monthOf} {...chartTheme.axisX} interval={0} minTickGap={0} />
            <YAxis tickFormatter={chartTheme.tickUsd} {...chartTheme.axisY} width={52} domain={["auto", "auto"]} tickCount={5} />
            <Tooltip content={<Tip />} cursor={chartTheme.cursorLine} isAnimationActive={false} />
            <Area type="monotone" dataKey="range" stroke="none" fill={C} fillOpacity={0.12} isAnimationActive={false} connectNulls activeDot={false} />
            <Area type="monotone" dataKey="actual" stroke={C} strokeWidth={2} fill={C} fillOpacity={0.07} dot={false} activeDot={chartTheme.activeDot(C)} isAnimationActive={false} connectNulls={false} />
            <Line type="monotone" dataKey="forecast" stroke={C} strokeWidth={2} strokeDasharray="4 4" dot={false} activeDot={chartTheme.activeDot(C)} isAnimationActive={false} connectNulls />
            <ReferenceLine x={model.today} stroke="var(--ink-3)" strokeOpacity={0.6} strokeDasharray="2 3" label={{ value: "Today", position: "top", fill: "var(--ink-3)", fontSize: 10, offset: 6 }} />
            {todayRow?.actual !== undefined ? <ReferenceDot x={model.today} y={todayRow.actual} r={4.5} fill={C} stroke="var(--surface)" strokeWidth={2} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
