"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown } from "@/components/icons";
import { AppShell } from "@/components/shell/AppShell";
import { ProviderBadge, providerName, runProviders } from "@/components/trace/badges";
import { runTotals, TraceTimeline } from "@/components/trace/TraceTimeline";
import { Button, Card, Chip, Empty, LivePill, PageHeader, Skeleton } from "@/components/ui";
import { DEMO_HOUSEHOLD_ID, PRODUCT_NAME } from "@/lib/constants";
import { useDataReady, useDataScope, useHouseholds, useRuns, useTraceByRun } from "@/lib/data/hooks";
import { useNow } from "@/lib/data/finance-hooks";
import { cx, duration, relTime } from "@/lib/format";
import { useLastHousehold } from "@/lib/lastHousehold";
import { openTrace } from "@/lib/traceUi";
import { WORKFLOWS, WORKFLOW_LABEL, type AgentRun, type TraceEvent, type Workflow } from "@/lib/types";

const runDomId = (id: string) => `run-${id}`;

function RunStatus({ status }: { status: AgentRun["status"] }) {
  if (status === "running") return <Chip tone="brand"><span className="anim-blink h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />Live</Chip>;
  if (status === "error") return <Chip tone="risk">Error</Chip>;
  return <Chip tone="good">Done</Chip>;
}

/** The expanded timeline of one run; follows the newest step while the run is live. */
function RunBody({ run, events }: { run: AgentRun; events: readonly TraceEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const running = run.status === "running";
  return (
    <div id={`${runDomId(run.run_id)}-body`} className="border-t border-line bg-surface-2">
      <div ref={ref} className="max-h-[32rem] overflow-y-auto px-4 py-4">
        {events.length ? <TraceTimeline events={events} running={running} autoScroll={running} scrollRef={ref} /> : <p className="text-[0.84rem] text-ink-3">Waiting for the first step…</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2">
        <p className="text-[0.74rem] text-ink-3">Run <span className="num">{run.run_id}</span></p>
        <Button size="sm" variant="secondary" onClick={() => openTrace(run.run_id)}>Open in side panel</Button>
      </div>
    </div>
  );
}

function RunRow({
  run, events, household, now, open, onToggle, linked,
}: {
  run: AgentRun;
  events: readonly TraceEvent[];
  household: string;
  now: number;
  open: boolean;
  onToggle: () => void;
  linked: boolean;
}) {
  const totals = useMemo(() => runTotals(events), [events]);
  const providers = useMemo(() => runProviders(events), [events]);
  const toolCalls = useMemo(() => events.filter((e) => e.type === "tool_call").length, [events]);
  const tokens = totals.tin + totals.tout;
  return (
    <li
      id={runDomId(run.run_id)}
      className={cx("scroll-mt-20 border-l-[3px]", linked ? "border-l-brand bg-brand-soft" : "border-l-transparent")}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${runDomId(run.run_id)}-body`}
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Chip>{WORKFLOW_LABEL[run.workflow]}</Chip>
            <RunStatus status={run.status} />
            {linked ? <Chip tone="brand">Linked run</Chip> : null}
            <span className="text-[0.88rem] font-semibold">{household}</span>
            <span className="num text-[0.76rem] text-ink-3">{relTime(run.started_at, now)}</span>
          </span>
          <span className="num mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[0.78rem] text-ink-2">
            <span><b className="font-semibold text-ink">{events.length}</b> steps</span>
            <span><b className="font-semibold text-ink">{toolCalls}</b> tool calls</span>
            <span><b className="font-semibold text-ink">{totals.latency ? duration(totals.latency) : "—"}</b> model time</span>
            <span><b className="font-semibold text-ink">{tokens ? tokens.toLocaleString() : "—"}</b> tokens</span>
          </span>
          {providers.length ? (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {providers.map((e) => <ProviderBadge key={`${e.model}${e.provider}`} model={e.model} provider={e.provider} />)}
            </span>
          ) : null}
        </span>
        <IconChevronDown size={18} className={cx("mt-1 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>
      {open ? <RunBody run={run} events={events} /> : null}
    </li>
  );
}

function Stat({ label, value, title, className }: { label: string; value: string; title?: string; className?: string }) {
  return (
    <div className={cx("bg-surface px-3.5 py-3", className)}>
      <dt className="text-[0.74rem] text-ink-3">{label}</dt>
      <dd className="num mt-0.5 truncate text-[1.05rem] font-semibold leading-tight text-ink" title={title ?? value}>{value}</dd>
    </div>
  );
}

function TrailBody() {
  useDataScope("agents");
  const ready = useDataReady();
  const params = useSearchParams();
  const focus = params.get("run");
  const [wf, setWf] = useState<Workflow | "all">("all");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const all = useRuns();
  const byRun = useTraceByRun();
  const households = useHouseholds();
  const now = useNow(30_000).getTime();
  const scrolled = useRef<string | null>(null);

  const runs = useMemo(() => (wf === "all" ? all : all.filter((r) => r.workflow === wf)), [all, wf]);
  const nameOf = (id: string) => households.find((h) => h.id === id)?.name ?? (id.startsWith("hh_sbx_") ? "Private sandbox" : id || "Unknown household");

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const r of all) c[r.workflow] = (c[r.workflow] ?? 0) + 1;
    return c;
  }, [all]);
  const live = useMemo(() => all.filter((r) => r.status === "running").length, [all]);
  const stats = useMemo(() => {
    let tools = 0;
    let lat = 0;
    let n = 0;
    const prov = new Map<string, number>();
    for (const evs of byRun.values()) {
      for (const e of evs) {
        if (e.type === "tool_call") tools++;
        if (e.latency_ms && e.model && e.provider !== "cache") {
          lat += e.latency_ms;
          n++;
        }
        if (e.model || e.provider === "cache") {
          const p = providerName(e.provider) || "Unknown";
          prov.set(p, (prov.get(p) ?? 0) + 1);
        }
      }
    }
    return { tools, avg: n ? lat / n : 0, prov: [...prov.entries()].sort((a, b) => b[1] - a[1]) };
  }, [byRun]);

  // First open run: the linked one, otherwise the newest run if it is still going.
  const defaultOpenId = focus && all.some((r) => r.run_id === focus) ? focus : runs[0]?.status === "running" ? runs[0].run_id : null;

  // ?run=<id>: bring that run into view once it has rendered, once per link.
  const focusReady = !!focus && ready && all.some((r) => r.run_id === focus);
  useEffect(() => {
    if (!focus || !focusReady || scrolled.current === focus) return;
    const el = document.getElementById(runDomId(focus));
    if (!el) return;
    scrolled.current = focus;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focus, focusReady]);

  const provText = stats.prov.map(([p, n]) => `${p} ${n}`).join(" · ");

  return (
    <>
      <PageHeader
        title="Agent Trail"
        sub="Every decision below was planned and executed by Nemotron agents calling real tools."
        right={live ? <LivePill label={`${live} live now`} /> : undefined}
      />

      <dl className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-5" aria-label="Agent run totals">
        <Stat label="Runs" value={String(all.length)} />
        <Stat label="Live now" value={String(live)} />
        <Stat label="Tool calls" value={String(stats.tools)} />
        <Stat label="Avg model latency" value={stats.avg ? duration(stats.avg) : "—"} />
        <Stat label="Providers" value={provText || "—"} className="col-span-2 sm:col-span-1" />
      </dl>

      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by workflow">
        {(["all", ...WORKFLOWS] as const).map((w) => (
          <button
            key={w}
            type="button"
            aria-pressed={wf === w}
            onClick={() => setWf(w)}
            className={cx(
              "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[0.8rem] font-medium transition-colors",
              wf === w ? "on-dark border-dark bg-dark text-white" : "border-line-strong bg-surface text-ink-2 hover:text-ink",
            )}
          >
            {w === "all" ? "All runs" : WORKFLOW_LABEL[w]}
            <span className={cx("num text-[0.72rem]", wf === w ? "text-white/70" : "text-ink-3")}>{counts[w] ?? 0}</span>
          </button>
        ))}
      </div>

      {!ready ? (
        <Card aria-busy="true" aria-label="Loading agent runs" className="divide-y divide-line">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2 px-4 py-3.5">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </Card>
      ) : runs.length ? (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" aria-label="Agent runs, newest first">
            {runs.map((r) => (
              <RunRow
                key={r.run_id}
                run={r}
                events={byRun.get(r.run_id) ?? []}
                household={nameOf(r.household_id)}
                now={now}
                open={overrides[r.run_id] ?? r.run_id === defaultOpenId}
                onToggle={() => setOverrides((o) => ({ ...o, [r.run_id]: !(o[r.run_id] ?? r.run_id === defaultOpenId) }))}
                linked={r.run_id === focus}
              />
            ))}
          </ul>
        </Card>
      ) : (
        <Empty title={wf === "all" ? "No agent runs yet" : `No ${WORKFLOW_LABEL[wf].toLowerCase()} runs yet`}>
          Start Table Mode or ask {PRODUCT_NAME} a question in{" "}
          <Link href={`/room/${DEMO_HOUSEHOLD_ID}`} className="font-medium text-brand-strong underline underline-offset-2">the demo household</Link>
          {" "}and watch the agents work here.
        </Empty>
      )}
    </>
  );
}

/** Global activity log of every agent run, across households. Honors `?run=<run_id>` to open and highlight one run. */
export function AgentTrail() {
  const householdId = useLastHousehold();
  return (
    <AppShell householdId={householdId} header={<h1 className="sr-only">Agent Trail</h1>}>
      <TrailBody />
    </AppShell>
  );
}
