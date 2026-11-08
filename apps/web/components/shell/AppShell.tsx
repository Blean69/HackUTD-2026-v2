"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { CoachPanel } from "@/components/coach/CoachPanel";
import { BrandMark, IconActivity, IconClose, IconMenu, IconMore, IconSpark } from "@/components/icons";
import { CallBrianButton } from "@/components/phone/CallBrianButton";
import { AgentActivityPanel } from "@/components/trace/AgentActivityPanel";
import { TalkButton } from "@/components/voice/TalkButton";
import { openCallSheet, useCall } from "@/lib/voiceCall/session";
import { IconButton } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { useLatestRun } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { cx } from "@/lib/format";
import { closeCallBrian, useCallBrianOpen } from "@/lib/phoneUi";
import { closeCoach, closeTrace, openCoach, openTrace, useCoachOpen, useTraceUi } from "@/lib/traceUi";
import { NAV, TABS } from "./nav";
import { NotificationsBell } from "./NotificationsBell";
import { SlideOver } from "./SlideOver";
import { Sidebar } from "./Sidebar";

const SIDEBAR_W = 232;

// The call sheet is a large piece of UI most visits never open: load it the first time someone reaches for a call.
const CallSheet = dynamic(() => import("@/components/voice/CallSheet").then((m) => m.CallSheet), { ssr: false });
const CallPill = dynamic(() => import("@/components/voice/CallSheet").then((m) => m.CallPill), { ssr: false });
// "Call Brian" (phone number + the household's 5-digit code): also loaded on first use.
const CallBrianPanel = dynamic(() => import("@/components/phone/CallBrianPanel").then((m) => m.CallBrianPanel), { ssr: false });

/** Header button that opens the Agent activity panel; pulses while a run is in flight. */
export function AgentActivityButton({ householdId, className, bordered }: { householdId?: string; className?: string; dark?: boolean; bordered?: boolean }) {
  const latest = useLatestRun(householdId);
  const running = latest?.status === "running";
  return (
    <IconButton label="Agent activity" onClick={() => openTrace()} className={cx(bordered && "border border-line-strong bg-surface hover:bg-surface-2", className)}>
      <IconActivity size={18} />
      {running ? <span className="anim-blink absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand ring-2 ring-surface" aria-label="An agent is running" /> : null}
    </IconButton>
  );
}

function Drawer({ open, onClose, householdId }: { open: boolean; onClose: () => void; householdId: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button type="button" aria-label="Close menu" tabIndex={-1} onClick={onClose} className="scrim absolute inset-0" />
      <div role="dialog" aria-modal="true" aria-label="Menu" className="anim-drawer absolute inset-y-0 left-0 w-[17.5rem] max-w-[85vw] shadow-[var(--shadow-pop)]">
        <Sidebar householdId={householdId} onNavigate={onClose} className="bg-bg" />
        <button type="button" onClick={onClose} aria-label="Close menu" className="absolute right-2 top-4 inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-2 hover:bg-surface-3 hover:text-ink">
          <IconClose size={18} />
        </button>
      </div>
    </div>
  );
}

/**
 * Chrome shared by every signed-in page: a canvas-flush sidebar (md and up), a top bar + bottom tab bar on phones, and
 * the two slide-over panels ("Ask Brianotron" and "Agent activity") that any page can open.
 */
export function AppShell({ householdId, header, children }: { householdId: string; header?: ReactNode; children: ReactNode }) {
  const path = usePathname() ?? "/";
  // The drawer is tied to the page it was opened on, so navigating closes it without an effect.
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const menu = menuPath === path;
  const setMenu = (v: boolean) => setMenuPath(v ? path : null);
  const trace = useTraceUi();
  const coachOpen = useCoachOpen();
  const callBrianOpen = useCallBrianOpen();
  const ident = useLocalIdentity();
  const latest = useLatestRun(householdId);
  const me = ident.name ?? "Someone";

  // `?talk=1` (the QR code on the demo card) opens the call sheet. Opening needs no tap; starting the call still does.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("talk") !== "1") return;
    q.delete("talk");
    const rest = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    openCallSheet();
  }, []);

  // Close the slide-over panels when navigating.
  useEffect(() => {
    closeCoach();
    closeTrace();
    closeCallBrian();
  }, [path]);

  const target = trace.runId ?? latest?.run_id ?? null;
  const call = useCall();
  const [voiceUsed, setVoiceUsed] = useState(false);
  if (!voiceUsed && (call.sheetOpen || call.phase !== "idle")) setVoiceUsed(true);

  return (
    <div className="min-h-dvh bg-bg text-ink">
      <div className="fixed inset-y-0 left-0 z-30 hidden md:block" style={{ width: SIDEBAR_W }}>
        <Sidebar householdId={householdId} />
      </div>

      {/* phones: top bar */}
      <div className="sticky top-0 z-30 flex h-[52px] items-center gap-0.5 border-b border-line bg-bg px-2 text-ink md:hidden">
        <IconButton label="Open menu" onClick={() => setMenu(true)} aria-expanded={menu} className="h-10 w-10 text-ink">
          <IconMenu size={21} />
        </IconButton>
        <Link href={householdId ? `/room/${householdId}` : "/"} className="flex items-center gap-2 rounded-md px-1" aria-label="Dashboard">
          <BrandMark size={24} />
          <span className="display text-[1.02rem]">{PRODUCT_NAME}</span>
        </Link>
        <span className="flex-1" />
        <IconButton label={`Ask ${PRODUCT_NAME}`} onClick={openCoach}>
          <IconSpark size={19} />
        </IconButton>
        <CallBrianButton variant="top" />
        <AgentActivityButton householdId={householdId} />
        <NotificationsBell householdId={householdId} me={me} compact />
      </div>

      <div style={{ ["--sb" as string]: `${SIDEBAR_W}px` }} className="md:pl-[var(--sb)]">
        <div className="mx-auto max-w-[1760px]">
          {header}
          <main id="main" key={path} className="motion-page px-4 pb-28 pt-2 sm:px-6 md:pb-12">
            {children}
          </main>
        </div>
      </div>

      {/* phones: bottom tabs */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface md:hidden" aria-label="Quick navigation">
        <ul className="mx-auto grid max-w-lg grid-cols-6">
          {TABS.map((t, i) => {
            const n = NAV.find((x) => x.key === t.key)!;
            const active = n.match(path, householdId);
            return (
              <Fragment key={t.key}>
                {/* The call button sits in the middle of the bar, raised, so it is the first thing a thumb finds. */}
                {i === 2 ? <li><TalkButton variant="tab" /></li> : null}
                <li>
                  <Link href={n.href(householdId)} aria-current={active ? "page" : undefined} className={cx("relative flex h-14 flex-col items-center justify-center gap-1 text-2xs font-medium transition-colors", active ? "text-ink" : "text-ink-3")}>
                    {active ? <span className="absolute inset-x-4 top-0 h-0.5 rounded-b-full bg-brand" aria-hidden="true" /> : null}
                    <span className={active ? "text-brand-strong" : undefined}><n.Icon size={20} /></span>
                    {t.label}
                  </Link>
                </li>
              </Fragment>
            );
          })}
          <li>
            <button type="button" onClick={() => setMenu(true)} className="flex h-14 w-full flex-col items-center justify-center gap-1 text-2xs font-medium text-ink-3">
              <IconMore size={20} />
              More
            </button>
          </li>
        </ul>
      </nav>

      <Drawer open={menu} onClose={() => setMenu(false)} householdId={householdId} />

      <SlideOver open={coachOpen} onClose={closeCoach} label={`Ask ${PRODUCT_NAME}`} title={`Ask ${PRODUCT_NAME}`} subtitle="Answers come from tools run on your real accounts. Everyone in the room sees the conversation." icon={<IconSpark size={18} />}>
        <CoachPanel householdId={householdId} me={me} />
      </SlideOver>
      <AgentActivityPanel open={trace.open} runId={target} onClose={closeTrace} />
      {callBrianOpen ? <CallBrianPanel householdId={householdId} /> : null}
      {/* Voice call: the call lives in lib/voiceCall, so it survives leaving this page. */}
      {voiceUsed ? (
        <>
          <CallSheet householdId={householdId} />
          <CallPill />
        </>
      ) : null}
    </div>
  );
}
