import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/lib/format";

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  /** Formatted value shown at the right (defaults to `format(value)`). */
  display?: ReactNode;
  /** Bar colour; defaults to the accent. Pass a SERIES colour only when the same entity is coloured elsewhere on the page. */
  color?: string;
  sub?: ReactNode;
  href?: string;
}

/**
 * Ranked horizontal bars (spending by category, top merchants). Label and value in text colours above a thin bar,
 * so long names never collide with the mark; bars share one scale (`max`, or the largest value).
 */
export function BarList({ items, max, format = (n) => n.toLocaleString("en-US"), className, label }: { items: BarItem[]; max?: number; format?: (n: number) => string; className?: string; label?: string }) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={cx("space-y-3", className)} aria-label={label}>
      {items.map((it, i) => {
        const pct = Math.max(0, Math.min(1, it.value / top));
        const row = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-label">
              <span className="min-w-0 truncate text-ink">{it.label}</span>
              <span className="num shrink-0 font-medium text-ink">{it.display ?? format(it.value)}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
              <div className="bar-fill h-full rounded-full" style={{ transform: `scaleX(${pct})`, background: it.color ?? "var(--chart-1)" }} />
            </div>
            {it.sub ? <p className="mt-1 text-caption text-ink-3">{it.sub}</p> : null}
          </>
        );
        return (
          <li key={it.key} className="motion-fade" style={{ ["--i" as string]: i }}>
            {it.href ? (
              <Link href={it.href} className="-mx-2 block rounded-md px-2 py-1 transition-colors hover:bg-surface-2">
                {row}
              </Link>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}
