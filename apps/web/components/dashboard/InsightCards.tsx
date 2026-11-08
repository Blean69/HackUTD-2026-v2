"use client";
import { useMemo } from "react";
import { Donut } from "@/components/charts/Donut";
import { SERIES } from "@/components/charts/theme";
import { Mascot, Peek, type MascotMood } from "@/components/Mascot";
import { CountUp } from "@/components/motion";
import { BENTO, Panel, TONE_TEXT, type Tone } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { cashSummary, categoryLabel, spendingBreakdown } from "@/lib/finance-analytics";
import { cx, usd } from "@/lib/format";

/** A ring metric: Penny's colour-coded verdict around one number. */
function RingTile({ label, value, pct, tone, sub, i }: { label: string; value: React.ReactNode; pct: number; tone: Tone; sub: string; i: number }) {
  const color = tone === "good" ? "var(--good)" : tone === "risk" ? "var(--risk)" : "var(--watch)";
  return (
    <div className={cx("card motion-rise relative flex items-center gap-3 p-4 transition-transform duration-200 hover:-translate-y-0.5", BENTO.quarter)} style={{ ["--i" as string]: i }}>
      <Donut size={76} thickness={9} total={100} slices={[{ key: "v", value: Math.max(2, Math.min(100, pct)), color, label }]} label={`${label}: ${sub}`}>
        <Mascot mood={tone === "risk" ? "worried" : tone === "good" ? "cheer" : "happy"} size={30} />
      </Donut>
      <div className="min-w-0">
        <p className="text-caption font-medium text-ink-3">{label}</p>
        <p className={cx("figure truncate text-kpi-sm", TONE_TEXT[tone])}>{value}</p>
        <p className="text-caption text-ink-3">{sub}</p>
      </div>
    </div>
  );
}

/** Savings rate, cash runway, and where the last 90 days went. Derived from the same rows as the rest of the dashboard. */
export function InsightCards({ fin }: { fin: RoomFinance }) {
  const { cash, txns, today, accounts } = fin;
  const sum = useMemo(() => cashSummary(cash), [cash]);
  const spend = useMemo(() => spendingBreakdown(txns, today, 90, 5), [txns, today]);
  const liquid = accounts.filter((a) => a.type === "checking" || a.type === "savings").reduce((s, a) => s + a.balance, 0);
  const burn = spend.total / 3;
  const runway = burn > 0 ? liquid / burn : null;
  const sr = sum.savingsRate;
  const srTone: Tone = sr === null ? "watch" : sr >= 15 ? "good" : sr >= 5 ? "watch" : "risk";
  const rwTone: Tone = runway === null ? "watch" : runway >= 6 ? "good" : runway >= 3 ? "watch" : "risk";
  const mood: MascotMood = srTone === "risk" || rwTone === "risk" ? "worried" : srTone === "good" && rwTone === "good" ? "cheer" : "happy";
  const slices = spend.categories.map((c, i) => ({ key: c.category, value: c.value, color: SERIES[i % SERIES.length], label: categoryLabel(c.category) }));

  return (
    <>
      <RingTile i={0} label="Savings rate" value={sr === null ? "n/a" : <CountUp value={sr} format={(n) => `${n.toFixed(1)}%`} />} pct={sr ?? 0} tone={srTone} sub="of income kept" />
      <RingTile i={1} label="Cash runway" value={runway === null ? "n/a" : <CountUp value={runway} format={(n) => `${n.toFixed(1)} mo`} />} pct={runway === null ? 0 : (runway / 12) * 100} tone={rwTone} sub="at current spending" />
      <Panel id="spending-mix" title="Where the money went" sub="Last 90 days" className={cx("relative", BENTO.half)}>
        <Peek mood={mood} />
        {slices.length ? (
          <div className="flex items-center gap-4">
            <Donut slices={slices} size={112} thickness={14} label="Spending by category, last 90 days">
              <span className="figure text-label"><CountUp value={spend.total} format={(n) => usd(n, { compact: true })} /></span>
              <span className="text-caption text-ink-3">spent</span>
            </Donut>
            <ul className="min-w-0 flex-1 space-y-1.5">
              {spend.categories.map((c, i) => (
                <li key={c.category} className="motion-fade flex items-center gap-2 text-label" style={{ ["--i" as string]: i }}>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SERIES[i % SERIES.length] }} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-ink-2">{categoryLabel(c.category)}</span>
                  <span className="num font-medium text-ink">{c.share.toFixed(0)}%</span>
                </li>
              ))}
            </ul>
          </div>
        ) : <p className="text-label text-ink-3">No spending in the last 90 days.</p>}
      </Panel>
    </>
  );
}
