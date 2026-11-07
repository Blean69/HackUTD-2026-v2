"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { CoachPanel } from "@/components/coach/CoachPanel";
import { BrandMark, IconActivity, IconClose, IconMenu, IconMore, IconSpark } from "@/components/icons";
import { AgentActivityPanel } from "@/components/trace/AgentActivityPanel";
import { IconButton } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { useLatestRun } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { cx } from "@/lib/format";
import { closeCoach, closeTrace, openCoach, openTrace, useCoachOpen, useTraceUi } from "@/lib/traceUi";
import { NAV, TABS } from "./nav";
import { NotificationsBell } from "./NotificationsBell";
import { SlideOver } from "./SlideOver";
import { Sidebar } from "./Sidebar";

const SIDEBAR_W = 232;

/** Header button that opens the Agent activity panel; pulses while a run is in flight. */
export function AgentActivityButton({ householdId, className, dark }: { householdId?: string; className?: string; dark?: boolean }) {
  const latest = useLatestRun(householdId);
  const running = latest?.status === "running";
  return (
    <IconButton label="Agent activity" onClick={() => openTrace()} className={cx(dark && "text-white hover:bg-white/10 hover:text-white", className)}>
      <IconActivity size={19} />
      {running ? <span className="anim-blink absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand" aria-label="An agent is running" /> : null}
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
      <button type="button" aria-label="Close menu" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div role="dialog" aria-modal="true" aria-label="Menu" className="anim-drawer absolute inset-y-0 left-0 w-[17.5rem] max-w-[85vw]">
        <Sidebar householdId={householdId} onNavigate={onClose} />
        <button type="button" onClick={onClose} aria-label="Close menu" className="on-dark absolute right-2 top-3 inline-flex h-9 w-9 items-center justify-center rounded-md text-side-ink hover:bg-white/10">
          <IconClose size={18} />
        </button>
      </div>
    </div>
  );
}

/**
 * Chrome shared by every signed-in page: deep-green sidebar (md and up), a top bar + bottom tab bar on phones, and
 * the two slide-over panels ("Ask Cosign" and "Agent activity") that any page can open.
 */
export function AppShell({ householdId, header, children }: { householdId: string; header?: ReactNode; children: ReactNode }) {
  const path = usePathname() ?? "/";
  // The drawer is tied to the page it was opened on, so navigating closes it without an effect.
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const menu = menuPath === path;
  const setMenu = (v: boolean) => setMenuPath(v ? path : null);
  const trace = useTraceUi();
  const coachOpen = useCoachOpen();
  const ident = useLocalIdentity();
  const latest = useLatestRun(householdId);
  const me = ident.name ?? "Someone";

  // Close the slide-over panels when navigating.
  useEffect(() => {
    closeCoach();
    closeTrace();
  }, [path]);

  const target = trace.runId ?? latest?.run_id ?? null;

  return (
    <div className="min-h-dvh bg-bg text-ink">
      <div className="fixed inset-y-0 left-0 z-30 hidden md:block" style={{ width: SIDEBAR_W }}>
        <Sidebar householdId={householdId} />
      </div>

      {/* phones: top bar */}
      <div className="on-dark sticky top-0 z-30 flex h-[52px] items-center gap-1 bg-side px-2 text-white md:hidden">
        <button type="button" onClick={() => setMenu(true)} aria-label="Open menu" aria-expanded={menu} className="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/10">
          <IconMenu size={22} />
        </button>
        <Link href="/" className="flex items-center gap-2 rounded-md px-1" aria-label={`${PRODUCT_NAME} home`}>
          <BrandMark size={26} />
          <span className="text-[1.05rem] font-semibold tracking-tight">{PRODUCT_NAME}</span>
        </Link>
        <span className="flex-1" />
        <IconButton label={`Ask ${PRODUCT_NAME}`} onClick={openCoach} className="text-white hover:bg-white/10 hover:text-white">
          <IconSpark size={20} />
        </IconButton>
        <AgentActivityButton householdId={householdId} dark />
        <NotificationsBell householdId={householdId} me={me} dark />
      </div>

      <div style={{ ["--sb" as string]: `${SIDEBAR_W}px` }} className="md:pl-[var(--sb)]">
        <div className="mx-auto max-w-[1760px]">
          {header}
          <main id="main" className="px-4 pb-28 pt-2 sm:px-6 md:pb-12">
            {children}
          </main>
        </div>
      </div>

      {/* phones: bottom tabs */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface md:hidden" aria-label="Quick navigation">
        <ul className="mx-auto grid max-w-lg grid-cols-5">
          {TABS.map((t) => {
            const n = NAV.find((x) => x.key === t.key)!;
            const active = n.match(path, householdId);
            return (
              <li key={t.key}>
                <Link href={n.href(householdId)} aria-current={active ? "page" : undefined} className={cx("flex h-14 flex-col items-center justify-center gap-0.5 text-[0.68rem] font-medium", active ? "text-brand-strong" : "text-ink-3")}>
                  <n.Icon size={21} />
                  {t.label}
                </Link>
              </li>
            );
          })}
          <li>
            <button type="button" onClick={() => setMenu(true)} className="flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[0.68rem] font-medium text-ink-3">
              <IconMore size={21} />
              More
            </button>
          </li>
        </ul>
      </nav>

      <Drawer open={menu} onClose={() => setMenu(false)} householdId={householdId} />

      {/* "Ask Cosign" launcher, available on every page */}
      {!coachOpen && !trace.open ? (
        <button
          type="button"
          onClick={openCoach}
          aria-label={`Ask ${PRODUCT_NAME}`}
          className="on-dark fixed bottom-[4.5rem] right-4 z-20 inline-flex h-11 items-center gap-2 rounded-full bg-dark px-4 text-[0.88rem] font-semibold text-white hover:bg-[var(--dark-hover)] md:bottom-6 md:right-6"
        >
          <IconSpark size={18} />
          <span className="hidden sm:inline">Ask {PRODUCT_NAME}</span>
        </button>
      ) : null}

      <SlideOver open={coachOpen} onClose={closeCoach} label={`Ask ${PRODUCT_NAME}`} title={`Ask ${PRODUCT_NAME}`} subtitle="Answers come from tools run on your real accounts. Everyone in the room sees the conversation." icon={<IconSpark size={18} />}>
        <CoachPanel householdId={householdId} me={me} />
      </SlideOver>
      <AgentActivityPanel open={trace.open} runId={target} onClose={closeTrace} />
    </div>
  );
}
