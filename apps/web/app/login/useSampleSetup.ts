"use client";
import { useEffect, useRef, useState } from "react";
import { setLocalIdentity, suggestName, useLocalIdentity } from "@/lib/data/identity";
import {
  friendlyError, runSampleSetup, SampleSetupCancelled, SampleSetupError, type SampleFailure, type SamplePhase, type SandboxProfile,
} from "@/lib/data/onboarding";

/** One automatic setup, from the tap to the hand-off to the dashboard. */
export interface SampleRun {
  profile: SandboxProfile;
  /** Known as soon as `start_onboarding` has made the household (or from the start when resuming one). */
  householdId?: string;
  phase: SamplePhase;
  /** Nothing has moved for a while. The setup keeps waiting. */
  stalled: boolean;
  error: { message: string; kind: SampleFailure } | null;
  /** Everything is saved; the page is opening the dashboard. */
  done: boolean;
}

/**
 * Drives `runSampleSetup` for the Log in page. At most one run at a time: starting another cancels the first. The run is
 * cancelled when the page goes away. `onDone` gets the household id once it is ready to open.
 */
export function useSampleSetup(onDone: (householdId: string) => void) {
  const ident = useLocalIdentity();
  const [run, setRun] = useState<SampleRun | null>(null);
  const control = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      control.current?.abort();
    },
    [],
  );

  /** Start, or pick up an unfinished setup on `householdId`. `force` (Retry) asks for the import again. */
  function begin(profile: SandboxProfile, opts: { householdId?: string; force?: boolean } = {}): void {
    control.current?.abort();
    const mine = new AbortController();
    control.current = mine;
    // Visitors who skipped the name prompt join as a named guest, so the dashboard does not ask for one.
    let displayName = ident.name;
    if (!displayName) {
      displayName = suggestName();
      setLocalIdentity(displayName, "family");
    }
    const live = (patch: Partial<SampleRun>) => setRun((r) => (r && !mine.signal.aborted ? { ...r, ...patch } : r));
    setRun({ profile, householdId: opts.householdId, phase: opts.householdId ? "bank" : "household", stalled: false, error: null, done: false });

    runSampleSetup({
      profile,
      displayName,
      householdId: opts.householdId,
      force: opts.force,
      signal: mine.signal,
      onHousehold: (householdId) => live({ householdId }),
      onPhase: (phase) => live({ phase }),
      onStall: (stalled) => live({ stalled }),
    })
      .then((householdId) => {
        if (mine.signal.aborted) return;
        live({ householdId, done: true, stalled: false });
        onDone(householdId);
      })
      .catch((e: unknown) => {
        if (mine.signal.aborted || e instanceof SampleSetupCancelled) return;
        // SampleSetupError messages are already written for people; anything else goes through the wizard's wording.
        const known = e instanceof SampleSetupError;
        live({ stalled: false, error: { kind: known ? e.kind : "failed", message: known ? e.message : friendlyError(e, "Something went wrong while setting up. Please try again.") } });
      });
  }

  /** Stop waiting. The household stays on this device as an unfinished setup, so tapping the customer again resumes it. */
  function cancel(): void {
    control.current?.abort();
    control.current = null;
    setRun(null);
  }

  function retry(): void {
    if (run) begin(run.profile, { householdId: run.householdId, force: true });
  }

  return { run, begin, cancel, retry };
}
