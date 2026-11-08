"use client";
import { useState } from "react";
import { IconChevron } from "@/components/icons";
import { Avatar, Button, Notice, Skeleton } from "@/components/ui";
import {
  accountMix, isSampleCustomer, loadSandboxProfiles, splitProfileName, useSandboxProfiles, type OnboardingMode, type OwnedHousehold, type SandboxProfile,
} from "@/lib/data/onboarding";
import { cx } from "@/lib/format";
import { SampleProgress } from "./SampleProgress";
import type { SampleRun } from "./useSampleSetup";

/** The dataset holds dozens of customers; the first few show, the rest are one tap away. */
const SHOWN = 6;

type Standing = "new" | "resume" | "open";

function CustomerCard({ p, standing, disabled, onPick, i }: { p: SandboxProfile; standing: Standing; disabled: boolean; onPick: () => void; i: number }) {
  const [name, about] = splitProfileName(p.display_name);
  return (
    <li className="motion-fade" style={{ ["--i" as string]: i }}>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        className="press group flex w-full items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3.5 text-left text-ink transition-colors hover:border-line-strong hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-surface"
      >
        <Avatar name={name} size={36} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-lead font-semibold leading-tight">{name}</span>
          <span className="mt-0.5 block text-label leading-snug text-ink-2">{about || p.summary}</span>
          <span className="num mt-1.5 block text-caption text-ink-3">{accountMix(p.accounts)}</span>
        </span>
        <span className={cx("mt-0.5 inline-flex shrink-0 items-center gap-1 text-label font-semibold", standing === "new" ? "text-ink-3" : "text-brand-strong")}>
          {standing === "open" ? "Open" : standing === "resume" ? "Resume" : null}
          <IconChevron size={16} className="transition-transform duration-150 group-hover:translate-x-0.5" />
        </span>
      </button>
    </li>
  );
}

/**
 * The PNC sample customers (GET /plaid/sandbox_profiles, minus the demo bank). Tapping one runs the automatic setup; its card
 * becomes the progress view and the other cards are disabled until it finishes or is cancelled.
 */
export function SampleCustomers({
  mode, ready, run, mine, setups, onPick, onRetry, onCancel,
}: {
  mode: OnboardingMode;
  /** The households on this device are known, so a customer that is already set up can be told from one that is not. */
  ready: boolean;
  run: SampleRun | null;
  mine: readonly OwnedHousehold[];
  setups: Readonly<Record<string, string>>;
  onPick: (p: SandboxProfile) => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { profiles, source } = useSandboxProfiles(mode);
  const [showAll, setShowAll] = useState(false);
  const samples = profiles.filter(isSampleCustomer);
  const running = run?.profile.profile_id;
  const shown = samples.filter((p, i) => showAll || i < SHOWN || p.profile_id === running);

  const standing = (p: SandboxProfile): Standing => {
    const hid = setups[p.profile_id];
    const owned = hid ? mine.find((h) => h.household.id === hid) : undefined;
    return !owned ? "new" : owned.finished ? "open" : "resume";
  };

  return (
    <section aria-labelledby="samples-h">
      <h2 id="samples-h" className="eyebrow">
        Sample customers from PNC&apos;s HackUTD dataset
      </h2>
      <p className="mt-1 text-label text-ink-3">
        {source === "mock" ? "Offline demo: your setup lives in this tab. " : "Synthetic customers. "}Tap one and we connect their sandbox bank and set up their dashboard for you.
      </p>

      {source === "loading" ? (
        <div className="mt-3 space-y-2" role="status" aria-label="Loading sample customers">
          <Skeleton className="h-[5.5rem] w-full !rounded-lg" />
          <Skeleton className="h-[5.5rem] w-full !rounded-lg" />
          <Skeleton className="h-[5.5rem] w-full !rounded-lg" />
        </div>
      ) : source === "offline" ? (
        <div className="mt-3">
          <Notice tone="warn" action={<Button variant="secondary" size="sm" onClick={() => void loadSandboxProfiles(mode)}>Try again</Button>}>
            The bank connector isn&apos;t answering, so the sample customers can&apos;t load right now.
          </Notice>
        </div>
      ) : samples.length === 0 ? (
        <p className="mt-3 rounded-lg bg-surface-2 px-4 py-3.5 text-body text-ink-2">This server only has the demo bank, so there are no sample customers to show.</p>
      ) : (
        <>
          <ul className="mt-3 space-y-2" aria-label="Sample customers">
            {shown.map((p, i) =>
              run && p.profile_id === running ? (
                <li key={p.profile_id}>
                  <SampleProgress run={run} onRetry={onRetry} onCancel={onCancel} />
                </li>
              ) : (
                <CustomerCard key={p.profile_id} p={p} i={showAll ? 0 : i} standing={standing(p)} disabled={!ready || !!run} onPick={() => onPick(p)} />
              ),
            )}
          </ul>
          {samples.length > SHOWN ? (
            <Button variant="ghost" size="sm" className="mt-2 -ml-2.5" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
              {showAll ? "Show fewer" : `Show all ${samples.length}`}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
