"use client";
import Link from "next/link";
import { TrendChart } from "@/components/charts/lazy";
import { IconArrowRight } from "@/components/icons";
import { Panel, Progress, TONE_TEXT } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { cx } from "@/lib/format";

/** The one trailing link every drill-down card header uses. */
export function ViewAll({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 rounded-md py-1 text-[0.8rem] font-semibold text-brand-strong hover:underline">
      {children} <IconArrowRight size={13} />
    </Link>
  );
}

export function TrendCard({ fin, className }: { fin: RoomFinance; className?: string }) {
  return (
    <Panel id="net-worth-trend" title="Net worth and 90-day forecast" className={className}>
      <TrendChart model={fin.trend} height={250} mobileHeight={210} />
    </Panel>
  );
}

const TONE = { good: "good", watch: "watch", risk: "risk" } as const;

export function HealthCard({ fin, className }: { fin: RoomFinance; className?: string }) {
  const hm = fin.healthModel;
  return (
    <Panel id="financial-health" title="Health indicators" info="Each indicator is computed inside the database from your accounts, transactions and credit profile, then scored 0 to 100." className={className}>
      <ul className="space-y-2.5">
        {hm.rows.map((r) => (
          <li key={r.key}>
            <div className="flex items-baseline justify-between gap-2 text-[0.82rem]">
              <span className="truncate text-ink-2">{r.label}</span>
              <span className={cx("num font-semibold", TONE_TEXT[TONE[r.status]])}>{r.score}</span>
            </div>
            <Progress value={r.score} tone={TONE[r.status]} label={`${r.label}: ${r.score} out of 100`} height="h-1" className="mt-1" />
          </li>
        ))}
        {!hm.rows.length ? <li className="text-[0.82rem] text-ink-3">Indicators are being calculated.</li> : null}
      </ul>
    </Panel>
  );
}
