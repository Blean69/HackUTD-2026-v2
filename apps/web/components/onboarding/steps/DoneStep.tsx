"use client";
import { useEffect, useRef, useState, type Ref } from "react";
import { IconArrowRight, IconCheck } from "@/components/icons";
import { Button } from "@/components/ui";
import { OnboardingCallBrian } from "@/components/phone/OnboardingCallBrian";
import { friendlyError, onboarding, useInsightsRun, type HouseholdProfile, type OnboardingBank } from "@/lib/data/onboarding";
import { AgentResults } from "../AgentResults";
import { Notice, StepFooter, StepHeading } from "../fields";
import { InviteButton } from "../PresenceBar";
import { SyncStatus } from "../SyncStatus";

/** Step 6: `finish_onboarding` once the import has settled, the agents' first pass live, then the hand-off. */
export function DoneStep({
  householdId, householdName, bank, profile, name, expectedAccounts, expectedTxns, onDashboard, onChooseAccounts, headingRef,
}: {
  householdId: string;
  householdName?: string;
  bank?: OnboardingBank;
  profile?: HouseholdProfile;
  name: string;
  expectedAccounts: number;
  expectedTxns?: number;
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
  const finished = run?.status === "done";

  // Finish once the import has caught up (so the agents read the full ledger), exactly once per attempt.
  useEffect(() => {
    if (alreadyDone || !canFinish || started.current === attempt) return;
    started.current = attempt;
    onboarding.finish(householdId).catch((e: unknown) => setErr(friendlyError(e, "We couldn't start the agents just yet.")));
  }, [alreadyDone, canFinish, attempt, householdId]);

  const first = name.split(" ")[0];
  return (
    <div>
      <div className="mb-1 flex items-center gap-3">
        <span className="motion-pop flex h-11 w-11 items-center justify-center rounded-full bg-good-soft text-good">
          <IconCheck size={22} strokeWidth={2.6} />
        </span>
      </div>
      <StepHeading
        headingRef={headingRef}
        title={`You're all set${first ? `, ${first}` : ""}`}
        sub={finished ? "Here is what your agents found. Everything is waiting on your dashboard." : "Your agents are reading your accounts now. Watch their first findings arrive."}
      />

      {needsChoice ? (
        <div className="mb-5">
          <Notice tone="warn" action={<Button variant="secondary" size="sm" onClick={onChooseAccounts}>Choose</Button>}>
            Pick which accounts to import first, so the agents see the whole picture.
          </Notice>
        </div>
      ) : bank && syncing ? (
        <div className="mb-6">
          <SyncStatus bank={bank} expectedAccounts={expectedAccounts} expectedTxns={expectedTxns} />
        </div>
      ) : null}

      {err ? (
        <div className="mb-5">
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

      {/* Optional and skippable: a 5-digit code so Brian knows whose accounts to open when this household calls. */}
      <OnboardingCallBrian householdId={householdId} />

      <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-label text-ink-2">
        <span>Planning together?</span>
        <InviteButton householdId={householdId} householdName={householdName} />
      </div>

      <StepFooter>
        <Button size="lg" onClick={onDashboard}>
          Open your dashboard <IconArrowRight size={18} />
        </Button>
      </StepFooter>
    </div>
  );
}
