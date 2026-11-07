"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrandMark } from "@/components/icons";
import { Chip, Skeleton } from "@/components/ui";
import { DEMO_HOUSEHOLD_ID, PRODUCT_NAME, SYNTHETIC_NOTE } from "@/lib/constants";
import { useConnection } from "@/lib/data/connection";
import { joinRoom } from "@/lib/data/actions";
import { useDataReady, useDataScope, useHousehold, usePresence } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import {
  deriveStep, useAccountOptions, useInsightsRun, useOnboardingBank, useOnboardingMode, useOnboardingSubscription, useProfile,
} from "@/lib/data/onboarding";
import { rememberHousehold } from "@/lib/lastHousehold";
import { JoinCard } from "./JoinCard";
import { PresenceBar } from "./PresenceBar";
import { Stepper } from "./Stepper";
import { AboutStep } from "./steps/AboutStep";
import { AccountsStep } from "./steps/AccountsStep";
import { ConnectStep } from "./steps/ConnectStep";
import { DoneStep } from "./steps/DoneStep";
import { HouseholdStep } from "./steps/HouseholdStep";
import { WelcomeStep } from "./steps/WelcomeStep";
import { WatchPanel } from "./WatchPanel";

const GRACE_MS = 3500;

function Loading() {
  return (
    <div role="status" aria-label="Loading setup" className="space-y-3">
      <Skeleton className="h-7 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="mt-4 h-24 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

function NotFound({ offline }: { offline: boolean }) {
  return (
    <div>
      <h1 className="text-[1.3rem] font-semibold leading-tight tracking-tight">We couldn&apos;t find that household</h1>
      <p className="mt-2 text-[0.92rem] leading-relaxed text-ink-2">
        {offline
          ? "You are in the offline demo, which does not keep your progress when the page reloads. Start again, it only takes a minute."
          : "The link may be mistyped, or the household was removed. You can start a new setup or look around the demo."}
      </p>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Link href="/onboarding" className="inline-flex h-12 items-center justify-center rounded-md bg-brand px-5 text-[0.95rem] font-semibold text-brand-ink hover:bg-brand-strong">
          Start a new setup
        </Link>
        <Link href={`/room/${DEMO_HOUSEHOLD_ID}`} className="inline-flex h-12 items-center justify-center rounded-md border border-line-strong bg-surface px-5 text-[0.95rem] font-semibold hover:bg-surface-2">
          Explore the demo household
        </Link>
      </div>
    </div>
  );
}

/**
 * The whole onboarding stepper (docs/contracts.md section 7). Lives in the /onboarding layout so it survives the
 * move from /onboarding to /onboarding/[householdId] when the household is created.
 *
 * Step source of truth: the household's stored state (profile status + bank connection + insights run), so a refresh
 * resumes and a family member who opens the link follows along. The driver (the person who created the household,
 * or anyone who taps "Help set this up") moves between steps locally on top of that.
 */
export function OnboardingFlow() {
  const params = useParams<{ householdId?: string | string[] }>();
  const router = useRouter();
  const raw = Array.isArray(params.householdId) ? params.householdId[0] : params.householdId;
  const householdId = raw ? decodeURIComponent(raw) : undefined;

  const mode = useOnboardingMode();
  useDataScope(householdId ? "room" : "lobby", householdId ?? "");
  useOnboardingSubscription(householdId, mode);
  const dataReady = useDataReady() && mode !== "detecting";
  const conn = useConnection();
  const ident = useLocalIdentity();
  const household = useHousehold(householdId ?? "");
  const profile = useProfile(householdId);
  const bank = useOnboardingBank(householdId);
  const options = useAccountOptions(householdId);
  const { run } = useInsightsRun(householdId);
  const present = usePresence(householdId ?? "");

  // Only the first load shows a skeleton; later scope changes keep the screen steady.
  const [booted, setBooted] = useState(false);
  if (dataReady && !booted) setBooted(true);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!booted || !householdId) return;
    const t = setTimeout(() => setWaited(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [booted, householdId]);

  const [navStep, setNavStep] = useState<number | null>(null);
  const [takeOver, setTakeOver] = useState(false);
  const [advancedFor, setAdvancedFor] = useState("");

  const isOwner = !!household && (!household.owner || household.owner === conn.identity);
  const drive = !householdId || isOwner || takeOver;
  const derived = householdId ? deriveStep({ status: profile?.status, bank, hasRun: !!run }) : 0;
  const step = householdId && !drive ? derived : (navStep ?? derived);

  // Bank found its accounts: move a driver on to choosing them (once per bank connection).
  if (drive && householdId && step === 2 && bank?.status === "selecting" && options.length > 0 && advancedFor !== bank.item_id) {
    setAdvancedFor(bank.item_id);
    setNavStep(3);
  }

  // Presence: everyone with the link shows up as a chip.
  useEffect(() => {
    if (dataReady && householdId && ident.name) void joinRoom(householdId, ident.name, "family").catch(() => undefined);
  }, [dataReady, householdId, ident.name]);

  // Move focus to the new step's heading (keyboard and screen reader users), skipping the first paint.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!drive) return;
    headingRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [step, drive]);

  const goTo = (n: number) => setNavStep(n);
  const toDashboard = () => {
    if (!householdId) return;
    rememberHousehold(householdId);
    router.push(`/room/${encodeURIComponent(householdId)}`);
  };

  let body: ReactNode;
  const needProfile = !!householdId && navStep === null && !profile && mode === "live" && !waited;
  if (!booted) {
    body = <Loading />;
  } else if (householdId && !household) {
    body = waited ? <NotFound offline={mode === "mock"} /> : <Loading />;
  } else if (householdId && household && !ident.name && ident.ready) {
    body = <JoinCard householdName={household.name} />;
  } else if (needProfile) {
    body = <Loading />;
  } else if (householdId && household && !drive) {
    const ownerPresence = present.find((p) => p.identity === household.owner);
    body = <WatchPanel household={household} step={derived} bank={bank} owner={ownerPresence} onTakeOver={() => setTakeOver(true)} onDashboard={toDashboard} headingRef={headingRef} />;
  } else if (!householdId && step >= 2) {
    body = <Loading />; // household created; the URL is about to gain its id
  } else if (step === 0 || (!householdId && step < 1)) {
    body = <WelcomeStep onContinue={() => goTo(1)} headingRef={headingRef} />;
  } else if (step === 1 || !householdId) {
    body = (
      <HouseholdStep
        household={household}
        defaultName={ident.name ?? ""}
        onBack={() => goTo(0)}
        onCreated={(id) => {
          setNavStep(2);
          router.replace(`/onboarding/${encodeURIComponent(id)}`);
        }}
        onContinue={() => goTo(2)}
        headingRef={headingRef}
      />
    );
  } else if (step === 2 && householdId) {
    body = <ConnectStep householdId={householdId} bank={bank} mode={mode} onBack={() => goTo(1)} onSkip={() => goTo(4)} onContinue={() => goTo(3)} headingRef={headingRef} />;
  } else if (step === 3 && householdId) {
    body = <AccountsStep householdId={householdId} bank={bank} options={options} onBack={() => goTo(2)} onBackToConnect={() => goTo(2)} onDone={() => goTo(4)} headingRef={headingRef} />;
  } else if (step === 4 && householdId) {
    body = <AboutStep householdId={householdId} bank={bank} profile={profile} defaultName={ident.name ?? ""} onBack={() => goTo(bank?.status === "selecting" ? 3 : 2)} onDone={() => goTo(5)} headingRef={headingRef} />;
  } else if (householdId) {
    body = <DoneStep householdId={householdId} bank={bank} profile={profile} name={ident.name ?? ""} onDashboard={toDashboard} onChooseAccounts={() => goTo(3)} headingRef={headingRef} />;
  }

  const showProgress = booted && (!householdId || !!household);
  return (
    <div className="min-h-dvh bg-bg text-ink">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center gap-2.5 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 rounded-md" aria-label={`${PRODUCT_NAME} home`}>
            <BrandMark size={26} />
            <span className="text-[1.05rem] font-semibold tracking-tight">{PRODUCT_NAME}</span>
          </Link>
          <span className="text-[0.9rem] text-ink-3" aria-hidden="true">/</span>
          <span className="text-[0.9rem] text-ink-2">Setup</span>
          <span className="flex-1" />
          {mode === "mock" ? <Chip tone="watch" title="No backend reachable: everything here runs in your browser">Offline demo</Chip> : <Chip tone="neutral" title="Sandbox data, no real money">Sandbox</Chip>}
          <Link href="/" className="rounded-md px-2 py-1 text-[0.82rem] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            Exit
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl px-4 pb-12 pt-5 sm:px-6">
        {showProgress ? <Stepper current={Math.min(step, 5)} /> : <div className="h-9" aria-hidden="true" />}
        {householdId && household && ident.name ? (
          <div className="mt-4">
            <PresenceBar householdId={householdId} householdName={household.name} />
          </div>
        ) : null}
        <main id="main" className="mt-4 rounded-lg border border-line bg-surface p-4 sm:p-6">
          {body}
        </main>
        <p className="mt-4 text-center text-[0.76rem] leading-snug text-ink-3">{SYNTHETIC_NOTE}</p>
      </div>
    </div>
  );
}

