"use client";
import { IconAlert, IconBank, IconCheck } from "@/components/icons";
import { Progress, Spinner } from "@/components/ui";
import { cx } from "@/lib/format";
import type { OnboardingBank } from "@/lib/data/onboarding";

const nf = new Intl.NumberFormat("en-US");

const COPY: Record<OnboardingBank["status"], { title: string; tone: string }> = {
  linking: { title: "Finding your accounts…", tone: "text-ink-2" },
  selecting: { title: "Connected. Ready for you to choose accounts", tone: "text-good" },
  syncing: { title: "Bringing in your accounts and transactions…", tone: "text-ink-2" },
  ok: { title: "All synced", tone: "text-good" },
  error: { title: "Something went wrong with the bank", tone: "text-risk" },
};

/** Live view of `bank_connection`: status, account count and transaction count, with a progress hint. */
export function SyncStatus({ bank, compact }: { bank: OnboardingBank; compact?: boolean }) {
  const c = COPY[bank.status];
  const busy = bank.status === "linking" || bank.status === "syncing";
  return (
    <div className={cx("rounded-lg border border-line bg-surface", compact ? "px-3 py-2.5" : "p-3.5")} role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", bank.status === "error" ? "bg-risk-soft text-risk" : bank.status === "ok" || bank.status === "selecting" ? "bg-good-soft text-good" : "bg-brand-soft text-brand-strong")}>
          {busy ? <Spinner size={18} /> : bank.status === "error" ? <IconAlert size={18} /> : bank.status === "ok" ? <IconCheck size={18} strokeWidth={2.4} /> : <IconBank size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-[0.9rem] font-semibold leading-tight">{bank.institution_name || "Your bank"}</p>
          <p className={cx("text-[0.8rem] leading-snug", c.tone)}>{c.title}</p>
        </div>
        <p className="num shrink-0 text-right text-[0.78rem] leading-snug text-ink-2">
          {nf.format(bank.accounts_count)} {bank.accounts_count === 1 ? "account" : "accounts"}
          <br />
          {nf.format(bank.txns_count)} transactions
        </p>
      </div>
      {bank.status === "syncing" || bank.status === "linking" ? <Progress value={bank.status === "linking" ? 12 : Math.min(92, 20 + bank.accounts_count * 8 + Math.min(40, bank.txns_count / 6))} className="mt-3" label="Sync progress" /> : null}
      {bank.error ? <p className="mt-2 text-[0.8rem] text-risk">{bank.error}</p> : null}
    </div>
  );
}
