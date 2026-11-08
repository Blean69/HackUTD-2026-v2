"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { IconArrowRight, IconChevronDown, IconMic, IconWhatIf } from "@/components/icons";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { cx } from "@/lib/format";
import { nextMoves } from "@/lib/nextMoves";
import { openCallSheet } from "@/lib/voiceCall/session";

/** The brief's last line, answered: one ranked action with its dollar size, what it fixes, and the health score after it. */
export function NextMoveCard({ fin, householdId, className }: { fin: RoomFinance; householdId: string; className?: string }) {
  const moves = useMemo(
    () => nextMoves({
      health: fin.health,
      accounts: fin.accounts,
      obligations: fin.obligations,
      incomeMonthly: fin.cashFlow?.income_monthly ?? 0,
      spendMonthly: fin.cashFlow?.expense_monthly ?? 0,
    }),
    [fin.health, fin.accounts, fin.obligations, fin.cashFlow],
  );
  const [more, setMore] = useState(false);
  const score = fin.healthModel.score;
  const [top, ...rest] = moves;

  if (!top || score === null) {
    return (
      <section aria-labelledby="next-move-h" className={cx("card flex items-center gap-3 px-4 py-3.5", className)}>
        <span className="h-2 w-2 rounded-full bg-good" aria-hidden="true" />
        <p id="next-move-h" className="text-body text-ink-2"><span className="font-semibold text-ink">Every health indicator is Good.</span> Your next move: put the monthly surplus toward your goals.</p>
      </section>
    );
  }

  const whatIf = (q: string) => `/room/${householdId}/what-if?q=${encodeURIComponent(q)}`;
  return (
    <section id="next-move" aria-labelledby="next-move-h" className={cx("card motion-rise relative overflow-hidden", className)}>
      <span className="absolute inset-y-0 left-0 w-1 bg-brand" aria-hidden="true" />
      <div className="flex flex-col gap-4 p-4 pl-5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-label font-semibold uppercase tracking-[0.08em] text-brand-strong">Your next move</p>
          <h2 id="next-move-h" className="mt-1 text-h2 font-semibold leading-tight tracking-[-0.015em] text-ink">{top.title}</h2>
          <p className="mt-1 max-w-2xl text-body text-ink-2">{top.detail}</p>
          <p className="num mt-1.5 text-caption text-ink-3">Fixes: {top.why}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-3 md:items-end">
          <div className="flex items-baseline gap-2" aria-label={`Household health ${score} now, ${top.scoreAfter} after this move`}>
            <span className="text-caption text-ink-3">Health</span>
            <span className="figure text-kpi-sm text-ink-2">{score}</span>
            <IconArrowRight size={16} className="self-center text-ink-3" />
            <span className="figure text-kpi-sm text-good">{top.scoreAfter}</span>
            <span className="num rounded-full bg-good-soft px-2 py-0.5 text-caption font-semibold text-good">+{top.lift}</span>
          </div>
          <div className="flex gap-2">
            <Link href={whatIf(top.simulate)} className="press inline-flex h-9 items-center gap-1.5 rounded-md bg-brand px-3.5 text-body font-semibold text-brand-ink hover:bg-brand-hover">
              <IconWhatIf size={16} />Simulate it
            </Link>
            <button type="button" onClick={() => openCallSheet({ prompt: top.ask })} className="press inline-flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3.5 text-body font-semibold text-ink hover:bg-surface-2">
              <IconMic size={16} />Ask Brian
            </button>
          </div>
        </div>
      </div>
      {rest.length ? (
        <div className="border-t border-line">
          <button type="button" aria-expanded={more} onClick={() => setMore((m) => !m)} className="flex w-full items-center justify-between px-5 py-2.5 text-label font-medium text-ink-2 hover:bg-surface-2">
            {rest.length} more {rest.length === 1 ? "move" : "moves"}, ranked by impact
            <IconChevronDown size={16} className={cx("transition-transform", more && "rotate-180")} />
          </button>
          {more ? (
            <ul className="divide-y divide-line border-t border-line">
              {rest.slice(0, 3).map((m) => (
                <li key={m.key} className="flex flex-col gap-1 px-5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-body font-medium text-ink">{m.title}</p>
                    <p className="text-caption text-ink-3">{m.why}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="num text-caption font-semibold text-good">+{m.lift} pts</span>
                    <Link href={whatIf(m.simulate)} className="text-label font-medium text-brand-strong hover:text-ink">Simulate</Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
