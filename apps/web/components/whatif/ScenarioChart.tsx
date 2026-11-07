"use client";
import { useMemo } from "react";
import { CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { longDate, shortDate, usd } from "@/lib/format";
import type { ScenarioResult } from "@/lib/types";

type Verdict = NonNullable<ScenarioResult["verdict"]>;
type Series = NonNullable<ScenarioResult["series"]>;

const LINE: Record<Verdict, string> = { fine: "var(--brand)", tight: "var(--watch)", risky: "var(--risk)" };

interface TipProps {
  active?: boolean;
  payload?: { payload: Series[number] }[];
}
function Tip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const diff = p.scenario - p.baseline;
  return (
    <div className="rounded-md border border-line-strong bg-surface px-3 py-2 text-[0.8rem]">
      <p className="font-semibold">{longDate(p.date)}</p>
      <p className="num text-ink-2">Baseline: <span className="font-semibold text-ink">{usd(p.baseline)}</span></p>
      <p className="num text-ink-2">With this change: <span className="font-semibold text-ink">{usd(p.scenario)}</span></p>
      <p className="num text-ink-3">{diff === 0 ? "No difference" : `${usd(diff, { sign: true })} vs baseline`}</p>
      {p.obligations_due && p.obligations_due > 0 ? <p className="num text-watch">Bills due: {usd(p.obligations_due)}</p> : null}
    </div>
  );
}

/**
 * Cash balance, baseline vs with-this-change, over the scenario window. Flat lines only (no fills or gradients):
 * the scenario line takes the verdict colour, the baseline is a grey dashed line, the low point is a red dot.
 */
export function ScenarioChart({
  series, lowPoint, verdict, height = 240,
}: {
  series: Series;
  lowPoint?: ScenarioResult["low_point"];
  verdict?: Verdict;
  height?: number;
}) {
  const stats = useMemo(() => {
    if (!series.length) return null;
    let baseLow = series[0];
    let scenLow = series[0];
    let below = false;
    for (const p of series) {
      if (p.baseline < baseLow.baseline) baseLow = p;
      if (p.scenario < scenLow.scenario) scenLow = p;
      if (p.baseline < 0 || p.scenario < 0) below = true;
    }
    return { baseLow, scenLow, below };
  }, [series]);
  if (!stats) return null;

  const low = lowPoint ?? { date: stats.scenLow.date, balance: stats.scenLow.scenario };
  const stroke = LINE[verdict ?? "fine"];
  const summary = `Cash balance with this change bottoms out at ${usd(low.balance)} on ${longDate(low.date)}. Without it, the baseline bottoms out at ${usd(stats.baseLow.baseline)} on ${longDate(stats.baseLow.date)}.`;

  return (
    <figure>
      <div style={{ height }} className="min-h-[200px]" role="img" aria-label={`Chart of cash balance, baseline versus with this change. ${summary}`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: "var(--ink-3)" }} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} minTickGap={36} />
            <YAxis tickFormatter={(v: number) => usd(v, { compact: true })} tick={{ fontSize: 11, fill: "var(--ink-3)" }} tickLine={false} axisLine={false} width={48} domain={["auto", "auto"]} />
            <Tooltip content={<Tip />} cursor={{ stroke: "var(--line-strong)" }} />
            {stats.below ? <ReferenceLine y={0} stroke="var(--risk)" strokeDasharray="4 4" strokeOpacity={0.7} /> : null}
            <Line type="monotone" dataKey="baseline" stroke="var(--ink-3)" strokeWidth={1.75} strokeDasharray="5 4" dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
            <Line type="monotone" dataKey="scenario" stroke={stroke} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            <ReferenceDot x={low.date} y={low.balance} r={5} fill="var(--risk)" stroke="var(--surface)" strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.74rem] text-ink-2">
          <li className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-ink-3" aria-hidden="true" /> Baseline</li>
          <li className="flex items-center gap-1.5"><span className="h-0.5 w-4" style={{ background: stroke }} aria-hidden="true" /> With this change</li>
          <li className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-risk" aria-hidden="true" /> Low point</li>
        </ul>
        <p className="sr-only">{summary}</p>
      </figcaption>
    </figure>
  );
}
