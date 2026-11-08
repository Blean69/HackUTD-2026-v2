"use client";
import { useMemo, useState } from "react";
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

/** Savings rate, cash runway, and where the last 90 days went. The two rings show the household-health indicators computed in
 *  SpacetimeDB (the same numbers as the Household health card and Brian), so the dashboard never contradicts itself. */
export function InsightCards({ fin }: { fin: RoomFinance }) {
  const { cash, txns, today, accounts, health } = fin;
  const sum = useMemo(() => cashSummary(cash), [cash]);
  const indicator = (key: string) => health.find((h) => h.key === key)?.value ?? null;
  const spend = useMemo(() => spendingBreakdown(txns, today, 90, 5), [txns, today]);
  const liquid = accounts.filter((a) => a.type === "checking" || a.type === "savings").reduce((s, a) => s + a.balance, 0);
  const burn = spend.total / 3;
  const runway = indicator("liquidity_runway") ?? (burn > 0 ? liquid / burn : null);
  const sr = indicator("savings_rate") ?? sum.savingsRate;
  const srTone: Tone = sr === null ? "watch" : sr >= 15 ? "good" : sr >= 5 ? "watch" : "risk";
  const rwTone: Tone = runway === null ? "watch" : runway >= 6 ? "good" : runway >= 3 ? "watch" : "risk";
  const mood: MascotMood = srTone === "risk" || rwTone === "risk" ? "worried" : srTone === "good" && rwTone === "good" ? "cheer" : "happy";
  const [hot, setHot] = useState<string | null>(null);
  const slices = spend.categories.map((c, i) => ({ key: c.category, value: c.value, color: SERIES[i % SERIES.length], label: categoryLabel(c.category) }));

  return (
    <>
      <RingTile i={0} label="Savings rate" value={sr === null ? "n/a" : <CountUp value={sr} format={(n) => `${n.toFixed(1)}%`} />} pct={sr ?? 0} tone={srTone} sub="of income kept" />
      <RingTile i={1} label="Cash runway" value={runway === null ? "n/a" : <CountUp value={runway} format={(n) => `${n.toFixed(1)} mo`} />} pct={runway === null ? 0 : (runway / 12) * 100} tone={rwTone} sub="at current spending" />
      <Panel id="spending-mix" title="Where the money went" sub="Last 90 days" className={cx("relative", BENTO.half)}>
        <Peek mood={mood} />
        {slices.length ? (
          <div className="flex items-center gap-4">
            <Donut slices={slices} size={116} thickness={14} label="Spending by category, last 90 days" format={(n) => usd(n, { compact: true })} active={hot} onActive={setHot}>
              <span className="figure text-label"><CountUp value={spend.total} format={(n) => usd(n, { compact: true })} /></span>
              <span className="text-caption text-ink-3">spent</span>
            </Donut>
            <ul className="min-w-0 flex-1 space-y-1.5">
              {spend.categories.map((c, i) => (
                <li key={c.category} className={cx("motion-fade -mx-1.5 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-label transition-colors", hot === c.category && "bg-surface-2")} style={{ ["--i" as string]: i }} onPointerEnter={() => setHot(c.category)} onPointerLeave={() => setHot(null)}>
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

const ASSET_LABEL: Record<string, string> = { checking: "Checking", savings: "Savings", cd: "CDs", ira: "Retirement", home: "Home and vehicles" };

/** What the household owns, by kind. Debts are not in here; they are on the Accounts card. */
export function AssetCard({ fin, className }: { fin: RoomFinance; className?: string }) {
  const [hot, setHot] = useState<string | null>(null);
  const by = new Map<string, number>();
  for (const a of fin.accounts) if (["checking", "savings", "cd", "ira"].includes(a.type) && a.balance > 0) by.set(a.type, (by.get(a.type) ?? 0) + a.balance);
  if (fin.property > 0) by.set("home", fin.property);
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((s, [, v]) => s + v, 0);
  const slices = rows.map(([k, v], i) => ({ key: k, value: v, color: SERIES[i % SERIES.length], label: ASSET_LABEL[k] ?? k }));
  return (
    <Panel id="asset-allocation" title="Asset allocation" className={className}>
      {rows.length ? (
        <div className="flex flex-col items-center gap-3">
          <Donut slices={slices} size={132} thickness={16} label="Assets by kind" format={(n) => usd(n, { compact: true })} active={hot} onActive={setHot}>
            <span className="figure text-lead"><CountUp value={total} format={(n) => usd(n, { compact: true })} /></span>
            <span className="text-caption text-ink-3">total assets</span>
          </Donut>
          <ul className="w-full space-y-1.5">
            {slices.map((s) => (
              <li key={s.key} className={cx("-mx-1.5 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-label transition-colors", hot === s.key && "bg-surface-2")} onPointerEnter={() => setHot(s.key)} onPointerLeave={() => setHot(null)} onClick={() => setHot(hot === s.key ? null : s.key)}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-ink-2">{s.label}</span>
                <span className="num font-medium text-ink">{((s.value / total) * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </div>
      ) : <p className="text-label text-ink-3">No assets on file yet.</p>}
    </Panel>
  );
}
