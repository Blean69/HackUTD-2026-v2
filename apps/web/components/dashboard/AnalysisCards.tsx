"use client";
import { HealthRadar, TrendChart } from "@/components/charts/lazy";
import Link from "next/link";
import { Panel, PanelLink, Progress, TONE_TEXT } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { cx, usd } from "@/lib/format";

export function TrendCard({ fin, householdId, className }: { fin: RoomFinance; householdId: string; className?: string }) {
  const end = fin.trend.forecastEnd;
  return (
    <Panel
      id="net-worth-trend"
      mascot="happy"
      title="Net worth and 90-day forecast"
      sub={end !== undefined ? <span className="num">About {usd(end)} by the end of the forecast</span> : undefined}
      className={className}
      footer={<PanelLink href={`/room/${householdId}/analytics`}>Trends in Analytics</PanelLink>}
    >
      <TrendChart model={fin.trend} height={300} mobileHeight={210} />
    </Panel>
  );
}

const TONE = { good: "good", watch: "watch", risk: "risk" } as const;

/** When a label wraps, keep "(3 mo)" and "90 d" in one piece: "Savings rate / (3 mo)", not "Savings rate (3 / mo)". */
const keepTogether = (s: string) => s.replace(/\(([^)]*)\)/g, (m) => m.replace(/ /g, "\u00a0")).replace(/(\d) (d|mo)\b/g, "$1\u00a0$2");

/**
 * The household health score and its eight indicators. It also feeds 45% of the app's simulated credit score (a
 * learning model on the Credit page, not a bureau score).
 */
export function HealthCard({ fin, householdId, className }: { fin: RoomFinance; householdId: string; className?: string }) {
  const hm = fin.healthModel;
  return (
    <Panel id="financial-health" mascot={(hm.score ?? 60) >= 70 ? "cheer" : (hm.score ?? 60) < 55 ? "worried" : "happy"} title="Household health" info="Each indicator is computed inside the database from your accounts, transactions and credit profile, then scored 0 to 100. The score is their average." className={className}>
      <div className="flex items-center justify-between gap-3">
        <p className="figure shrink-0 text-kpi-sm">{hm.score ?? "n/a"}<span className="text-label font-normal text-ink-3"> / 100</span></p>
        <Link
          href={`/room/${householdId}/credit`}
          className="relative text-right text-caption font-medium text-brand-strong before:absolute before:-inset-x-1 before:-inset-y-3 hover:underline"
        >
          Feeds 45% of the simulated credit score
        </Link>
      </div>
      {/* A container: the radar's height and the list's columns follow the card's width. */}
      <div className="@container">
        {hm.rows.length ? <HealthRadar rows={hm.rows} /> : null}
        {/* Narrow card: one row per indicator (label, bar, score), so labels such as "Lowest balance, next 90 d" have the
            width. Wide card: two columns with the bar under each label. Labels wrap; they are never cut off. */}
        <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 @min-[26rem]:grid-cols-2 @min-[26rem]:gap-y-2.5">
          {hm.rows.map((r) => (
            <li key={r.key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_2.5rem_1.75rem] items-center gap-x-2 @min-[26rem]:grid-cols-[minmax(0,1fr)_auto] @min-[26rem]:items-baseline @min-[26rem]:gap-x-2">
              <span className="col-start-1 row-start-1 min-w-0 text-label leading-snug text-ink-2">{keepTogether(r.label)}</span>
              <span className={cx("num col-start-3 row-start-1 text-right text-label font-semibold @min-[26rem]:col-start-2", TONE_TEXT[TONE[r.status]])}>{r.score}</span>
              <Progress
                value={r.score}
                tone={TONE[r.status]}
                label={`${r.label}: ${r.score} out of 100`}
                height="h-1"
                className="col-start-2 row-start-1 @min-[26rem]:col-span-2 @min-[26rem]:col-start-1 @min-[26rem]:row-start-2 @min-[26rem]:mt-1"
              />
            </li>
          ))}
          {!hm.rows.length ? <li className="text-label text-ink-3 @min-[26rem]:col-span-2">Indicators are being calculated.</li> : null}
        </ul>
      </div>
    </Panel>
  );
}
