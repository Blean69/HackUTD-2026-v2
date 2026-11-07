"use client";
import { Chip, SectionTitle, type Tone } from "@/components/ui";
import { cx, metric, usd } from "@/lib/format";
import type { HealthIndicator, HealthStatus } from "@/lib/types";

const TONE: Record<HealthStatus, { tone: Tone; label: string; bar: string }> = {
  good: { tone: "good", label: "Good", bar: "bg-good" },
  watch: { tone: "watch", label: "Watch", bar: "bg-watch" },
  risk: { tone: "risk", label: "At risk", bar: "bg-risk" },
};

export function HealthCards({ items }: { items: readonly HealthIndicator[] }) {
  const counts = { good: 0, watch: 0, risk: 0 };
  for (const i of items) counts[i.status]++;
  return (
    <section aria-labelledby="health-h">
      <SectionTitle
        id="health-h"
        title="Financial health"
        sub={items.length ? `${counts.good} good · ${counts.watch} to watch · ${counts.risk} at risk` : undefined}
      />
      <ul className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
        {items.map((h) => {
          const t = TONE[h.status];
          return (
            <li key={h.id} className="relative overflow-hidden rounded-2xl border border-line bg-surface p-3.5 pl-4 shadow-card">
              <span className={cx("absolute inset-y-0 left-0 w-1.5", t.bar)} aria-hidden="true" />
              <div className="flex items-start justify-between gap-2">
                <p className="text-[0.78rem] font-medium leading-tight text-ink-2">{h.label}</p>
                <Chip tone={t.tone}>{t.label}</Chip>
              </div>
              <p className="num mt-1.5 font-display text-[1.75rem] font-bold leading-none tracking-tight">{h.key === "net_worth_trend" ? usd(h.value, { sign: true }) : metric(h.value, h.unit)}</p>
              <p className="mt-2 text-[0.78rem] leading-snug text-ink-2">{h.explanation}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
