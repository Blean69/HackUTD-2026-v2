"use client";
import { useEffect, useRef, type RefObject } from "react";
import { IconAlert, IconBolt, IconChat, IconCheck, IconChevron, IconSpark, IconWrench } from "@/components/icons";
import { clock, cx, duration } from "@/lib/format";
import type { TraceEvent, TraceType } from "@/lib/types";
import { ProviderBadge } from "./badges";

/** Small neutral step markers. Only the end of a run (done / error) and the plan pick up colour. */
const NEUTRAL = "border border-line-strong bg-surface text-ink-2";
const TYPE_META: Record<TraceType, { label: string; marker: string; Icon: typeof IconSpark }> = {
  run_started: { label: "Started", marker: NEUTRAL, Icon: IconBolt },
  plan: { label: "Plan", marker: "border border-transparent bg-brand-soft text-brand-strong", Icon: IconSpark },
  thought: { label: "Reasoning", marker: NEUTRAL, Icon: IconSpark },
  tool_call: { label: "Tool call", marker: "border border-line-strong bg-surface-2 text-ink", Icon: IconWrench },
  tool_result: { label: "Result", marker: NEUTRAL, Icon: IconCheck },
  handoff: { label: "Handoff", marker: NEUTRAL, Icon: IconChevron },
  message: { label: "Message", marker: NEUTRAL, Icon: IconChat },
  final: { label: "Final", marker: "border border-transparent bg-good-soft text-good", Icon: IconCheck },
  error: { label: "Error", marker: "border border-transparent bg-risk-soft text-risk", Icon: IconAlert },
};

function pretty(data: unknown): string {
  try {
    const s = JSON.stringify(data, null, 2);
    return s.length > 1400 ? `${s.slice(0, 1400)}\n…` : s;
  } catch {
    return String(data);
  }
}

function planSteps(e: TraceEvent): string[] | null {
  const d = e.data as { steps?: unknown } | undefined;
  return d && Array.isArray(d.steps) && d.steps.every((s) => typeof s === "string") ? (d.steps as string[]) : null;
}

const agentName = (a: string) => a.replace(/_/g, " ");

/**
 * Activity log for one agent run: a quiet vertical rail with a small marker per step, the agent, the step type,
 * the time, the model + provider chips, and the raw `data` behind each step in a collapsible block.
 */
export function TraceTimeline({
  events, running, compact, autoScroll, scrollRef,
}: {
  events: readonly TraceEvent[];
  running?: boolean;
  compact?: boolean;
  /** Keep the newest event in view while the run is live (when the user has not scrolled away). */
  autoScroll?: boolean;
  scrollRef?: RefObject<HTMLElement | null>;
}) {
  const endRef = useRef<HTMLLIElement>(null);
  const last = events.length;
  useEffect(() => {
    if (!autoScroll) return;
    const sc = scrollRef?.current;
    if (sc) {
      const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
      if (nearBottom) sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
    } else endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [last, autoScroll, scrollRef]);

  return (
    <ol className="relative" aria-label="Agent trace" aria-live={running ? "polite" : "off"}>
      {events.map((e, i) => {
        const meta = TYPE_META[e.type] ?? TYPE_META.message;
        const steps = e.type === "plan" ? planSteps(e) : null;
        const hasData = e.data !== undefined && e.data !== null && !steps;
        const hasRail = i < events.length - 1 || !!running;
        return (
          <li key={e.id} className={cx("relative pl-8", compact ? "pb-3" : "pb-4")}>
            {hasRail ? <span className="absolute bottom-0 left-[10px] top-6 w-px bg-line-strong" aria-hidden="true" /> : null}
            <span className={cx("absolute left-0 top-0 flex h-5 w-5 items-center justify-center rounded-full", meta.marker)} aria-hidden="true">
              <meta.Icon size={11} strokeWidth={2} />
            </span>
            <div className="flex flex-wrap items-center gap-x-1.5 text-[0.76rem] leading-5 text-ink-3">
              <span className="font-semibold capitalize text-ink">{agentName(e.agent)}</span>
              <span aria-hidden="true">·</span>
              <span>{meta.label}</span>
              <time className="num ml-auto" dateTime={e.ts}>{clock(e.ts)}</time>
            </div>
            <p
              className={cx(
                "mt-0.5 break-words leading-snug",
                compact ? "text-[0.82rem]" : "text-[0.86rem]",
                e.type === "thought" ? "text-ink-2" : "text-ink",
                e.type === "final" && "font-medium",
                e.type === "error" && "text-risk",
                e.type === "tool_call" && "font-mono text-[0.78rem]",
              )}
            >
              {e.title}
            </p>
            {steps ? (
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[0.8rem] text-ink-2 marker:text-ink-3">
                {steps.map((s) => <li key={s}>{s}</li>)}
              </ol>
            ) : null}
            {e.provider || e.model || e.latency_ms || e.tokens ? (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <ProviderBadge model={e.model} provider={e.provider} />
                {e.latency_ms ? <span className="num text-[0.72rem] text-ink-3">{duration(e.latency_ms)}</span> : null}
                {e.tokens ? <span className="num text-[0.72rem] text-ink-3">{e.tokens.in} in · {e.tokens.out} out tokens</span> : null}
              </div>
            ) : null}
            {hasData && !compact ? (
              <details className="group mt-1">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-[0.74rem] font-medium text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden">
                  <IconChevron size={12} className="transition-transform group-open:rotate-90" /> Raw data
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-line bg-surface-2 p-2 font-mono text-[0.72rem] leading-relaxed text-ink-2">{pretty(e.data)}</pre>
              </details>
            ) : null}
          </li>
        );
      })}
      {running ? (
        <li ref={endRef} className="relative pb-1 pl-8 text-[0.82rem] text-ink-2">
          <span className="absolute left-0 top-0 flex h-5 w-5 items-center justify-center" aria-hidden="true">
            <span className="anim-blink h-2 w-2 rounded-full bg-brand" />
          </span>
          <span className="leading-5">Agents working…</span>
        </li>
      ) : (
        <li ref={endRef} aria-hidden="true" />
      )}
    </ol>
  );
}

export function runTotals(events: readonly TraceEvent[]) {
  let latency = 0;
  let tin = 0;
  let tout = 0;
  const models = new Set<string>();
  for (const e of events) {
    latency += e.latency_ms ?? 0;
    tin += e.tokens?.in ?? 0;
    tout += e.tokens?.out ?? 0;
    if (e.model && e.provider !== "cache") models.add(e.model);
  }
  return { latency, tin, tout, models: [...models] };
}
