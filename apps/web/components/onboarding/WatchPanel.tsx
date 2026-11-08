"use client";
import type { Ref } from "react";
import { IconCheck } from "@/components/icons";
import { Button } from "@/components/ui";
import { cx } from "@/lib/format";
import { STEPS, type OnboardingBank } from "@/lib/data/onboarding";
import type { PresenceView } from "@/lib/data/hooks";
import type { Household } from "@/lib/types";
import { AgentResults } from "./AgentResults";
import { StepFooter, StepHeading } from "./fields";
import { SyncStatus } from "./SyncStatus";

const WHAT: Record<number, string> = {
  1: "is getting started",
  2: "is connecting a bank",
  3: "is choosing which accounts to share",
  4: "is answering a few questions",
  5: "has finished setting up",
};

/** What a family member sees when they open the shared link: the same progress, live, with a way to pitch in. */
export function WatchPanel({
  household, step, bank, owner, expectedAccounts, onTakeOver, onDashboard, headingRef,
}: {
  household: Household;
  step: number;
  bank?: OnboardingBank;
  owner?: PresenceView;
  expectedAccounts: number;
  onTakeOver: () => void;
  onDashboard: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const finished = step >= 5;
  const s = Math.max(1, Math.min(5, step));
  const status = owner ? `${owner.display_name.split(" ")[0]} ${WHAT[s]}.` : finished ? "Setup is finished." : "Setup is in progress.";
  return (
    <div>
      <StepHeading headingRef={headingRef} title={`Following ${household.name}`} sub={`${status} This page updates by itself.`} />

      <ol className="mb-6 space-y-2" aria-label="Setup steps">
        {STEPS.map((st, i) => {
          const done = i < step || (finished && i === step);
          const active = i === step && !finished;
          return (
            <li key={st.key} className={cx("flex items-center gap-2.5 text-[0.92rem]", active ? "font-semibold text-ink" : done ? "text-ink-2" : "text-ink-3")} aria-current={active ? "step" : undefined}>
              <span className={cx("flex h-5 w-5 items-center justify-center rounded-full border text-[0.68rem]", done ? "border-brand bg-brand text-white" : active ? "border-brand" : "border-line-strong")}>
                {done ? <IconCheck size={12} strokeWidth={3} /> : active ? <span className="anim-blink h-1.5 w-1.5 rounded-full bg-brand" /> : <span className="num">{i + 1}</span>}
              </span>
              {st.label}
            </li>
          );
        })}
      </ol>

      {bank && step >= 2 && step < 5 && bank.status !== "selecting" ? <SyncStatus bank={bank} expectedAccounts={expectedAccounts} /> : null}
      {finished ? <AgentResults householdId={household.id} /> : null}

      <StepFooter>
        {!finished ? (
          <Button variant="secondary" size="lg" onClick={onTakeOver}>
            Help set this up
          </Button>
        ) : null}
        <Button size="lg" onClick={onDashboard}>
          {finished ? "Open the dashboard" : "Peek at the dashboard"}
        </Button>
      </StepFooter>
    </div>
  );
}
