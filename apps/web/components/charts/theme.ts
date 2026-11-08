import { usd } from "@/lib/format";

/**
 * Chart theme (docs/design-system.md §8). Spread these into Recharts so every chart shares one look:
 *   <CartesianGrid {...chartTheme.grid} />  <XAxis {...chartTheme.axisX} />  <YAxis {...chartTheme.axisY} />
 *   <Tooltip cursor={chartTheme.cursorLine} content={...ChartTooltip...} />
 * Colours are CSS variables, so both themes work without re-rendering.
 */

/** Categorical order, fixed (validated for colour-vision deficiency in both themes). Never cycle; fold extras into "Other". */
export const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"] as const;
export const MUTED = "var(--chart-muted)";

const tick = { fontSize: 11, fill: "var(--ink-3)" };

export const chartTheme = {
  grid: { vertical: false, stroke: "var(--chart-grid)", strokeWidth: 1 },
  axisX: { tick, tickLine: false, axisLine: { stroke: "var(--chart-axis)" }, tickMargin: 8, minTickGap: 18 },
  axisY: { tick, tickLine: false, axisLine: false, tickMargin: 6, width: 48 },
  /** Line and area charts: a hairline crosshair. */
  cursorLine: { stroke: "var(--ink-3)", strokeWidth: 1, strokeDasharray: "2 3" },
  /** Bar charts: a soft band behind the hovered group. */
  cursorBand: { fill: "var(--surface-3)", fillOpacity: 0.7 },
  /** Marker for the active point: series fill with a 2-px surface ring. */
  activeDot: (color: string) => ({ r: 4.5, fill: color, stroke: "var(--surface)", strokeWidth: 2 }),
  tickUsd: (v: number) => usd(v, { compact: true }),
  margin: { top: 10, right: 8, left: 0, bottom: 0 },
} as const;
