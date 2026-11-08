"use client";
import type { Ref } from "react";
import { IconBank, IconReceipt, IconShield } from "@/components/icons";
import { Button } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { StepFooter, StepHeading } from "../fields";

const READS = [
  { Icon: IconBank, title: "Balances", text: "Checking, savings, retirement, cards and loans." },
  { Icon: IconReceipt, title: "Transactions", text: "About six months of spending and deposits." },
  { Icon: IconShield, title: "Read-only", text: "Nothing can move money or change your bank." },
];

/** Step 1: what we read, and consent. The primary button is the consent, so there is nothing to tick first. */
export function WelcomeStep({ onContinue, onBack, headingRef }: { onContinue: () => void; onBack: () => void; headingRef: Ref<HTMLHeadingElement> }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onContinue();
      }}
    >
      <StepHeading headingRef={headingRef} title="Let's set up your household" sub="Six short steps, about two minutes. Here is what we will read once you connect a bank." />

      <ul className="space-y-4">
        {READS.map(({ Icon, title, text }, i) => (
          <li key={title} className="motion-rise flex items-start gap-3.5" style={{ ["--i" as string]: i + 1 }}>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-brand-strong">
              <Icon size={19} />
            </span>
            <span className="min-w-0 pt-0.5">
              <span className="block text-lead font-semibold leading-tight">{title}</span>
              <span className="mt-0.5 block text-body text-ink-2">{text}</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-6 rounded-lg border border-line bg-surface-2 px-3.5 py-3 text-label text-ink-2">
        <strong className="font-semibold text-ink">Sandbox only.</strong> The banks, accounts and people are synthetic test data. Nothing real is connected.
      </p>

      <StepFooter onBack={onBack} note={<>By continuing you agree that {PRODUCT_NAME} may read the sandbox data described above.</>}>
        <Button type="submit" size="lg">
          Agree and continue
        </Button>
      </StepFooter>
    </form>
  );
}
