"use client";
import Link from "next/link";
import { useState, type Ref } from "react";
import { IconBank, IconLock, IconReceipt, IconShield } from "@/components/icons";
import { Button } from "@/components/ui";
import { DEMO_HOUSEHOLD_ID } from "@/lib/constants";
import { Notice, StepFooter, StepHeading } from "../fields";

const READS = [
  { Icon: IconBank, title: "Balances", text: "What is in each checking, savings, retirement and loan account." },
  { Icon: IconReceipt, title: "Transactions", text: "The last few months of spending and deposits, so we can see where money goes." },
  { Icon: IconLock, title: "Loans and cards", text: "How much you owe and your monthly payments." },
];

export function WelcomeStep({ onContinue, headingRef }: { onContinue: () => void; headingRef: Ref<HTMLHeadingElement> }) {
  const [agreed, setAgreed] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (agreed) onContinue();
      }}
    >
      <StepHeading
        headingRef={headingRef}
        title="Let's set up your family's financial room"
        sub="It takes about two minutes. You will connect a bank, choose which accounts to include, and answer a few friendly questions. Then your assistant gets to work."
      />

      <section aria-labelledby="reads-h">
        <h2 id="reads-h" className="mb-2 text-[0.9rem] font-semibold">
          What we will read
        </h2>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {READS.map(({ Icon, title, text }) => (
            <li key={title} className="flex items-start gap-3 px-3.5 py-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-strong">
                <Icon size={17} />
              </span>
              <div>
                <p className="text-[0.9rem] font-medium leading-tight">{title}</p>
                <p className="mt-0.5 text-[0.82rem] leading-snug text-ink-2">{text}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 flex items-center gap-1.5 text-[0.8rem] text-ink-2">
          <IconShield size={15} className="shrink-0 text-brand-strong" /> Read-only. We cannot move money or change anything at your bank.
        </p>
      </section>

      <div className="mt-4">
        <Notice tone="info">
          <strong className="font-semibold text-ink">This is a sandbox.</strong> The bank, the accounts and the money are all fake test data. Nothing real is connected, and nothing here can cost you a cent.
        </Notice>
      </div>

      <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-line-strong bg-surface px-3.5 py-3.5 has-[:checked]:border-brand has-[:checked]:bg-brand-soft/40">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-brand" />
        <span className="text-[0.9rem] leading-snug">
          <span className="font-medium">I agree.</span> I understand this is a sandbox with fake money, and I am happy for Cosign to read the sandbox bank data described above.
        </span>
      </label>

      <StepFooter note={agreed ? undefined : "Tick the box above to continue."}>
        <Button type="submit" size="lg" disabled={!agreed}>
          Continue
        </Button>
      </StepFooter>

      <p className="mt-4 text-center text-[0.84rem] text-ink-2">
        Just looking around?{" "}
        <Link href={`/room/${DEMO_HOUSEHOLD_ID}`} className="font-semibold text-brand-strong underline underline-offset-2">
          Explore the demo household instead
        </Link>
      </p>
    </form>
  );
}
