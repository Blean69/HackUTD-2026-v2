"use client";
import { useEffect, useRef, useState, type Ref } from "react";
import { IconArrowRight } from "@/components/icons";
import { Button } from "@/components/ui";
import { friendlyError, onboarding, useInsightsRun, type HouseholdProfile, type OnboardingBank } from "@/lib/data/onboarding";
import { AgentResults } from "../AgentResults";
import { Notice, StepFooter, StepHeading } from "../fields";
import { SyncStatus } from "../SyncStatus";

/** Step 6: `finish_onboarding`, then the assistant's work in plain words, then the way into the dashboard. */
export function DoneStep({
  householdId, bank, profile, name, onDashboard, onChooseAccounts, headingRef,
}: {
  householdId: string;
  bank?: OnboardingBank;
  profile?: HouseholdProfile;
  name: string;
  onDashboard: () => void;
  onChooseAccounts: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const { run } = useInsightsRun(householdId);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);

  const syncing = bank?.status === "syncing" || bank?.status === "linking";
  const needsChoice = bank?.status === "selecting";
  const alreadyDone = profile?.status === "done" || !!run;
  // The module refuses to finish mid-sync or before accounts are chosen, so wait for the bank to settle.
  const canFinish = !syncing && !needsChoice;

  // Finish once the bank has caught up (so the agent reads the full ledger), exactly once per attempt.
  useEffect(() => {
    if (alreadyDone || !canFinish || started.current === attempt) return;
    started.current = attempt;
    onboarding.finish(householdId).catch((e: unknown) => setErr(friendlyError(e, "We couldn't wrap up just yet.")));
  }, [alreadyDone, canFinish, attempt, householdId]);

  return (
    <div>
      <StepHeading
        headingRef={headingRef}
        title={`You're all set${name ? `, ${name.split(" ")[0]}` : ""}`}
        sub="Your dashboard is ready. While you are here, watch your assistant take a first pass through the numbers."
      />

      {needsChoice ? (
        <div className="mb-4">
          <Notice
            tone="warn"
            action={
              <Button variant="secondary" size="sm" onClick={onChooseAccounts}>
                Choose accounts
              </Button>
            }
          >
            Pick which accounts to import first, so your assistant sees the whole picture.
          </Notice>
        </div>
      ) : bank ? (
        <div className="mb-4">
          <SyncStatus bank={bank} compact />
          {syncing ? <p className="mt-2 text-[0.8rem] text-ink-2">Your assistant starts as soon as the sync finishes, so nothing is missed. Your dashboard is ready whenever you are.</p> : null}
        </div>
      ) : null}

      {err ? (
        <div className="mb-4">
          <Notice
            tone="error"
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setErr(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </Button>
            }
          >
            {err} Your dashboard still works.
          </Notice>
        </div>
      ) : null}

      <AgentResults householdId={householdId} waiting={!canFinish} />

      <StepFooter>
        <Button size="lg" onClick={onDashboard}>
          Go to my dashboard <IconArrowRight size={18} />
        </Button>
      </StepFooter>
    </div>
  );
}
