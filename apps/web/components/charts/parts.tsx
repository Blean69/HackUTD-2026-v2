import type { ReactNode } from "react";
import { cx } from "@/lib/format";

export type SwatchKind = "line" | "dash" | "bar" | "dot" | "band";

/** The little key next to a legend or tooltip label. Identity comes from this mark, never from coloured text. */
export function Swatch({ color, kind = "bar" }: { color: string; kind?: SwatchKind }) {
  if (kind === "line") return <span className="inline-block h-0.5 w-3.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />;
  if (kind === "dash") return <span className="inline-block w-3.5 shrink-0 border-t-2 border-dashed" style={{ borderColor: color }} aria-hidden="true" />;
  if (kind === "dot") return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />;
  if (kind === "band") return <span className="inline-block h-2.5 w-3.5 shrink-0 rounded-[3px] opacity-30" style={{ background: color }} aria-hidden="true" />;
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: color }} aria-hidden="true" />;
}

export interface LegendItem {
  label: ReactNode;
  color: string;
  kind?: SwatchKind;
}

/** Legend row above a chart (always present for two or more series). Decorative for screen readers: the chart has a summary. */
export function ChartLegend({ items, className }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={cx("mb-3 flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-2", className)} aria-hidden="true">
      {items.map((it, i) => (
        <li key={i} className="flex items-center gap-1.5">
          <Swatch color={it.color} kind={it.kind} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export interface TooltipRow {
  label: ReactNode;
  value: ReactNode;
  color?: string;
  kind?: SwatchKind;
  /** Emphasise this row's value (the one the chart is about). */
  strong?: boolean;
}

/** The one chart tooltip: a small floating card, title on top, aligned label/value rows, tabular values. */
export function ChartTooltip({ title, rows, note }: { title: ReactNode; rows: TooltipRow[]; note?: ReactNode }) {
  return (
    <div className="pop anim-pop-in min-w-[11rem] rounded-md px-3 py-2.5 text-caption">
      <p className="mb-1.5 font-medium text-ink-3">{title}</p>
      <ul className="space-y-1">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center justify-between gap-4">
            <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
              {r.color ? <Swatch color={r.color} kind={r.kind} /> : null}
              {r.label}
            </span>
            <span className={cx("num shrink-0 text-ink", r.strong ? "font-semibold" : "font-medium")}>{r.value}</span>
          </li>
        ))}
      </ul>
      {note ? <p className="mt-1.5 border-t border-line pt-1.5 text-ink-3">{note}</p> : null}
    </div>
  );
}
