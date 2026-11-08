/** Chart primitives (docs/design-system.md §8). Recharts-based charts are the lazy exports, loaded after first paint. */
export { BarList, type BarItem } from "./BarList";
export { CashFlowChart, ScenarioChart, TrendChart } from "./lazy";
export { ChartLegend, ChartTooltip, Swatch, type LegendItem, type SwatchKind, type TooltipRow } from "./parts";
export { CREDIT_BANDS, HEALTH_BANDS, ScoreGauge, type GaugeBand } from "./ScoreGauge";
export { Sparkline } from "./Sparkline";
export { chartTheme, MUTED, SERIES } from "./theme";
