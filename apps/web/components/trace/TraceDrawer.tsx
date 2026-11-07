"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { IconBot, IconClose } from "@/components/icons";
import { Chip } from "@/components/ui";
import { useLatestRun, useRun, useTraceEvents } from "@/lib/data/hooks";
import { cx, duration, relTime } from "@/lib/format";
import { closeTrace, openTrace, useTraceUi } from "@/lib/traceUi";
import { WORKFLOW_LABEL } from "@/lib/types";
import { runTotals, TraceTimeline } from "./TraceTimeline";

/**
 * Bottom sheet on phones, side panel on laptops. Shows one agent run live.
 * Controlled: pass `open`, `runId` (null = nothing yet) and `onClose`. <TraceDock> below wires it to the global
 * trace UI state and follows the household's latest run.
 */
export function TraceDrawer({ open, runId, onClose, title }: { open: boolean; runId: string | null | undefined; onClose: () => void; title?: string }) {
  const run = useRun(runId);
  const events = useTraceEvents(runId);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const totals = runTotals(events);
  const running = run?.status === "running";
  return (
    <div className="fixed inset-0 z-40 lg:pointer-events-none">
      <button type="button" aria-label="Close agent trace" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/45 lg:hidden" />
      <section
        role="dialog"
        aria-label="Agent trace"
        className="anim-sheet pointer-events-auto absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col rounded-t-3xl border border-line bg-surface shadow-card lg:anim-side lg:inset-y-0 lg:left-auto lg:right-0 lg:max-h-none lg:w-[440px] lg:rounded-none lg:rounded-l-3xl lg:border-r-0"
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong lg:hidden" aria-hidden="true" />
        <header className="flex items-start gap-3 px-4 pb-3 pt-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-strong"><IconBot size={20} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-semibold leading-tight">{title ?? (run ? `${WORKFLOW_LABEL[run.workflow]} run` : "Agent trace")}</h2>
            <p className="mt-0.5 text-[0.8rem] text-ink-2">
              {run ? (running ? "Nemotron agents are working…" : `Finished ${run.finished_at ? relTime(run.finished_at) : ""}`) : "Waiting for the first agent run in this room."}
            </p>
            {events.length ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Chip tone={running ? "brand" : "good"}>{running ? "running" : "done"}</Chip>
                <Chip>{events.length} steps</Chip>
                {totals.latency ? <Chip className="num">{duration(totals.latency)} model time</Chip> : null}
                {totals.tin + totals.tout ? <Chip className="num">{(totals.tin + totals.tout).toLocaleString()} tokens</Chip> : null}
              </div>
            ) : null}
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 hover:text-ink">
            <IconClose size={20} />
          </button>
        </header>
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto border-t border-line px-4 py-4">
          {events.length ? (
            <TraceTimeline events={events} running={running} autoScroll scrollRef={bodyRef} />
          ) : (
            <p className="py-8 text-center text-sm text-ink-2">Start a Huddle, a what-if, or ask the Coach. Every agent step lands here, live.</p>
          )}
        </div>
        <footer className="pb-safe border-t border-line px-4 py-3 text-[0.8rem]">
          <Link href="/agents" className="font-medium text-brand-strong underline-offset-2 hover:underline">See every run on the agent wall →</Link>
        </footer>
      </section>
    </div>
  );
}

/** Floating launcher + drawer that follows a household's latest run (or the latest run anywhere). */
export function TraceDock({ householdId }: { householdId?: string }) {
  const ui = useTraceUi();
  const latest = useLatestRun(householdId);
  const targetId = ui.runId ?? latest?.run_id ?? null;
  const running = latest?.status === "running";
  return (
    <>
      {!ui.open ? (
        <button
          type="button"
          onClick={() => openTrace()}
          className={cx("fixed bottom-[5.25rem] right-4 z-30 inline-flex h-12 items-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-sm font-semibold text-ink shadow-card md:bottom-6", running && "border-brand")}
          aria-label="Open agent trace"
        >
          <IconBot size={18} className={running ? "text-brand" : "text-ink-2"} />
          <span>Agent trace</span>
          {running ? <span className="anim-blink h-2 w-2 rounded-full bg-brand" aria-label="running" /> : null}
        </button>
      ) : null}
      <TraceDrawer open={ui.open} runId={targetId} onClose={closeTrace} />
    </>
  );
}
