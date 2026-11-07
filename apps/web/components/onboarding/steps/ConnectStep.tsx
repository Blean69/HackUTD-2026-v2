"use client";
import { useEffect, useState, type Ref } from "react";
import { usePlaidLink } from "react-plaid-link";
import { IconBolt, IconLock } from "@/components/icons";
import { Button } from "@/components/ui";
import { friendlyError, onboarding, type OnboardingBank, type OnboardingMode } from "@/lib/data/onboarding";
import { checkWorker, useWorkerStatus } from "@/lib/worker";
import { BusyLabel, Notice, StepFooter, StepHeading } from "../fields";
import { SyncStatus } from "../SyncStatus";

/** Mounts only once a link token exists and opens Plaid Link as soon as it is ready. */
function PlaidOpener({ token, onSuccess, onExit }: { token: string; onSuccess: (publicToken: string) => void; onExit: () => void }) {
  const { open, ready } = usePlaidLink({ token, onSuccess: (publicToken) => (publicToken ? onSuccess(publicToken) : onExit()), onExit });
  useEffect(() => {
    if (ready) open();
  }, [ready, open]);
  return null;
}

/** Step 3: connect a bank with Plaid Link, or one tap to the demo bank. */
export function ConnectStep({
  householdId, bank, mode, onBack, onSkip, onContinue, headingRef,
}: {
  householdId: string;
  bank?: OnboardingBank;
  mode: OnboardingMode;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
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
  const selecting = bank?.status === "selecting";
  const connected = selecting || bank?.status === "syncing" || bank?.status === "ok";
  const disabled = busy !== null || linking;
  const offline = mode === "live" && worker === "down";

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
  async function demo() {
    setErr(null);
    setBusy("demo");
    try {
      await onboarding.connectDemo(householdId);
    } catch (e) {
      setErr(friendlyError(e, "We couldn't reach the demo bank. Please try again."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <StepHeading headingRef={headingRef} title="Connect a bank" sub="Link a sandbox bank so your assistant has real-looking numbers to work with. You choose which accounts to share on the next screen." />

      {offline ? (
        <div className="mb-4">
          <Notice
            tone="warn"
            action={
              <Button variant="secondary" size="sm" onClick={() => checkWorker(true)}>
                Check again
              </Button>
            }
          >
            The bank connector looks offline right now. You can still try, explore the demo household, or skip this step and add accounts later.
          </Notice>
        </div>
      ) : null}
      {mode === "mock" ? (
        <div className="mb-4">
          <Notice tone="info">Offline demo: no real bank call is made. Both buttons load the same pretend bank.</Notice>
        </div>
      ) : null}

      {connected ? null : (
      <div className="space-y-3">
        <div>
          <Button size="lg" className="w-full" onClick={() => void startLink()} disabled={disabled}>
            <BusyLabel busy={busy === "link"} busyText="Opening Plaid…">
              <IconLock size={18} /> Connect with Plaid
            </BusyLabel>
          </Button>
          <p className="mt-2 text-center text-[0.8rem] text-ink-2">
            Sandbox login: <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.78rem] text-ink">user_good</code> / <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.78rem] text-ink">pass_good</code>
          </p>
        </div>

        <div className="flex items-center gap-3 text-[0.78rem] text-ink-3" aria-hidden="true">
          <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
        </div>

        <div>
          <Button variant="secondary" size="lg" className="w-full" onClick={() => void demo()} disabled={disabled}>
            <BusyLabel busy={busy === "demo"} busyText="Connecting…">
              <IconBolt size={18} /> Use the demo bank (one tap)
            </BusyLabel>
          </Button>
          <p className="mt-2 text-center text-[0.8rem] text-ink-2">A pretend bank with checking, savings, a card, a mortgage and six months of activity.</p>
        </div>
      </div>
      )}

      {err && !(offline && err.startsWith("We couldn't reach")) ? (
        <div className="mt-4">
          <Notice tone="error">{err}</Notice>
        </div>
      ) : null}

      {bank ? (
        <div className="mt-5">
          <SyncStatus bank={bank} />
          {bank.status === "error" ? <p className="mt-2 text-[0.82rem] text-ink-2">Tap either button above to try again.</p> : null}
          {connected ? <p className="mt-2 text-[0.82rem] text-ink-2">{selecting ? "Next you will choose which of these accounts to share." : "Your accounts are on their way in. You can add another bank from your dashboard later."}</p> : null}
        </div>
      ) : null}

      <StepFooter onBack={onBack}>
        {selecting ? (
          <Button size="lg" onClick={onContinue}>
            Choose accounts
          </Button>
        ) : connected ? (
          <Button size="lg" onClick={onSkip}>
            Continue
          </Button>
        ) : (
          <Button variant="secondary" size="lg" onClick={onSkip} disabled={linking}>
            Skip for now
          </Button>
        )}
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
