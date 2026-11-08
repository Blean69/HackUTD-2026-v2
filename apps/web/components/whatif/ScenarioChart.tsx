"use client";
import { useMemo } from "react";
import { CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartLegend, ChartTooltip } from "@/components/charts/parts";
import { chartTheme } from "@/components/charts/theme";
import { longDate, shortDate, usd } from "@/lib/format";
import type { ScenarioResult } from "@/lib/types";

type Verdict = NonNullable<ScenarioResult["verdict"]>;
type Series = NonNullable<ScenarioResult["series"]>;

/** The scenario is series 1 (the accent); the baseline is the muted comparison series. Status lives in the verdict banner, not the line. */
const SCENARIO = "var(--chart-1)";
const BASELINE = "var(--chart-muted)";

interface TipProps {
  active?: boolean;
  payload?: { payload: Series[number] }[];
}
function Tip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const diff = p.scenario - p.baseline;
  return (
    <ChartTooltip
      title={longDate(p.date)}
      rows={[
        { label: "With this change", value: usd(p.scenario), color: SCENARIO, kind: "line", strong: true },
        { label: "Baseline", value: usd(p.baseline), color: BASELINE, kind: "dash" },
        ...(p.obligations_due && p.obligations_due > 0 ? [{ label: "Bills due", value: usd(p.obligations_due) }] : []),
      ]}
      note={diff === 0 ? "No difference" : `${usd(diff, { sign: true })} vs baseline`}
    />
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
  void verdict;
  const summary = `Cash balance with this change bottoms out at ${usd(low.balance)} on ${longDate(low.date)}. Without it, the baseline bottoms out at ${usd(stats.baseLow.baseline)} on ${longDate(stats.baseLow.date)}.`;

  return (
    <figure>
      <div style={{ height }} className="min-h-[200px]" role="img" aria-label={`Chart of cash balance, baseline versus with this change. ${summary}`}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={series} margin={chartTheme.margin}>
            <CartesianGrid {...chartTheme.grid} />
            <XAxis dataKey="date" tickFormatter={shortDate} {...chartTheme.axisX} minTickGap={36} />
            <YAxis tickFormatter={chartTheme.tickUsd} {...chartTheme.axisY} domain={["auto", "auto"]} />
            <Tooltip content={<Tip />} cursor={chartTheme.cursorLine} />
            {stats.below ? <ReferenceLine y={0} stroke="var(--risk)" strokeDasharray="4 4" strokeOpacity={0.7} /> : null}
            <Line type="monotone" dataKey="baseline" stroke={BASELINE} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={chartTheme.activeDot(BASELINE)} isAnimationActive={false} />
            <Line type="monotone" dataKey="scenario" stroke={SCENARIO} strokeWidth={2} dot={false} activeDot={chartTheme.activeDot(SCENARIO)} isAnimationActive={false} />
            <ReferenceDot x={low.date} y={low.balance} r={5} fill="var(--risk)" stroke="var(--surface)" strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption>
        <ChartLegend
          className="mb-0 mt-2"
          items={[
            { label: "With this change", color: SCENARIO, kind: "line" },
            { label: "Baseline", color: BASELINE, kind: "dash" },
            { label: "Low point", color: "var(--risk)", kind: "dot" },
          ]}
        />
        <p className="sr-only">{summary}</p>
      </figcaption>
    </figure>
  );
}
