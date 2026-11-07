"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Shell } from "@/components/Shell";
import { ProviderBadge } from "@/components/trace/badges";
import { runTotals, TraceTimeline } from "@/components/trace/TraceTimeline";
import { Chip, Skeleton } from "@/components/ui";
import { IconChevronDown } from "@/components/icons";
import { useDataReady, useHouseholds, useRuns, useTraceByRun } from "@/lib/data/hooks";
import { cx, duration, relTime } from "@/lib/format";
import { WORKFLOWS, WORKFLOW_LABEL, type AgentRun, type TraceEvent, type Workflow } from "@/lib/types";

function RunCard({ run, events, household, defaultOpen }: { run: AgentRun; events: readonly TraceEvent[]; household: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const running = run.status === "running";
  const totals = useMemo(() => runTotals(events), [events]);
  const providers = useMemo(() => {
    const seen = new Map<string, TraceEvent>();
    for (const e of events) if (e.model || e.provider === "cache") seen.set(`${e.model ?? ""}|${e.provider}`, e);
    return [...seen.values()];
  }, [events]);
  const toolCalls = events.filter((e) => e.type === "tool_call").length;
  const bodyId = `run-${run.run_id}`;
  return (
    <article className={cx("anim-fade overflow-hidden rounded-xl border bg-surface", running ? "border-brand" : "border-line")} aria-label={`${WORKFLOW_LABEL[run.workflow]} run`}>
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-3 px-3.5 py-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <Chip tone={running ? "brand" : "neutral"} className="font-mono uppercase">{run.workflow}</Chip>
            {running ? <Chip tone="brand"><span className="anim-blink h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" /> live</Chip> : run.status === "error" ? <Chip tone="risk">error</Chip> : <Chip tone="good">done</Chip>}
            <span className="font-mono text-[0.7rem] text-ink-3">{run.run_id}</span>
          </span>
          <span className="mt-1 block text-[0.88rem] font-medium leading-snug">{household}</span>
          <span className="mt-0.5 block font-mono text-[0.7rem] text-ink-3 num">
            {events.length} steps · {toolCalls} tool calls{totals.latency ? ` · ${duration(totals.latency)} model time` : ""}{totals.tin + totals.tout ? ` · ${(totals.tin + totals.tout).toLocaleString()} tok` : ""} · {relTime(run.started_at)}
          </span>
          {providers.length ? (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {providers.map((e) => <ProviderBadge key={`${e.model}${e.provider}`} model={e.model} provider={e.provider} />)}
            </span>
          ) : null}
        </span>
        <IconChevronDown size={18} className={cx("mt-1 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={bodyId} className="max-h-[30rem] overflow-y-auto border-t border-line px-3.5 py-3.5">
          {events.length ? <TraceTimeline events={events} running={running} compact /> : <p className="text-sm text-ink-3">Waiting for the first step…</p>}
        </div>
      ) : null}
    </article>
  );
}

export function AgentWall() {
  const ready = useDataReady();
  const [wf, setWf] = useState<Workflow | "all">("all");
  const all = useRuns();
  const runs = useRuns({ workflow: wf });
  const byRun = useTraceByRun();
  const households = useHouseholds();
  const nameOf = (id: string) => households.find((h) => h.id === id)?.name ?? (id.startsWith("hh_sbx_") ? "A private sandbox" : id);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const r of all) c[r.workflow] = (c[r.workflow] ?? 0) + 1;
    return c;
  }, [all]);
  const live = all.filter((r) => r.status === "running").length;
  const stats = useMemo(() => {
    let tools = 0;
    let lat = 0;
    let n = 0;
    const prov = new Map<string, number>();
    for (const evs of byRun.values()) {
      for (const e of evs) {
        if (e.type === "tool_call") tools++;
        if (e.latency_ms && e.model) {
          lat += e.latency_ms;
          n++;
        }
        if (e.model || e.provider === "cache") prov.set(e.provider ?? "?", (prov.get(e.provider ?? "?") ?? 0) + 1);
      }
    }
    return { tools, avg: n ? lat / n : 0, prov };
  }, [byRun]);

  return (
    <Shell mood="agents" maxWidth="max-w-[1500px]">
      <header className="mb-5">
        <p className="font-mono text-[0.72rem] uppercase tracking-[0.18em] text-brand">glass box · live</p>
        <h1 className="mt-1 font-display text-3xl font-bold tracking-tight sm:text-4xl">Agent wall</h1>
        <p className="mt-2 max-w-3xl text-[1rem] leading-snug text-ink-2">Every decision below was planned and executed by Nemotron agents calling real tools.</p>
        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line font-mono sm:grid-cols-5">
          {[
            ["runs", String(all.length)],
            ["live now", String(live)],
            ["tool calls", String(stats.tools)],
            ["avg model latency", stats.avg ? duration(stats.avg) : "—"],
            ["providers", [...stats.prov.entries()].map(([p, n]) => `${p} ${n}`).join(" · ") || "—"],
          ].map(([k, v]) => (
            <div key={k} className="bg-surface px-3 py-2.5">
              <dt className="text-[0.66rem] uppercase tracking-wider text-ink-3">{k}</dt>
              <dd className="num mt-0.5 truncate text-[0.95rem] font-semibold text-ink" title={v}>{v}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="no-scrollbar -mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter by workflow">
        {(["all", ...WORKFLOWS] as const).map((w) => (
          <button
            key={w}
            type="button"
            aria-pressed={wf === w}
            onClick={() => setWf(w)}
            className={cx("shrink-0 rounded-lg border px-3 py-1.5 font-mono text-[0.78rem] font-medium transition-colors", wf === w ? "border-brand bg-brand text-brand-ink" : "border-line-strong bg-surface text-ink-2 hover:text-ink")}
          >
            {w === "all" ? "all" : WORKFLOW_LABEL[w].toLowerCase()} <span className="num opacity-70">{counts[w] ?? 0}</span>
          </button>
        ))}
      </div>

      {!ready ? (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 !rounded-xl" />)}</div>
      ) : runs.length ? (
        <div className="grid items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {runs.map((r, i) => <RunCard key={r.run_id} run={r} events={byRun.get(r.run_id) ?? []} household={nameOf(r.household_id)} defaultOpen={r.status === "running" || i < 4} />)}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-line-strong px-6 py-12 text-center">
          <p className="font-medium">No {wf === "all" ? "" : `${WORKFLOW_LABEL[wf].toLowerCase()} `}runs yet.</p>
          <p className="mt-1 text-sm text-ink-2">Start a Huddle or ask the Coach in <Link href="/room/hh_rivera" className="font-medium text-brand-strong underline underline-offset-2">the Riveras&apos; room</Link> and watch the agents here.</p>
        </div>
      )}
    </Shell>
  );
}
