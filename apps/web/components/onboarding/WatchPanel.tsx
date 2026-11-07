"use client";
import type { Ref } from "react";
import { IconCheck } from "@/components/icons";
import { Button, Spinner } from "@/components/ui";
import { cx } from "@/lib/format";
import { STEPS, type OnboardingBank } from "@/lib/data/onboarding";
import type { PresenceView } from "@/lib/data/hooks";
import type { Household } from "@/lib/types";
import { AgentResults } from "./AgentResults";
import { StepHeading } from "./fields";
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
  household, step, bank, owner, onTakeOver, onDashboard, headingRef,
}: {
  household: Household;
  step: number;
  bank?: OnboardingBank;
  owner?: PresenceView;
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

      <ol className="mb-5 space-y-1.5" aria-label="Setup steps">
        {STEPS.map((s, i) => {
          const done = i < step || (finished && i === step);
          const active = i === step && !finished;
          return (
            <li key={s.key} className={cx("flex items-center gap-2.5 text-[0.9rem]", active ? "font-semibold text-ink" : done ? "text-ink-2" : "text-ink-3")} aria-current={active ? "step" : undefined}>
              <span className={cx("flex h-5 w-5 items-center justify-center rounded-full border text-[0.68rem]", done ? "border-brand bg-brand text-white" : active ? "border-brand-strong text-brand-strong" : "border-line-strong")}>
                {done ? <IconCheck size={12} strokeWidth={3} /> : active ? <Spinner size={11} /> : <span className="num">{i + 1}</span>}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>

      {bank && step >= 2 && step < 5 ? <SyncStatus bank={bank} /> : null}
      {finished ? <AgentResults householdId={household.id} /> : null}

      <div className="pb-safe sticky bottom-0 z-10 -mx-4 mt-6 border-t border-line bg-surface px-4 pt-3 sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!finished ? (
            <Button variant="secondary" size="lg" onClick={onTakeOver}>
              Help set this up
            </Button>
          ) : null}
          <Button size="lg" onClick={onDashboard}>
            {finished ? "Go to the dashboard" : "Peek at the dashboard"}
          </Button>
        </div>
      </div>
    </div>
  );
}
