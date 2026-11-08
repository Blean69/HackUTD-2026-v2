"use client";
import { PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer } from "recharts";

/** The household's indicators as a radar: one spoke per indicator, 0 to 100. */
export function HealthRadar({ rows, height = 190 }: { rows: { key: string; label: string; score: number }[]; height?: number }) {
  const summary = rows.map((r) => `${r.label} ${r.score}`).join(", ");
  return (
    <div role="img" aria-label={`Health indicators: ${summary}`} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={rows} outerRadius="68%">
          <PolarGrid stroke="var(--chart-grid)" />
          <PolarAngleAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--ink-3)" }} />
          <Radar dataKey="score" stroke="var(--chart-1)" strokeWidth={2} fill="var(--chart-1)" fillOpacity={0.22} isAnimationActive animationDuration={900} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
