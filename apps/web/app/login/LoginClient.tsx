"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { BrandMark, IconArrowRight, IconChevron, IconLock } from "@/components/icons";
import { leaveThen } from "@/components/motion";
import { Avatar, Button, Skeleton } from "@/components/ui";
import { DEMO_HOUSEHOLD_ID, PRODUCT_NAME } from "@/lib/constants";
import { useDataReady, useDataScope, useHousehold } from "@/lib/data/hooks";
import { setLocalIdentity, suggestName, useLocalIdentity } from "@/lib/data/identity";
import { useAllProfilesSubscription, useOnboardingMode, useOwnedHouseholds, type OwnedHousehold } from "@/lib/data/onboarding";
import { relTime } from "@/lib/format";
import { rememberHousehold } from "@/lib/lastHousehold";

function statusLine(h: OwnedHousehold): string {
  if (h.status === "copy") return `Private copy · created ${relTime(h.household.created_at)}`;
  if (h.finished) return `Set up ${relTime(h.household.created_at)}`;
  return "Setup not finished";
}

/**
 * /login: no passwords. The households this browser's identity created (its SpacetimeDB token lives in this browser),
 * each one tap away, plus the seeded demo household for anyone who wants to skip setup.
 */
export function LoginClient() {
  const router = useRouter();
  useDataScope("lobby");
  const ready = useDataReady();
  const mode = useOnboardingMode();
  useAllProfilesSubscription(mode);
  const mine = useOwnedHouseholds();
  const demo = useHousehold(DEMO_HOUSEHOLD_ID);
  const ident = useLocalIdentity();
  const box = useRef<HTMLDivElement>(null);

  const open = (href: string, householdId?: string) => {
    if (householdId) rememberHousehold(householdId);
    leaveThen(box.current, () => router.push(href));
  };
  const openDemo = () => {
    // Judges skip the name prompt: they join as a named guest and can rename themselves later.
    if (!ident.name) setLocalIdentity(suggestName(), "guest");
    open(`/room/${DEMO_HOUSEHOLD_ID}`, DEMO_HOUSEHOLD_ID);
  };

  return (
    <div className="min-h-dvh bg-bg text-ink">
      <header className="mx-auto flex h-16 w-full max-w-md items-center px-4 sm:px-0">
        <Link href="/" className="flex items-center gap-2.5 rounded-md" aria-label={`${PRODUCT_NAME} home`}>
          <BrandMark size={26} />
          <span className="display text-[1.08rem]">{PRODUCT_NAME}</span>
        </Link>
      </header>

      <div ref={box} className="mx-auto w-full max-w-md px-4 pb-10 pt-4 sm:px-0 sm:pt-8">
        <main id="main" className="motion-rise card !rounded-xl p-5 sm:p-8">
          <h1 className="display text-h1">Log in</h1>
          <p className="mt-2 flex items-start gap-2 text-body text-ink-2">
            <IconLock size={15} className="mt-0.5 shrink-0 text-ink-3" />
            <span>In this demo, sign-in is tied to this device, so there is no password.</span>
          </p>

          <section aria-labelledby="mine-h" className="mt-7">
            <h2 id="mine-h" className="eyebrow">
              Households on this device
            </h2>
            {!ready ? (
              <div className="mt-2 space-y-2" role="status" aria-label="Loading your households">
                <Skeleton className="h-[4.25rem] w-full !rounded-lg" />
              </div>
            ) : mine.length === 0 ? (
              <p className="mt-2 rounded-lg bg-surface-2 px-4 py-3.5 text-body text-ink-2">
                None yet.{" "}
                <Link href="/onboarding" className="font-semibold text-brand-strong underline-offset-2 hover:underline">
                  Set one up
                </Link>{" "}
                in about two minutes.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {mine.map((h, i) => {
                  const href = h.finished ? `/room/${encodeURIComponent(h.household.id)}` : `/onboarding/${encodeURIComponent(h.household.id)}`;
                  return (
                    <li key={h.household.id} className="motion-fade" style={{ ["--i" as string]: i }}>
                      <button type="button" onClick={() => open(href, h.household.id)} className="press group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2">
                        <Avatar name={h.household.name} size={36} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body font-semibold">{h.household.name}</span>
                          <span className="block text-caption text-ink-3">{statusLine(h)}</span>
                        </span>
                        <span className="inline-flex items-center gap-1 text-label font-semibold text-brand-strong">
                          {h.finished ? "Open" : "Resume"}
                          <IconChevron size={16} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="my-7 flex items-center gap-3 text-caption text-ink-3" aria-hidden="true">
            <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
          </div>

          <section aria-labelledby="demo-h">
            <h2 id="demo-h" className="sr-only">
              Demo account
            </h2>
            <Button size="lg" variant={ready && mine.length === 0 ? "primary" : "secondary"} className="group w-full" onClick={openDemo}>
              Use the demo account <IconArrowRight size={17} className="transition-transform duration-150 group-hover:translate-x-0.5" />
            </Button>
            <p className="mt-2 text-center text-caption text-ink-3">
              {demo?.name ?? "The Rivera family"}, a fully set-up synthetic household. Skips setup.
            </p>
          </section>
        </main>

        <p className="mt-6 text-center text-body text-ink-2">
          New here?{" "}
          <Link href="/onboarding" className="font-semibold text-brand-strong underline-offset-2 hover:underline">
            Get started
          </Link>
        </p>
      </div>
    </div>
  );
}
