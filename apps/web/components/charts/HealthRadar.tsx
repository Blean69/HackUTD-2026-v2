"use client";
import { PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Text } from "recharts";

/**
 * Short spoke names. The full labels are in the list under the chart and in the chart's summary; a spoke only needs to
 * say which indicator it is, and long ones ("Lowest balance, next 90 d") ran past the card's edge.
 */
const SHORT: Record<string, string> = {
  liquidity_runway: "Runway",
  debt_to_income: "Debt load",
  credit_utilization: "Card use",
  savings_rate: "Savings",
  net_worth_trend: "Net worth",
  emergency_fund: "Emergency",
  forecast_low_point: "Low point",
  credit_score: "Credit",
};
const spoke = (r: { key: string; label: string }) => SHORT[r.key] ?? r.label.replace(/\s*\(.*?\)\s*$/, "").replace(/,.*$/, "");

/** Width a spoke label wraps at; the side margin leaves room for it, the vertical one for two lines above and below. */
const TICK_W = 52;
const SIDE = TICK_W + 4;
const V_PAD = 30;

interface TickProps {
  x: number | string;
  y: number | string;
  textAnchor?: "start" | "middle" | "end" | "inherit";
  verticalAnchor?: "start" | "middle" | "end";
  payload: { value: unknown };
}

/** A spoke label that wraps at word breaks instead of running past the card. */
function SpokeTick({ x, y, textAnchor, verticalAnchor, payload }: TickProps) {
  return (
    <Text x={x} y={y} textAnchor={textAnchor} verticalAnchor={verticalAnchor} width={TICK_W} fontSize={10} lineHeight={11} fill="var(--ink-3)">
      {String(payload.value)}
    </Text>
  );
}

/**
 * The household's indicators as a radar: one spoke per indicator, 0 to 100. The side margins keep the spoke labels inside
 * the card, so in a narrow card the radius is set by the width; the default height follows the width of the nearest
 * `@container` (falling back to 190 px), so a narrow card does not get a tall empty band around a small radar.
 */
export function HealthRadar({ rows, height = `clamp(120px, calc(100cqi - ${2 * SIDE - 2 * V_PAD}px), 190px)` }: { rows: { key: string; label: string; score: number }[]; height?: number | string }) {
  const summary = rows.map((r) => `${r.label} ${r.score}`).join(", ");
  const data = rows.map((r) => ({ ...r, spoke: spoke(r) }));
  return (
    <div role="img" aria-label={`Health indicators: ${summary}`} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="100%" margin={{ top: V_PAD, bottom: V_PAD, left: SIDE, right: SIDE }}>
          <PolarGrid stroke="var(--chart-grid)" />
          <PolarAngleAxis dataKey="spoke" tick={(p: TickProps) => <SpokeTick {...p} />} />
          <Radar dataKey="score" stroke="var(--chart-1)" strokeWidth={2} fill="var(--chart-1)" fillOpacity={0.22} isAnimationActive animationDuration={900} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
