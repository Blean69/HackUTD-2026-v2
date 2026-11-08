"use client";
import { useMemo, useState, type Ref } from "react";
import { IconCheck } from "@/components/icons";
import { CountUp } from "@/components/motion";
import { Button, Skeleton } from "@/components/ui";
import { cx } from "@/lib/format";
import { accountKind, friendlyError, onboarding, type AccountOption, type OnboardingBank } from "@/lib/data/onboarding";
import { BusyLabel, money, Notice, StepFooter, StepHeading } from "../fields";

function Row({ o, checked, onToggle, disabled, i }: { o: AccountOption; checked: boolean; onToggle: () => void; disabled?: boolean; i: number }) {
  const k = accountKind(o);
  const id = `acct-${o.id}`;
  return (
    <li className="motion-fade" style={{ ["--i" as string]: i }}>
      <label htmlFor={id} className={cx("flex min-h-[3.75rem] items-center gap-3 px-4 py-3 transition-colors has-[:focus-visible]:bg-surface-2", disabled ? "cursor-default" : "cursor-pointer hover:bg-surface-2")}>
        <input id={id} type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} className="peer sr-only" />
        <span
          aria-hidden="true"
          className={cx(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus)]",
            checked ? "border-brand bg-brand text-brand-ink" : "border-line-strong bg-surface",
          )}
        >
          {checked ? <IconCheck size={13} strokeWidth={3} /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate text-lead font-medium leading-tight", !checked && "text-ink-2")}>{o.name}</span>
          <span className="mt-0.5 block text-label text-ink-3">
            {k.label}
            {o.mask ? <span className="num"> ••{o.mask}</span> : null}
          </span>
        </span>
        <span className={cx("num shrink-0 text-right text-lead font-semibold", !checked && "text-ink-3")}>
          {k.debt ? "−" : ""}
          {money(o.balance)}
        </span>
      </label>
    </li>
  );
}

/** Step 4: pick which accounts to import (`select_bank_accounts`). All on by default, with live totals. */
export function AccountsStep({
  householdId, bank, options, onBack, onDone, headingRef,
}: {
  householdId: string;
  bank?: OnboardingBank;
  options: AccountOption[];
  onBack: () => void;
  onDone: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  // What the family changed on this screen; anything untouched follows the stored `selected` flag (on by default).
  const [touched, setTouched] = useState<Readonly<Record<string, boolean>>>({});
  const isOn = (o: AccountOption) => touched[o.account_id] ?? o.selected;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const imported = bank?.status === "syncing" || bank?.status === "ok";

  const totals = useMemo(() => {
    let assets = 0;
    let debts = 0;
    let count = 0;
    for (const o of options) {
      if (!(touched[o.account_id] ?? o.selected)) continue;
      count++;
      if (accountKind(o).debt) debts += o.balance;
      else assets += o.balance;
    }
    return { assets, debts, net: assets - debts, count };
  }, [options, touched]);

  const owned = options.filter((o) => !accountKind(o).debt);
  const owed = options.filter((o) => accountKind(o).debt);
  const toggle = (o: AccountOption) => setTouched((prev) => ({ ...prev, [o.account_id]: !(prev[o.account_id] ?? o.selected) }));

  async function submit() {
    if (imported) return onDone();
    if (!bank || busy || totals.count === 0) return;
    setBusy(true);
    setErr(null);
    try {
      await onboarding.select(householdId, bank.item_id, options.filter(isOn).map((o) => o.account_id));
      onDone();
    } catch (e) {
      setErr(friendlyError(e, "We couldn't import those accounts. Please try again."));
      setBusy(false);
    }
  }

  if (!bank || options.length === 0) {
    return (
      <div>
        <StepHeading headingRef={headingRef} title="Choose accounts" sub="Finding the accounts at your bank…" />
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line" role="status" aria-label="Loading your accounts">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-4">
              <Skeleton className="h-5 w-5" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
        <StepFooter onBack={onBack} />
      </div>
    );
  }

  const allOn = totals.count === options.length;
  const group = (title: string, rows: AccountOption[], offset: number) =>
    rows.length ? (
      <section aria-label={title}>
        <h2 className="mb-1.5 text-label font-semibold text-ink-3">{title}</h2>
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {rows.map((o, i) => (
            <Row key={o.id} o={o} i={offset + i} checked={isOn(o)} onToggle={() => toggle(o)} disabled={imported || busy} />
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <StepHeading
        headingRef={headingRef}
        title="Choose accounts"
        sub={imported ? "These accounts are on their way in." : `Everything at ${bank.institution_name || "your bank"} starts selected. Untick anything you would rather keep out.`}
      />

      <div className="mb-5 grid grid-cols-3 rounded-lg border border-line bg-surface-2 py-3 text-center" role="status" aria-live="polite" aria-label="Totals for the selected accounts">
        <div>
          <p className="eyebrow">Assets</p>
          <CountUp value={totals.assets} format={money} className="figure mt-1 block text-[1.05rem]" />
        </div>
        <div className="border-x border-line">
          <p className="eyebrow">Debts</p>
          <CountUp value={totals.debts} format={money} className="figure mt-1 block text-[1.05rem]" />
        </div>
        <div>
          <p className="eyebrow">Net</p>
          <CountUp value={totals.net} format={money} className="figure mt-1 block text-[1.05rem]" />
        </div>
      </div>

      {totals.net < 0 ? <p className="-mt-3 mb-5 text-label text-ink-3">Bank accounts only. Your home and car are added in a moment.</p> : null}

      {!imported ? (
        <div className="mb-2 flex items-center justify-between">
          <p className="num text-label text-ink-2">
            {totals.count} of {options.length} selected
          </p>
          <Button variant="ghost" size="sm" onClick={() => setTouched(Object.fromEntries(options.map((o) => [o.account_id, !allOn])))}>
            {allOn ? "Clear all" : "Select all"}
          </Button>
        </div>
      ) : null}

      <div className="space-y-4">
        {group("What you own", owned, 0)}
        {group("What you owe", owed, owned.length)}
      </div>

      {err ? (
        <div className="mt-4">
          <Notice tone="error">{err}</Notice>
        </div>
      ) : null}

      <StepFooter onBack={onBack} note={totals.count === 0 && !imported ? "Pick at least one account to import." : undefined}>
        <Button type="submit" size="lg" disabled={busy || (!imported && totals.count === 0)}>
          <BusyLabel busy={busy} busyText="Importing…">
            {imported ? "Continue" : `Import ${totals.count} ${totals.count === 1 ? "account" : "accounts"}`}
          </BusyLabel>
        </Button>
      </StepFooter>
    </form>
  );
}
