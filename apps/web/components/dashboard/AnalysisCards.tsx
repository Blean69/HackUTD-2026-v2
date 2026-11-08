"use client";
import { TrendChart } from "@/components/charts/lazy";
import Link from "next/link";
import { ScoreGauge, type GaugeBand } from "@/components/charts/ScoreGauge";
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

/** The same words `scoreLabel` (lib/finance.ts) uses, so the gauge and every other mention of the score agree. */
const HEALTH_GAUGE: GaugeBand[] = [
  { to: 39, tone: "risk", label: "At risk" },
  { to: 54, tone: "watch", label: "Needs attention" },
  { to: 69, tone: "watch", label: "Fair" },
  { to: 84, tone: "good", label: "Good" },
  { to: 100, tone: "good", label: "Excellent" },
];

/** The household health score (the one number that also drives 45% of every credit score) and its eight indicators. */
export function HealthCard({ fin, householdId, className }: { fin: RoomFinance; householdId: string; className?: string }) {
  const hm = fin.healthModel;
  return (
    <Panel id="financial-health" mascot={(hm.score ?? 60) >= 70 ? "cheer" : (hm.score ?? 60) < 55 ? "worried" : "happy"} title="Household health" info="Each indicator is computed inside the database from your accounts, transactions and credit profile, then scored 0 to 100. The score is their average." className={className}>
      <div className="flex items-center gap-4">
        <ScoreGauge value={hm.score} min={0} max={100} bands={HEALTH_GAUGE} label="Household health score" size={120} showRange={false} />
        <p className="min-w-0 text-caption leading-relaxed text-ink-3">
          The average of {hm.rows.length || "eight"} indicators, computed in the database. It also drives 45% of each{" "}
          <Link href={`/room/${householdId}/credit`} className="font-medium text-brand-strong hover:underline">credit score</Link>.
        </p>
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-1">
        {hm.rows.map((r) => (
          <li key={r.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-label">
              <span className="truncate text-ink-2">{r.label}</span>
              <span className={cx("num font-semibold", TONE_TEXT[TONE[r.status]])}>{r.score}</span>
            </div>
            <Progress value={r.score} tone={TONE[r.status]} label={`${r.label}: ${r.score} out of 100`} height="h-1" className="mt-1" />
          </li>
        ))}
        {!hm.rows.length ? <li className="col-span-2 text-label text-ink-3">Indicators are being calculated.</li> : null}
      </ul>
    </Panel>
  );
}
