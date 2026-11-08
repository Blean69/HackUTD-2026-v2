"use client";
import { useState, type Ref } from "react";
import { IconCheck } from "@/components/icons";
import { Button } from "@/components/ui";
import { friendlyError, onboarding } from "@/lib/data/onboarding";
import { setLocalIdentity } from "@/lib/data/identity";
import type { Household } from "@/lib/types";
import { BusyLabel, Notice, StepFooter, StepHeading, TextField } from "../fields";

const suggested = (name: string) => {
  const first = name.trim().split(/\s+/)[0];
  return first ? `${first}'s household` : "";
};

/** Step 2: your name, and a household name that fills itself in from it (`start_onboarding`). */
export function HouseholdStep({
  household, defaultName, onBack, onCreated, onContinue, headingRef,
}: {
  household?: Household;
  defaultName: string;
  onBack: () => void;
  onCreated: (householdId: string) => void;
  onContinue: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const [me, setMe] = useState(defaultName);
  const [hName, setHName] = useState<string | null>(null); // null: follow the suggestion
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (household) {
    return (
      <div>
        <StepHeading headingRef={headingRef} title="Your household is ready" sub="You can rename it and add family members from the dashboard at any time." />
        <div className="motion-rise flex items-center gap-3 rounded-lg border border-line px-4 py-3.5">
          <span className="motion-pop flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-good-soft text-good">
            <IconCheck size={18} strokeWidth={2.4} />
          </span>
          <p className="min-w-0 truncate text-[1rem] font-semibold">{household.name}</p>
        </div>
        <StepFooter onBack={onBack}>
          <Button size="lg" onClick={onContinue}>
            Continue
          </Button>
        </StepFooter>
      </div>
    );
  }

  const householdName = (hName ?? suggested(me)).trim();
  const ok = me.trim().length > 0 && householdName.length > 0;
  async function submit() {
    if (!ok || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const id = await onboarding.start(householdName, me.trim());
      setLocalIdentity(me.trim(), "family");
      onCreated(id);
    } catch (e) {
      setErr(friendlyError(e, "We couldn't create your household. Please try again."));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <StepHeading headingRef={headingRef} title="Who is setting this up?" sub="Your name is shown to family members who join you." />
      <div className="space-y-5">
        <TextField id="your-name" label="Your first name" value={me} onChange={setMe} placeholder="Alex" autoComplete="given-name" maxLength={32} required autoFocus />
        <TextField
          id="household-name"
          label="Household name"
          value={hName ?? suggested(me)}
          onChange={setHName}
          placeholder="Alex's household"
          autoComplete="off"
          hint="Change it to whatever your family calls itself."
          required
        />
      </div>
      {err ? (
        <div className="mt-5">
          <Notice tone="error">{err}</Notice>
        </div>
      ) : null}
      <StepFooter onBack={onBack}>
        <Button type="submit" size="lg" disabled={!ok || busy}>
          <BusyLabel busy={busy} busyText="Creating…">
            Continue
          </BusyLabel>
        </Button>
      </StepFooter>
    </form>
  );
}
