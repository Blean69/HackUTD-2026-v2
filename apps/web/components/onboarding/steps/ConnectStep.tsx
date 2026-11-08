"use client";
import dynamic from "next/dynamic";
import { useEffect, useState, type Ref } from "react";
import { IconBank, IconCheck } from "@/components/icons";
import { Button, Skeleton } from "@/components/ui";
import { cx } from "@/lib/format";
import {
  accountMix, DEFAULT_PROFILE_ID, friendlyError, onboarding, useSandboxProfiles, type OnboardingBank, type OnboardingMode, type SandboxProfile,
} from "@/lib/data/onboarding";
import { checkWorker, useWorkerStatus } from "@/lib/worker";
import { BusyLabel, Notice, StepFooter, StepHeading } from "../fields";

const PlaidOpener = dynamic(() => import("../PlaidOpener"), { ssr: false });

/** "Maya, early-career nurse, saving for a first home" -> ["Maya", "Early-career nurse, saving for a first home"] */
function splitName(display: string): [string, string] {
  const i = display.indexOf(",");
  if (i < 0) return [display, ""];
  const rest = display.slice(i + 1).trim();
  return [display.slice(0, i).trim(), rest.charAt(0).toUpperCase() + rest.slice(1)];
}
const nf = new Intl.NumberFormat("en-US");
/** The dataset can hold dozens of customers; the first few show, the rest are one tap away. */
const SHOWN = 6;

function ProfileCard({ p, checked, onPick, i, busy }: { p: SandboxProfile; checked: boolean; onPick: () => void; i: number; busy: boolean }) {
  const [name, about] = splitName(p.display_name);
  const id = `profile-${p.profile_id}`;
  return (
    <li className="motion-fade" style={{ ["--i" as string]: i }}>
      <label
        htmlFor={id}
        className={cx(
          "press flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3.5 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)]",
          checked ? "border-brand bg-brand-soft/45" : "border-line hover:border-line-strong hover:bg-surface-2",
          busy && !checked && "opacity-50",
        )}
      >
        <input id={id} type="radio" name="sandbox-profile" value={p.profile_id} checked={checked} onChange={onPick} disabled={busy} className="sr-only" />
        <span aria-hidden="true" className={cx("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors", checked ? "border-brand bg-brand" : "border-line-strong bg-surface")}>
          {checked ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-lead font-semibold leading-tight">{name}</span>
          {about ? <span className="mt-0.5 block text-body leading-snug text-ink">{about}</span> : null}
          {checked && p.summary ? <span className="motion-fade mt-1 block text-label leading-snug text-ink-2">{p.summary}</span> : null}
          <span className="num mt-2 block text-caption text-ink-3">
            {accountMix(p.accounts)}
            {p.txn_count ? ` · ${nf.format(p.txn_count)} transactions` : ""}
          </span>
        </span>
      </label>
    </li>
  );
}

/** Step 3: pick a sandbox customer to connect (section 7b), or use the real Plaid Link sandbox flow. */
export function ConnectStep({
  householdId, bank, mode, onBack, onContinue, onSkip, headingRef,
}: {
  householdId: string;
  bank?: OnboardingBank;
  mode: OnboardingMode;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const worker = useWorkerStatus();
  const { profiles, source } = useSandboxProfiles(mode);
  const [picked, setPicked] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<"link" | "profile" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (mode === "live") checkWorker();
  }, [mode]);

  const choice = picked ?? profiles.find((p) => p.profile_id === DEFAULT_PROFILE_ID)?.profile_id ?? profiles[0]?.profile_id ?? DEFAULT_PROFILE_ID;
  const current = profiles.find((p) => p.profile_id === choice);
  const linking = bank?.status === "linking";
  const connected = bank?.status === "selecting" || bank?.status === "syncing" || bank?.status === "ok";
  const working = busy !== null || linking;
  const offline = mode === "live" && worker === "down";

  async function connectProfile() {
    setErr(null);
    setBusy("profile");
    try {
      await onboarding.connectDemo(householdId, choice);
    } catch (e) {
      setErr(friendlyError(e, "We couldn't reach the sandbox bank. Please try again."));
    } finally {
      setBusy(null);
    }
  }
  async function startLink() {
    setErr(null);
    setBusy("link");
    try {
      if (mode === "mock") {
        await onboarding.connectDemo(householdId, DEFAULT_PROFILE_ID);
        setBusy(null);
        return;
      }
      setToken(await onboarding.linkToken(householdId));
    } catch (e) {
      setErr(friendlyError(e, "We couldn't start Plaid. Please try again."));
      setBusy(null);
    }
  }
  async function exchange(publicToken: string) {
    setToken(null);
    try {
      await onboarding.exchange(householdId, publicToken);
    } catch (e) {
      setErr(friendlyError(e, "We couldn't finish connecting. Please try again."));
    } finally {
      setBusy(null);
    }
  }

  if (connected && bank) {
    return (
      <div>
        <StepHeading headingRef={headingRef} title="Your bank is connected" sub="Next, choose which accounts your household should see." />
        <div className="motion-rise flex items-center gap-3 rounded-lg border border-line px-4 py-3.5">
          <span className="motion-pop flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-good-soft text-good">
            <IconCheck size={18} strokeWidth={2.4} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-lead font-semibold">{bank.institution_name || "Sandbox bank"}</span>
            <span className="num block text-label text-ink-2">
              {bank.accounts_count} {bank.accounts_count === 1 ? "account" : "accounts"} found
            </span>
          </span>
        </div>
        <StepFooter onBack={onBack}>
          <Button size="lg" onClick={onContinue}>
            Choose accounts
          </Button>
        </StepFooter>
      </div>
    );
  }

  const [firstName] = splitName(current?.display_name ?? "");
  const failed = bank?.status === "error";
  return (
    <div>
      <StepHeading headingRef={headingRef} title="Connect your bank" sub="Pick a sample customer to connect through Plaid Sandbox. You choose which of their accounts to share next." />

      <p className="mb-2.5 flex items-center gap-1.5 text-label font-medium text-ink-3">
        <IconBank size={15} />
        {source === "live" ? "Sample customers from PNC's HackUTD dataset" : source === "loading" ? "Loading sample customers…" : source === "default" ? "Plaid Sandbox customer" : "Sample customers (offline demo)"}
      </p>

      {source === "loading" ? (
        <div className="space-y-2" role="status" aria-label="Loading sample customers">
          <Skeleton className="h-[5.5rem] w-full !rounded-lg" />
          <Skeleton className="h-[5.5rem] w-full !rounded-lg" />
          <Skeleton className="h-[5.5rem] w-full !rounded-lg" />
        </div>
      ) : (
        <>
          <ul role="radiogroup" aria-label="Sample customers" className="space-y-2">
            {profiles
              .filter((p, i) => showAll || i < SHOWN || p.profile_id === choice)
              .map((p, i) => (
                <ProfileCard key={p.profile_id} p={p} i={showAll ? 0 : i} checked={p.profile_id === choice} onPick={() => setPicked(p.profile_id)} busy={working} />
              ))}
          </ul>
          {!showAll && profiles.length > SHOWN ? (
            <Button variant="ghost" size="sm" className="mt-2 -ml-2.5" onClick={() => setShowAll(true)}>
              {`Show all ${profiles.length} customers`}
            </Button>
          ) : null}
        </>
      )}

      {linking ? (
        <div className="mt-4 flex items-center gap-3 rounded-lg bg-surface-2 px-4 py-3" role="status" aria-live="polite">
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
            <span className="anim-blink absolute inset-0 rounded-full bg-brand" />
          </span>
          <span className="text-body text-ink-2">
            Connecting to <strong className="font-semibold text-ink">{bank?.institution_name || "the sandbox bank"}</strong> and finding accounts…
          </span>
        </div>
      ) : null}

      {offline && !linking ? (
        <div className="mt-4">
          <Notice tone="warn" action={<Button variant="secondary" size="sm" onClick={() => checkWorker(true)}>Check again</Button>}>
            The bank connector is not answering right now.
          </Notice>
        </div>
      ) : null}
      {err || failed ? (
        <div className="mt-4">
          <Notice tone="error">{err ?? bank?.error ?? "The bank connection failed. Please try again."}</Notice>
        </div>
      ) : null}

      <div className="mt-5 text-center sm:text-left">
        <button type="button" onClick={() => void startLink()} disabled={working} className="text-body font-medium text-brand-strong underline-offset-2 hover:underline disabled:opacity-50">
          {busy === "link" ? "Opening Plaid…" : "Or connect with Plaid Link"}
        </button>
        {busy === "link" || token ? (
          <p className="mt-1 text-label text-ink-3">
            Sandbox login: <code className="rounded bg-surface-2 px-1 font-mono text-caption text-ink">user_good</code> / <code className="rounded bg-surface-2 px-1 font-mono text-caption text-ink">pass_good</code>
          </p>
        ) : null}
      </div>

      <StepFooter onBack={onBack} note={err || failed || offline ? <button type="button" onClick={onSkip} className="font-medium text-ink-2 underline underline-offset-2">Skip the bank for now</button> : undefined}>
        <Button size="lg" onClick={() => void connectProfile()} disabled={working || source === "loading"}>
          <BusyLabel busy={busy === "profile" || linking} busyText="Connecting…">
            <span className="truncate">{firstName ? `Connect ${firstName.replace(/^The /, "the ")}` : "Connect"}</span>
          </BusyLabel>
        </Button>
      </StepFooter>

      {token ? (
        <PlaidOpener
          token={token}
          onSuccess={(t) => void exchange(t)}
          onExit={() => {
            setToken(null);
            setBusy(null);
          }}
        />
      ) : null}
    </div>
  );
}
