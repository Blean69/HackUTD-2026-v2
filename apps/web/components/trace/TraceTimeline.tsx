"use client";
import { useEffect, useRef } from "react";
import { IconBolt, IconCheck, IconChat, IconChevron, IconAlert, IconSpark, IconWrench } from "@/components/icons";
import { cx, clock, duration } from "@/lib/format";
import type { TraceEvent, TraceType } from "@/lib/types";
import { ProviderBadge } from "./badges";

const TYPE_META: Record<TraceType, { label: string; dot: string; Icon: typeof IconSpark }> = {
  run_started: { label: "start", dot: "bg-ink-3 text-surface", Icon: IconBolt },
  plan: { label: "plan", dot: "bg-brand text-brand-ink", Icon: IconSpark },
  thought: { label: "thinking", dot: "bg-surface-2 text-ink-2 border border-line-strong", Icon: IconSpark },
  tool_call: { label: "tool call", dot: "bg-accent text-black", Icon: IconWrench },
  tool_result: { label: "result", dot: "bg-surface-2 text-ink border border-line-strong", Icon: IconCheck },
  handoff: { label: "handoff", dot: "bg-info text-white", Icon: IconChevron },
  message: { label: "message", dot: "bg-brand-soft text-brand-strong", Icon: IconChat },
  final: { label: "final", dot: "bg-good text-white", Icon: IconCheck },
  error: { label: "error", dot: "bg-risk text-white", Icon: IconAlert },
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

export function TraceTimeline({
  events, running, compact, autoScroll, scrollRef,
}: {
  events: readonly TraceEvent[];
  running?: boolean;
  compact?: boolean;
  /** Keep the newest event in view while the run is live (when the user has not scrolled away). */
  autoScroll?: boolean;
  scrollRef?: React.RefObject<HTMLElement | null>;
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
        const isLast = i === events.length - 1 && !running;
        return (
          <li key={e.id} className={cx("relative pl-9", compact ? "pb-2.5" : "pb-4")}>
            {!isLast || running ? <span className="absolute bottom-0 left-[13px] top-7 w-px bg-line-strong" aria-hidden="true" /> : null}
            <span className={cx("absolute left-0 top-0.5 flex h-[26px] w-[26px] items-center justify-center rounded-full", meta.dot)} aria-hidden="true">
              <meta.Icon size={14} />
            </span>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.7rem] text-ink-3">
              <span className="font-mono font-semibold uppercase tracking-wide text-ink-2">{e.agent}</span>
              <span aria-hidden="true">·</span>
              <span>{meta.label}</span>
              <time className="ml-auto font-mono num" dateTime={e.ts}>{clock(e.ts)}</time>
            </div>
            <p className={cx("mt-0.5 leading-snug", e.type === "thought" ? "italic text-ink-2" : "text-ink", e.type === "final" && "font-semibold", compact ? "text-[0.84rem]" : "text-[0.9rem]", e.type === "tool_call" && "font-mono text-[0.8rem]")}>
              {e.title}
            </p>
            {steps ? (
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[0.8rem] text-ink-2 marker:font-mono marker:text-ink-3">
                {steps.map((s) => <li key={s} className="font-mono">{s}</li>)}
              </ol>
            ) : null}
            {e.provider || e.model || e.latency_ms || e.tokens ? (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <ProviderBadge model={e.model} provider={e.provider} />
                {e.latency_ms ? <span className="font-mono text-[0.68rem] text-ink-3 num">{duration(e.latency_ms)}</span> : null}
                {e.tokens ? <span className="font-mono text-[0.68rem] text-ink-3 num">{e.tokens.in}→{e.tokens.out} tok</span> : null}
              </div>
            ) : null}
            {hasData && !compact ? (
              <details className="group mt-1">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-[0.72rem] font-medium text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden">
                  <IconChevron size={12} className="transition-transform group-open:rotate-90" /> data
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 font-mono text-[0.7rem] leading-relaxed text-ink-2">{pretty(e.data)}</pre>
              </details>
            ) : null}
          </li>
        );
      })}
      {running ? (
        <li ref={endRef} className="relative pl-9 pb-1 text-[0.82rem] text-ink-2">
          <span className="absolute left-0 top-0.5 flex h-[26px] w-[26px] items-center justify-center" aria-hidden="true">
            <span className="anim-blink h-2.5 w-2.5 rounded-full bg-brand" />
          </span>
          <span className="inline-block pt-1">Agents working…</span>
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
