"use client";
import Link from "next/link";
import { BandScale } from "@/components/credit/BandScale";
import { IconChevron } from "@/components/icons";
import { Panel, PanelLink, Skeleton } from "@/components/ui";
import { useCredit } from "@/lib/data/credit-hooks";
import { cx } from "@/lib/format";

const TONE_TEXT = { good: "text-good", watch: "text-watch", risk: "text-risk" } as const;

/** Compact credit monitoring: each scored member's number, band and change, linking to the Credit page. */
export function CreditTile({ householdId, className }: { householdId: string; className?: string }) {
  const credit = useCredit(householdId);
  const href = `/room/${householdId}/credit`;
  if (credit.ready && !credit.views.length) return null;
  return (
    <Panel id="credit-tile" title="Credit scores" sub="Simulated score for this demo" className={className} flush footer={<PanelLink href={href}>Credit monitoring</PanelLink>}>
      {!credit.ready ? (
        <div className="px-4 pb-3"><Skeleton className="h-24" /></div>
      ) : (
        <ul className="divide-y divide-line">
          {credit.views.slice(0, 3).map((v) => (
            <li key={v.member_id}>
              <Link href={href} className="press group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-body font-medium">{v.name.split(/\s+/)[0]}</span>
                    <span className="flex shrink-0 items-baseline gap-1.5">
                      <span className="figure num text-lead font-semibold">{v.score}</span>
                      <span className={cx("text-caption font-medium", TONE_TEXT[v.band.tone])}>{v.band.label}</span>
                    </span>
                  </span>
                  <BandScale score={v.score} className="mt-2" />
                  {v.change ? (
                    <span className={cx("num mt-1.5 block text-caption", v.change > 0 ? "text-good" : "text-risk")}>
                      {v.change > 0 ? "+" : "−"}{Math.abs(v.change)} {Math.abs(v.change) === 1 ? "pt" : "pts"} <span className="text-ink-3">in {Math.max(1, v.history.length - 1)} months</span>
                    </span>
                  ) : null}
                </span>
                <IconChevron size={16} className="-mr-1 shrink-0 text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
