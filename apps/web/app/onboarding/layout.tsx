import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";

export const metadata: Metadata = {
  title: "Set up your household",
  description: "Connect a sandbox bank, choose your accounts and answer a few questions. Your dashboard fills itself in.",
};

/**
 * The stepper lives here rather than in the pages so its state survives the move from /onboarding to
 * /onboarding/[householdId] when the household is created. The pages below only exist to own the two URLs.
 */
export default function OnboardingLayout() {
  return <OnboardingFlow />;
}
