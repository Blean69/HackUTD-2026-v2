"use client";
import dynamic from "next/dynamic";
import { useEffect, useState, type Ref } from "react";
import { IconArrowRight, IconCheck } from "@/components/icons";
import { Button } from "@/components/ui";
import { friendlyError, onboarding, type OnboardingBank, type OnboardingMode } from "@/lib/data/onboarding";
import { checkWorker, useWorkerStatus } from "@/lib/worker";
import { BusyLabel, Notice, StepFooter, StepHeading } from "../fields";

const PlaidOpener = dynamic(() => import("../PlaidOpener"), { ssr: false });

/**
 * Step 3: connect a sandbox bank. The primary way is Plaid Link (Plaid's own sandbox UI); the secondary one is the demo
 * bank, a ready-made household connected with one tap. The PNC sample customers are not offered here: they live on the
 * Log in page.
 */
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
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<"link" | "demo" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (mode === "live") checkWorker();
  }, [mode]);

  const linking = bank?.status === "linking";
  const connected = bank?.status === "selecting" || bank?.status === "syncing" || bank?.status === "ok";
  const working = busy !== null || linking;
  const offline = mode === "live" && worker === "down";

  async function connectDemoBank() {
    setErr(null);
    setBusy("demo");
    try {
      await onboarding.connectDemo(householdId);
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
        await onboarding.connectDemo(householdId);
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

  const failed = bank?.status === "error";
  return (
    <div>
      <StepHeading headingRef={headingRef} title="Connect your bank" sub="Link a sandbox bank through Plaid. You choose which of its accounts to share next." />

      <Button size="lg" className="group w-full" onClick={() => void startLink()} disabled={working}>
        <BusyLabel busy={busy === "link"} busyText="Opening Plaid…">
          Connect with Plaid <IconArrowRight size={17} className="transition-transform duration-150 group-hover:translate-x-0.5" />
        </BusyLabel>
      </Button>
      <p className="mt-2.5 text-center text-label text-ink-3">
        Sandbox login: <code className="rounded bg-surface-2 px-1 font-mono text-caption text-ink">user_good</code> / <code className="rounded bg-surface-2 px-1 font-mono text-caption text-ink">pass_good</code>
      </p>

      <div className="my-6 flex items-center gap-3 text-caption text-ink-3" aria-hidden="true">
        <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
      </div>

      <Button variant="secondary" size="lg" className="w-full" onClick={() => void connectDemoBank()} disabled={working}>
        <BusyLabel busy={busy === "demo" || linking} busyText="Connecting…">
          Use the demo bank (one tap)
        </BusyLabel>
      </Button>
      <p className="mt-2.5 text-center text-label text-ink-3">A ready-made household with a mortgage, a car loan, a card and savings. No login needed.</p>

      {linking ? (
        <div className="mt-5 flex items-center gap-3 rounded-lg bg-surface-2 px-4 py-3" role="status" aria-live="polite">
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
            <span className="anim-blink absolute inset-0 rounded-full bg-brand" />
          </span>
          <span className="text-body text-ink-2">
            Connecting to <strong className="font-semibold text-ink">{bank?.institution_name || "the sandbox bank"}</strong> and finding accounts…
          </span>
        </div>
      ) : null}

      {offline && !linking ? (
        <div className="mt-5">
          <Notice tone="warn" action={<Button variant="secondary" size="sm" onClick={() => checkWorker(true)}>Check again</Button>}>
            The bank connector is not answering right now.
          </Notice>
        </div>
      ) : null}
      {err || failed ? (
        <div className="mt-5">
          <Notice tone="error">{err ?? bank?.error ?? "The bank connection failed. Please try again."}</Notice>
        </div>
      ) : null}

      <StepFooter onBack={onBack} note={err || failed || offline ? <button type="button" onClick={onSkip} className="font-medium text-ink-2 underline underline-offset-2">Skip the bank for now</button> : undefined} />

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
