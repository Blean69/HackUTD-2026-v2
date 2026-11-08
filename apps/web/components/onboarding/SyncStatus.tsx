"use client";
import { IconAlert, IconCheck } from "@/components/icons";
import { CountUp } from "@/components/motion";
import { useAccounts } from "@/lib/data/hooks";
import { cx } from "@/lib/format";
import type { OnboardingBank } from "@/lib/data/onboarding";

/**
 * Live view of the background import (`bank_connection` plus the account rows as they land): a real progress bar,
 * the counts ticking up, and the names of the accounts that have arrived. Never a bare spinner.
 */
export function SyncStatus({ bank, expectedAccounts, expectedTxns = 220, compact }: { bank: OnboardingBank; expectedAccounts: number; expectedTxns?: number; compact?: boolean }) {
  const accounts = useAccounts(bank.household_id);
  const arrived = accounts.filter((a) => a.source === "plaid" || a.id.startsWith("acct_plaid_"));
  const done = bank.status === "ok";
  const failed = bank.status === "error";
  const accN = Math.max(bank.accounts_count, arrived.length);
  const want = Math.max(1, expectedAccounts || accN);
  const pct = done ? 1 : failed ? 0 : Math.min(0.95, 0.08 + 0.5 * Math.min(1, accN / want) + 0.37 * Math.min(1, bank.txns_count / Math.max(1, expectedTxns)));

  const title = done ? "Import complete" : failed ? "The import hit a problem" : accN === 0 ? `Connecting to ${bank.institution_name || "your bank"}…` : "Importing your accounts…";
  const counts = (
    <span className="num">
      <CountUp value={accN} /> of {want} accounts · <CountUp value={bank.txns_count} /> transactions
    </span>
  );

  if (compact) {
    const short = done ? "Imported" : failed ? "Import failed" : "Importing";
    return (
      <div className="rounded-lg bg-surface-2 px-3.5 py-2.5" role="status" aria-live="polite" aria-label={`${title}. ${accN} of ${want} accounts, ${bank.txns_count} transactions`}>
        <div className="flex items-center justify-between gap-3 text-[0.8rem]">
          <span className={cx("flex min-w-0 items-center gap-1.5 font-medium", done ? "text-good" : failed ? "text-risk" : "text-ink")}>
            {done ? <IconCheck size={14} strokeWidth={2.6} /> : failed ? <IconAlert size={14} /> : <span className="anim-blink h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden="true" />}
            <span className="truncate">{short}</span>
          </span>
          <span className="shrink-0 text-ink-3">{counts}</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
          <div className={cx("bar-fill h-full rounded-full", done ? "bg-good" : "bg-brand", !done && !failed && "motion-sheen")} style={{ transform: `scaleX(${pct})` }} />
        </div>
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-line p-4" role="status" aria-live="polite" aria-label={title}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className={cx("text-[0.95rem] font-semibold", done ? "text-good" : failed ? "text-risk" : "text-ink")}>{title}</h2>
        <span className="shrink-0 text-[0.8rem] text-ink-3">{bank.institution_name}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <div className={cx("bar-fill h-full rounded-full", done ? "bg-good" : "bg-brand", !done && !failed && "motion-sheen")} style={{ transform: `scaleX(${pct})` }} />
      </div>
      <p className="mt-2 text-[0.82rem] text-ink-2">{counts}</p>
      {arrived.length ? (
        <ul className="mt-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {arrived.map((a, i) => (
            <li key={a.id} className="motion-fade flex min-w-0 items-center gap-2 text-[0.84rem]" style={{ ["--i" as string]: i }}>
              <IconCheck size={14} strokeWidth={2.6} className="shrink-0 text-good" />
              <span className="truncate">{a.nickname}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {bank.error ? <p className="mt-2 text-[0.82rem] text-risk">{bank.error}</p> : null}
    </section>
  );
}
