"use client";
import { useState } from "react";
import { usePhoneAccess } from "@/lib/data/phone";
import { PHONE_NUMBER } from "@/lib/phone";
import { CallBrianCard } from "./CallBrianCard";

/** Optional last item of onboarding, under the agents' first insights: set a phone code, or skip (it lives in the header any time). */
export function OnboardingCallBrian({ householdId }: { householdId: string }) {
  const [hidden, setHidden] = useState(false);
  const access = usePhoneAccess(householdId);
  if (!PHONE_NUMBER || hidden) return null;
  return (
    <section aria-labelledby="call-brian-h" className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="call-brian-h" className="text-[0.95rem] font-semibold">
          One more thing <span className="font-normal text-ink-3">(optional)</span>
        </h2>
        <button type="button" onClick={() => setHidden(true)} className="rounded text-[0.82rem] font-medium text-ink-2 hover:text-ink hover:underline">
          {access.hasPin ? "Done" : "Skip for now"}
        </button>
      </div>
      <CallBrianCard householdId={householdId} className="mt-2.5" />
      <p className="mt-2 text-[0.78rem] leading-snug text-ink-3">You can always do this later from Call Brian in the top bar.</p>
    </section>
  );
}
