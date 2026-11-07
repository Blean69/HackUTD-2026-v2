"use client";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { longDate, usd } from "@/lib/format";
import type { TrendModel, TrendRow } from "@/lib/finance";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });
const monthOf = (d: string) => MONTH.format(new Date(`${d}T12:00:00`));

function Tip({ active, payload }: { active?: boolean; payload?: { payload: TrendRow }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const isForecast = p.actual === undefined;
  return (
    <div className="rounded-md border border-line-strong bg-surface px-3 py-2 text-[0.78rem]">
      <p className="font-semibold">{longDate(p.date)}</p>
      {p.actual !== undefined ? <p className="num text-ink-2">Net worth: <span className="font-semibold text-ink">{usd(p.actual)}</span></p> : null}
      {isForecast && p.forecast !== undefined ? <p className="num text-ink-2">Forecast (est.): <span className="font-semibold text-ink">{usd(p.forecast)}</span></p> : null}
      {isForecast && p.best !== undefined ? <p className="num text-good">Best case: {usd(p.best)}</p> : null}
      {isForecast && p.worst !== undefined ? <p className="num text-risk">Worst case: {usd(p.worst)}</p> : null}
    </div>
  );
}

/** Net worth: derived history (solid), 90-day forecast (dashed) and best / worst bands. */
/** `height` is the size from `sm` up; `mobileHeight` below it. One chart is mounted either way. */
export function TrendChart({ model, height = 260, mobileHeight }: { model: TrendModel; height?: number; mobileHeight?: number }) {
  const rows = model.rows;
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
  const summary = `Net worth ${usd(todayRow?.actual ?? 0)} today${model.forecastEnd !== undefined ? `, forecast ${usd(model.forecastEnd)} in 90 days (estimate)` : ""}.`;
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.72rem] text-ink-2" aria-hidden="true">
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-[var(--c1)]" /> Actual</li>
        <li className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-[var(--c2)]" /> Forecast</li>
        <li className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dotted border-[var(--c3)]" /> Best case ({model.bestPct >= 0 ? "+" : ""}{model.bestPct.toFixed(0)}%, est.)</li>
        <li className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dotted border-risk" /> Worst case ({model.worstPct >= 0 ? "+" : ""}{model.worstPct.toFixed(0)}%, est.)</li>
      </ul>
      <div style={{ ["--h" as string]: `${mobileHeight ?? height}px`, ["--hd" as string]: `${height}px` }} className="h-[var(--h)] sm:h-[var(--hd)]" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={rows} margin={{ top: 14, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="date" ticks={ticks} tickFormatter={monthOf} tick={{ fontSize: 11, fill: "var(--ink-3)" }} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} interval={0} />
            <YAxis tickFormatter={(v: number) => usd(v, { compact: true })} tick={{ fontSize: 11, fill: "var(--ink-3)" }} tickLine={false} axisLine={false} width={52} domain={["auto", "auto"]} />
            <Tooltip content={<Tip />} cursor={{ stroke: "var(--line-strong)" }} />
            <Area type="monotone" dataKey="actual" stroke="var(--c1)" strokeWidth={2.25} fill="var(--c3)" fillOpacity={0.16} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} />
            <Line type="monotone" dataKey="forecast" stroke="var(--c2)" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="best" stroke="var(--c3)" strokeWidth={1.75} strokeDasharray="2 4" dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="worst" stroke="var(--risk)" strokeOpacity={0.75} strokeWidth={1.75} strokeDasharray="2 4" dot={false} isAnimationActive={false} connectNulls />
            <ReferenceLine x={model.today} stroke="var(--ink-3)" strokeDasharray="3 3" />
            {todayRow?.actual !== undefined ? <ReferenceDot x={model.today} y={todayRow.actual} r={4.5} fill="var(--c1)" stroke="var(--surface)" strokeWidth={2} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
