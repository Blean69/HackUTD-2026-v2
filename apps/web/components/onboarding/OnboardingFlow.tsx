"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrandMark } from "@/components/icons";
import { leaveThen, StepTransition } from "@/components/motion";
import { Avatar, Skeleton } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { useConnection } from "@/lib/data/connection";
import { joinRoom } from "@/lib/data/actions";
import { useDataReady, useDataScope, useHousehold, usePresence, useRoomTables } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import {
  deriveStep, findProfile, QUESTION_COUNT, STEPS, useAccountOptions, useInsightsRun, useOnboardingBank, useOnboardingMode, useOnboardingSubscription,
  useProfile, type StepKey,
} from "@/lib/data/onboarding";
import { rememberHousehold } from "@/lib/lastHousehold";
import { Stepper } from "./Stepper";
import { HouseholdStep } from "./steps/HouseholdStep";
import { WelcomeStep } from "./steps/WelcomeStep";
import { backTo, pushPos, replacePos, syncPos, useWizardPos } from "./wizardUrl";

// The first two steps ship with the page; the rest load in the background once the page is idle, so they are ready
// long before anyone reaches them and the first load stays small.
const later = {
  connect: () => import("./steps/ConnectStep"),
  accounts: () => import("./steps/AccountsStep"),
  questions: () => import("./steps/QuestionsStep"),
  done: () => import("./steps/DoneStep"),
  watch: () => import("./WatchPanel"),
  join: () => import("./JoinCard"),
};
const ConnectStep = dynamic(() => later.connect().then((m) => m.ConnectStep));
const AccountsStep = dynamic(() => later.accounts().then((m) => m.AccountsStep));
const QuestionsStep = dynamic(() => later.questions().then((m) => m.QuestionsStep));
const DoneStep = dynamic(() => later.done().then((m) => m.DoneStep));
const WatchPanel = dynamic(() => later.watch().then((m) => m.WatchPanel));
const JoinCard = dynamic(() => later.join().then((m) => m.JoinCard));
function preloadSteps(): () => void {
  const run = () => Object.values(later).forEach((load) => void load());
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(run, { timeout: 1200 });
    return () => w.cancelIdleCallback?.(id);
  }
  const t = window.setTimeout(run, 400);
  return () => window.clearTimeout(t);
}

const GRACE_MS = 3500;
const idx = (k: StepKey) => STEPS.findIndex((s) => s.key === k);

function Loading() {
  return (
    <div role="status" aria-label="Loading setup">
      <Skeleton className="h-8 w-3/4" />
      <Skeleton className="mt-3 h-4 w-full" />
      <Skeleton className="mt-2 h-4 w-5/6" />
      <Skeleton className="mt-6 h-24 w-full !rounded-lg" />
      <Skeleton className="mt-6 h-12 w-full !rounded-lg sm:ml-auto sm:w-40" />
    </div>
  );
}

function NotFound({ offline }: { offline: boolean }) {
  return (
    <div>
      <h1 className="display text-h1">We couldn&apos;t find that setup</h1>
      <p className="mt-2 text-lead leading-relaxed text-ink-2">
        {offline ? "The offline demo keeps setups only while the tab is open. Starting again takes about two minutes." : "The link may be mistyped, or the household was removed."}
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Link href="/onboarding" className="press inline-flex h-12 items-center justify-center rounded-lg bg-brand px-5 text-lead font-semibold text-brand-ink hover:bg-brand-hover">
          Start a new setup
        </Link>
        <Link href="/login" className="press inline-flex h-12 items-center justify-center rounded-lg px-5 text-lead font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink">
          Log in instead
        </Link>
      </div>
    </div>
  );
}

/**
 * The registration wizard (docs/contracts.md section 7): Welcome, Your household, Connect your bank, Choose accounts,
 * A few questions (three short screens), Done. Lives in the /onboarding layout so it survives the move from /onboarding
 * to /onboarding/[householdId] when the household is created.
 *
 * Position: the URL (`?step=`, `&q=`) says where you are, clamped to what the household's stored state allows, so a
 * refresh resumes and Back works. Without a step in the URL, the stored state decides (resume from a shared link).
 * Family members who open the link follow along read-only until they tap "Help set this up".
 */
export function OnboardingFlow() {
  const params = useParams<{ householdId?: string | string[] }>();
  const router = useRouter();
  const raw = Array.isArray(params.householdId) ? params.householdId[0] : params.householdId;
  const householdId = raw ? decodeURIComponent(raw) : undefined;
  const pos = useWizardPos();

  const mode = useOnboardingMode();
  useDataScope(householdId ? "room" : "lobby", householdId ?? "");
  useOnboardingSubscription(householdId, mode);
  // Beyond the room's base tables, the wizard reads the bank link and the goals written from the answers.
  useRoomTables(householdId ?? "", householdId ? ["bank_connection", "goal"] : []);
  const dataReady = useDataReady() && mode !== "detecting";
  const conn = useConnection();
  const ident = useLocalIdentity();
  const household = useHousehold(householdId ?? "");
  const profile = useProfile(householdId);
  const bank = useOnboardingBank(householdId);
  const options = useAccountOptions(householdId);
  const { run } = useInsightsRun(householdId);
  const present = usePresence(householdId ?? "");

  useEffect(preloadSteps, []);

  // Only a household URL waits for data; the first two steps render straight away (and prerender).
  const [booted, setBooted] = useState(false);
  if (dataReady && !booted) setBooted(true);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!booted || !householdId) return;
    const t = setTimeout(() => setWaited(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [booted, householdId]);
  // The household id just arrived in the path: re-read the query the router wrote alongside it.
  useEffect(() => {
    syncPos();
  }, [householdId]);

  const [takeOver, setTakeOver] = useState(false);
  const isOwner = !!household && (!household.owner || household.owner === conn.identity);
  const drive = !householdId || isOwner || takeOver;

  // ---- which step: what the URL asks for, clamped to what the stored state allows
  const hasRun = !!run;
  const derived = householdId ? deriveStep({ status: profile?.status, bank, hasRun }) : 0;
  const answered = !!profile?.answers || profile?.status === "done" || hasRun;
  const canAt = (k: StepKey): boolean => {
    if (!householdId) return k === "welcome" || k === "household";
    switch (k) {
      case "accounts":
        return !!bank && options.length > 0;
      case "questions":
        return bank?.status !== "selecting" && bank?.status !== "linking";
      case "done":
        return answered;
      default:
        return true;
    }
  };
  const fallback: StepKey = householdId ? STEPS[derived].key : "welcome";
  const wanted: StepKey = drive ? (pos.step ?? fallback) : STEPS[derived].key;
  const settled = !householdId || (booted && !!household);
  const step: StepKey = !settled ? wanted : canAt(wanted) ? wanted : fallback;
  const q = step === "questions" ? pos.q : 1;
  const current = idx(step);

  // Keep the URL honest once we know where we really are (refreshes, stale links).
  useEffect(() => {
    if (!drive || !settled || (!householdId && pos.step === null)) return;
    if (pos.step !== step || (step === "questions" && pos.q !== q)) replacePos({ step, q });
  }, [drive, settled, householdId, pos.step, pos.q, step, q]);

  // The bank found its accounts: move the driver on to choosing them, once per connection.
  const advancedFor = useRef("");
  useEffect(() => {
    if (!drive || step !== "connect" || bank?.status !== "selecting" || !options.length || advancedFor.current === bank.item_id) return;
    advancedFor.current = bank.item_id;
    pushPos({ step: "accounts" });
  }, [drive, step, bank?.status, bank?.item_id, options.length]);

  // ---- direction of travel for the step transition
  const key = `${step}:${q}`;
  const order = current * 10 + q;
  const [travel, setTravel] = useState({ key, order, dir: "fwd" as "fwd" | "back" });
  if (travel.key !== key) setTravel({ key, order, dir: order >= travel.order ? "fwd" : "back" });

  // Presence: everyone with the link shows up for everyone else.
  useEffect(() => {
    if (dataReady && householdId && ident.name) void joinRoom(householdId, ident.name, "family").catch(() => undefined);
  }, [dataReady, householdId, ident.name]);

  // Focus the new step's heading (keyboard and screen reader users), skipping the first paint.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!drive) return;
    headingRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [key, drive]);

  const roomUrl = householdId ? `/room/${encodeURIComponent(householdId)}` : "/";
  useEffect(() => {
    if (step === "done" && householdId) router.prefetch(roomUrl);
  }, [step, householdId, roomUrl, router]);

  const go = (k: StepKey, qq?: number) => pushPos({ step: k, q: qq });
  const back = (k: StepKey, qq?: number) => backTo({ step: k, q: qq });
  const toDashboard = () => {
    if (!householdId) return;
    rememberHousehold(householdId);
    leaveThen(mainRef.current, () => router.push(roomUrl));
  };

  const selectedCount = options.filter((o) => o.selected).length || options.length;
  const expectedTxns = findProfile(options[0]?.account_id.replace(/_\d+$/, ""))?.txn_count;

  let body: ReactNode;
  if (householdId && !booted) {
    body = <Loading />;
  } else if (householdId && !household) {
    body = waited ? <NotFound offline={mode === "mock"} /> : <Loading />;
  } else if (householdId && household && !ident.name && ident.ready) {
    body = <JoinCard householdName={household.name} />;
  } else if (householdId && household && !drive) {
    const ownerPresence = present.find((p) => p.identity === household.owner);
    body = <WatchPanel household={household} step={derived} bank={bank} owner={ownerPresence} expectedAccounts={selectedCount} onTakeOver={() => setTakeOver(true)} onDashboard={toDashboard} headingRef={headingRef} />;
  } else if (step === "welcome") {
    body = <WelcomeStep onBack={() => router.push("/")} onContinue={() => go("household")} headingRef={headingRef} />;
  } else if (step === "household") {
    body = (
      <HouseholdStep
        household={household}
        defaultName={ident.name ?? ""}
        onBack={() => back("welcome")}
        onCreated={(id) => router.replace(`/onboarding/${encodeURIComponent(id)}?step=connect`)}
        onContinue={() => go("connect")}
        headingRef={headingRef}
      />
    );
  } else if (step === "connect" && householdId) {
    body = <ConnectStep householdId={householdId} bank={bank} mode={mode} onBack={() => back("household")} onContinue={() => go("accounts")} onSkip={() => go("questions")} headingRef={headingRef} />;
  } else if (step === "accounts" && householdId) {
    body = <AccountsStep householdId={householdId} bank={bank} options={options} onBack={() => back("connect")} onDone={() => go("questions")} headingRef={headingRef} />;
  } else if (step === "questions" && householdId) {
    body = (
      <QuestionsStep
        householdId={householdId}
        q={q}
        bank={bank}
        options={options}
        profile={profile}
        defaultName={ident.name ?? ""}
        expectedTxns={expectedTxns}
        onBack={() => (q > 1 ? back("questions", q - 1) : back(bank ? "accounts" : "connect"))}
        onNext={(n) => go("questions", n)}
        onDone={() => go("done")}
        headingRef={headingRef}
      />
    );
  } else if (householdId) {
    body = (
      <DoneStep
        householdId={householdId}
        householdName={household?.name}
        bank={bank}
        profile={profile}
        name={ident.name ?? ""}
        expectedAccounts={selectedCount}
        expectedTxns={expectedTxns}
        onDashboard={toDashboard}
        onChooseAccounts={() => go("accounts")}
        headingRef={headingRef}
      />
    );
  }

  const others = householdId ? present.filter((p) => !p.isMe) : [];
  const showProgress = drive && (!householdId || (booted && !!household));
  return (
    <div className="min-h-svh bg-surface text-ink sm:bg-bg">
      <header className="mx-auto flex h-16 w-full max-w-xl items-center gap-3 px-4 sm:px-0">
        <Link href="/" className="flex items-center gap-2.5 rounded-md" aria-label={`${PRODUCT_NAME} home`}>
          <BrandMark size={26} />
          <span className="display text-[1.08rem]">{PRODUCT_NAME}</span>
        </Link>
        <span className="flex-1" />
        {others.length ? (
          <span className="flex items-center gap-2 text-caption text-ink-3">
            <span className="hidden sm:inline">Here with you</span>
            <span className="flex -space-x-1.5">
              {others.slice(0, 3).map((p) => (
                <Avatar key={p.identity} name={p.display_name} size={26} ring dot="online" />
              ))}
              {others.length > 3 ? <span className="num relative flex h-[26px] min-w-[26px] items-center justify-center rounded-full bg-surface-3 px-1 text-caption font-semibold text-ink-2 ring-2 ring-surface">+{others.length - 3}</span> : null}
            </span>
          </span>
        ) : null}
      </header>

      <div className="mx-auto w-full max-w-xl px-4 pb-10 sm:px-0">
        {showProgress ? <Stepper current={current} sub={step === "questions" ? q / QUESTION_COUNT : step === "done" && run?.status === "done" ? 1 : 0} /> : <div className="h-[1.65rem]" aria-hidden="true" />}
        <div ref={mainRef} className="mt-5 [overflow-x:clip] sm:mt-6 sm:overflow-visible">
          <main id="main" className="sm:card sm:!rounded-xl sm:p-8">
            <StepTransition k={drive ? key : "watch"} dir={travel.dir}>
              {body}
            </StepTransition>
          </main>
        </div>
        <p className="mt-5 text-center text-caption leading-snug text-ink-3">
          Synthetic sandbox data only.{mode === "mock" ? " Offline demo: your setup lives in this tab." : ""}
        </p>
      </div>
    </div>
  );
}
