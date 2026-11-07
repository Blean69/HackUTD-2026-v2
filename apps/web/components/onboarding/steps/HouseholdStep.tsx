"use client";
import { useState, type Ref } from "react";
import { IconCheck } from "@/components/icons";
import { Button } from "@/components/ui";
import { friendlyError, onboarding } from "@/lib/data/onboarding";
import { setLocalIdentity } from "@/lib/data/identity";
import type { Household } from "@/lib/types";
import { BusyLabel, Notice, StepFooter, StepHeading, TextField } from "../fields";
import { InviteButton } from "../PresenceBar";

/** Step 2: create the household (`start_onboarding`). Revisiting it after creation shows who is here and how to invite. */
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
  const [hName, setHName] = useState("");
  const [me, setMe] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (household) {
    return (
      <div>
        <StepHeading headingRef={headingRef} title="Your household is ready" sub="Anyone with the link can open this setup and watch it fill in live. Send it to a family member now, or later." />
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3.5 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-good-soft text-good">
            <IconCheck size={18} strokeWidth={2.4} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[0.95rem] font-semibold">{household.name}</p>
            <p className="text-[0.8rem] text-ink-2">Created just now</p>
          </div>
        </div>
        <div className="mt-4">
          <InviteButton householdId={household.id} householdName={household.name} />
        </div>
        <StepFooter onBack={onBack}>
          <Button size="lg" onClick={onContinue}>
            Continue
          </Button>
        </StepFooter>
      </div>
    );
  }

  const ok = hName.trim().length > 0 && me.trim().length > 0;
  async function submit() {
    if (!ok || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const id = await onboarding.start(hName.trim(), me.trim());
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
      <StepHeading headingRef={headingRef} title="Who are we setting up?" sub="Just two names to start. You can add the rest of the household in a minute." />
      <div className="space-y-4">
        <TextField id="household-name" label="Household name" value={hName} onChange={setHName} placeholder="The Garcia household" autoComplete="off" hint="Whatever your family calls itself." required autoFocus />
        <TextField id="your-name" label="Your name" value={me} onChange={setMe} placeholder="Alex" autoComplete="given-name" maxLength={32} required />
      </div>
      {err ? (
        <div className="mt-4">
          <Notice tone="error">{err}</Notice>
        </div>
      ) : null}
      <StepFooter onBack={onBack} note={ok ? undefined : "Fill in both names to continue."}>
        <Button type="submit" size="lg" disabled={!ok || busy}>
          <BusyLabel busy={busy} busyText="Creating…">
            Create household
          </BusyLabel>
        </Button>
      </StepFooter>
    </form>
  );
}
