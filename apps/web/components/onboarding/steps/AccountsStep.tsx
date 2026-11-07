"use client";
import { useMemo, useState, type Ref } from "react";
import { Button, Chip, Skeleton } from "@/components/ui";
import { cx } from "@/lib/format";
import { accountKind, friendlyError, onboarding, type AccountOption, type OnboardingBank } from "@/lib/data/onboarding";
import { BusyLabel, money, Notice, StepFooter, StepHeading } from "../fields";

function Row({ o, checked, onToggle, institution }: { o: AccountOption; checked: boolean; onToggle: () => void; institution: string }) {
  const k = accountKind(o);
  const id = `acct-${o.id}`;
  return (
    <li>
      <label htmlFor={id} className={cx("flex min-h-[3.5rem] cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-surface-2", checked && "bg-brand-soft/30")}>
        <input id={id} type="checkbox" checked={checked} onChange={onToggle} className="h-5 w-5 shrink-0 accent-brand" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.92rem] font-medium leading-tight">{o.name}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.78rem] text-ink-2">
            <span className="truncate">{institution}</span>
            <Chip tone={k.debt ? "watch" : "brand"}>{k.label}</Chip>
            {o.mask ? <span className="num text-ink-3">••{o.mask}</span> : null}
          </span>
        </span>
        <span className="num shrink-0 text-right text-[0.92rem] font-semibold">
          {money(o.balance)}
          {k.debt ? <span className="block text-[0.7rem] font-normal text-ink-3">owed</span> : null}
        </span>
      </label>
    </li>
  );
}

/** Step 4: pick which accounts to import (`select_bank_accounts`). All on by default, with live asset and debt totals. */
export function AccountsStep({
  householdId, bank, options, onBack, onDone, onBackToConnect, headingRef,
}: {
  householdId: string;
  bank?: OnboardingBank;
  options: AccountOption[];
  onBack: () => void;
  onDone: () => void;
  onBackToConnect: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  // What the family has changed on this screen; anything untouched follows the stored `selected` flag (on by default).
  const [touched, setTouched] = useState<Readonly<Record<string, boolean>>>({});
  const isOn = (o: AccountOption) => touched[o.account_id] ?? o.selected;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        <StepHeading headingRef={headingRef} title="Choose accounts" sub="Pick the accounts you want your assistant to see." />
        {!bank ? (
          <Notice tone="info" action={<Button variant="secondary" size="sm" onClick={onBackToConnect}>Connect a bank</Button>}>
            No bank is connected yet.
          </Notice>
        ) : (
          <div className="space-y-2" role="status" aria-label="Loading your accounts">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )}
        <StepFooter onBack={onBack} />
      </div>
    );
  }

  const allOn = totals.count === options.length;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <StepHeading headingRef={headingRef} title="Choose accounts" sub="Everything starts selected. Untick anything you would rather keep out. You can change this later." />

      <div className="mb-3 grid grid-cols-3 gap-2 rounded-lg border border-line bg-surface-2 p-3 text-center" role="status" aria-live="polite" aria-label="Totals for the selected accounts">
        <div>
          <p className="text-[0.72rem] text-ink-2">Assets</p>
          <p className="num text-[1rem] font-semibold text-good">{money(totals.assets)}</p>
        </div>
        <div>
          <p className="text-[0.72rem] text-ink-2">Debts</p>
          <p className="num text-[1rem] font-semibold text-watch">{money(totals.debts)}</p>
        </div>
        <div>
          <p className="text-[0.72rem] text-ink-2">Net</p>
          <p className="num text-[1rem] font-semibold">{money(totals.net)}</p>
        </div>
        {totals.debts > 0 ? <p className="col-span-3 text-[0.74rem] leading-snug text-ink-3">Bank accounts only. We add your home and car value in a moment.</p> : null}
      </div>

      <div className="mb-2 flex items-center justify-between">
        <p className="num text-[0.82rem] text-ink-2">
          {totals.count} of {options.length} selected
        </p>
        <Button variant="ghost" size="sm" onClick={() => setTouched(Object.fromEntries(options.map((o) => [o.account_id, !allOn])))}>
          {allOn ? "Select none" : "Select all"}
        </Button>
      </div>

      <div className="space-y-3">
        {owned.length ? (
          <section aria-labelledby="own-h">
            <h2 id="own-h" className="mb-1 text-[0.78rem] font-semibold uppercase tracking-wide text-ink-3">
              What you own
            </h2>
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {owned.map((o) => (
                <Row key={o.id} o={o} institution={bank.institution_name} checked={isOn(o)} onToggle={() => toggle(o)} />
              ))}
            </ul>
          </section>
        ) : null}
        {owed.length ? (
          <section aria-labelledby="owe-h">
            <h2 id="owe-h" className="mb-1 text-[0.78rem] font-semibold uppercase tracking-wide text-ink-3">
              What you owe
            </h2>
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {owed.map((o) => (
                <Row key={o.id} o={o} institution={bank.institution_name} checked={isOn(o)} onToggle={() => toggle(o)} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {err ? (
        <div className="mt-4">
          <Notice tone="error">{err}</Notice>
        </div>
      ) : null}

      <StepFooter onBack={onBack} note={totals.count === 0 ? "Pick at least one account to import, or go back and skip the bank." : undefined}>
        <Button type="submit" size="lg" disabled={busy || totals.count === 0}>
          <BusyLabel busy={busy} busyText="Importing…">
            Import {totals.count} {totals.count === 1 ? "account" : "accounts"}
          </BusyLabel>
        </Button>
      </StepFooter>
    </form>
  );
}
