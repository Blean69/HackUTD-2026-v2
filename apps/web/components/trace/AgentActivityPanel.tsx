"use client";
import Link from "next/link";
import { useMemo, useRef } from "react";
import { IconActivity, IconArrowRight } from "@/components/icons";
import { SlideOver } from "@/components/shell/SlideOver";
import { Chip, Empty } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { useRoomTables, useRun, useTraceEvents } from "@/lib/data/hooks";
import { duration, relTime } from "@/lib/format";
import { WORKFLOW_LABEL } from "@/lib/types";
import { runProviders, ProviderBadge } from "./badges";
import { runTotals, TraceTimeline } from "./TraceTimeline";

/**
 * Right-hand "Agent activity" panel: one agent run, live. Controlled by AppShell, which passes the run the user
 * asked for (or the household's latest run) and closes the panel on navigation.
 */
export function AgentActivityPanel({ open, runId, onClose }: { open: boolean; runId: string | null | undefined; onClose: () => void }) {
  // Nothing is derived while the panel is closed.
  const id = open ? runId : null;
  const run = useRun(id);
  // The steps are the heaviest table in a room, so only this run's load, when the drawer opens, and let go shortly after it closes.
  const stepsReady = useRoomTables(run?.household_id ?? "", id ? [`trace_event@${id}`] : []);
  const events = useTraceEvents(id);
  const bodyRef = useRef<HTMLDivElement>(null);

  const totals = useMemo(() => runTotals(events), [events]);
  const providers = useMemo(() => runProviders(events), [events]);
  const toolCalls = useMemo(() => events.filter((e) => e.type === "tool_call").length, [events]);

  const running = run?.status === "running";
  const tokens = totals.tin + totals.tout;
  const subtitle = run
    ? running
      ? "Nemotron agents are working on this right now."
      : run.status === "error"
        ? "This run stopped with an error."
        : `Finished ${run.finished_at ? relTime(run.finished_at) : "just now"}.`
    : "Waiting for the first agent run in this household.";

  const trailHref = run ? `/agents?run=${encodeURIComponent(run.run_id)}` : "/agents";

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      label="Agent activity"
      title="Agent activity"
      subtitle={subtitle}
      icon={<IconActivity size={18} />}
      width={460}
      footer={
        <Link href={trailHref} onClick={onClose} className="inline-flex items-center gap-1.5 font-medium text-brand-strong hover:underline">
          {run ? "Open this run in Agent Trail" : "Open Agent Trail"}
          <IconArrowRight size={14} />
        </Link>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {run ? (
          <div className="shrink-0 border-b border-line px-4 py-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-body font-semibold">{WORKFLOW_LABEL[run.workflow]}</span>
              {running ? (
                <Chip tone="brand"><span className="anim-blink h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />Running</Chip>
              ) : run.status === "error" ? (
                <Chip tone="risk">Error</Chip>
              ) : (
                <Chip tone="good">Done</Chip>
              )}
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-caption">
              <div>
                <dt className="text-ink-3">Steps</dt>
                <dd className="num mt-0.5 text-lead font-semibold">{events.length}<span className="ml-1 text-caption font-normal text-ink-3">{toolCalls} tool calls</span></dd>
              </div>
              <div>
                <dt className="text-ink-3">Model time</dt>
                <dd className="num mt-0.5 text-lead font-semibold">{totals.latency ? duration(totals.latency) : "—"}</dd>
              </div>
              <div>
                <dt className="text-ink-3">Tokens</dt>
                <dd className="num mt-0.5 text-lead font-semibold">{tokens ? tokens.toLocaleString() : "—"}</dd>
              </div>
            </dl>
            {providers.length ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {providers.map((e) => <ProviderBadge key={`${e.model}${e.provider}`} model={e.model} provider={e.provider} />)}
              </div>
            ) : null}
          </div>
        ) : null}

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {events.length ? (
            <TraceTimeline events={events} running={running} autoScroll scrollRef={bodyRef} />
          ) : run ? (
            <p className="py-6 text-center text-label text-ink-2" role="status">{stepsReady ? "Waiting for the first step…" : "Loading steps…"}</p>
          ) : (
            <Empty title="No agent run yet">
              Start Table Mode, run a what-if or ask {PRODUCT_NAME} a question. Every agent step lands here, live.
            </Empty>
          )}
        </div>
      </div>
    </SlideOver>
  );
}
