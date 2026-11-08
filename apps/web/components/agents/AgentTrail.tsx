"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown } from "@/components/icons";
import { AppShell } from "@/components/shell/AppShell";
import { ProviderBadge, providerName, runProviders } from "@/components/trace/badges";
import { runTotals, TraceTimeline } from "@/components/trace/TraceTimeline";
import { Button, Card, Chip, Empty, LivePill, PageHeader, Skeleton } from "@/components/ui";
import { DEMO_HOUSEHOLD_ID, PRODUCT_NAME } from "@/lib/constants";
import { useDataReady, useDataScope, useHouseholds, useRuns, useRunTraces, useTraceByRun } from "@/lib/data/hooks";
import { useNow } from "@/lib/data/finance-hooks";
import { cx, duration, relTime } from "@/lib/format";
import { useLastHousehold } from "@/lib/lastHousehold";
import { openTrace } from "@/lib/traceUi";
import { WORKFLOWS, WORKFLOW_LABEL, type AgentRun, type TraceEvent, type Workflow } from "@/lib/types";

const runDomId = (id: string) => `run-${id}`;
/** Runs rendered at a time; the wall holds every run ever made. */
const PAGE = 15;
const NO_EVENTS: readonly TraceEvent[] = [];

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
        {events.length ? <TraceTimeline events={events} running={running} autoScroll={running} scrollRef={ref} /> : <p className="text-label text-ink-3">Waiting for the first step…</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2">
        <p className="text-caption text-ink-3">Run <span className="num">{run.run_id}</span></p>
        <Button size="sm" variant="secondary" onClick={() => openTrace(run.run_id)}>Open in side panel</Button>
      </div>
    </div>
  );
}

const RunRow = memo(function RunRow({
  run, events, household, now, open, onToggle, linked,
}: {
  run: AgentRun;
  events: readonly TraceEvent[];
  household: string;
  now: number;
  open: boolean;
  onToggle: (runId: string) => void;
  linked: boolean;
}) {
  const totals = useMemo(() => runTotals(events), [events]);
  const providers = useMemo(() => runProviders(events), [events]);
  const toolCalls = useMemo(() => events.filter((e) => e.type === "tool_call").length, [events]);
  const tokens = totals.tin + totals.tout;
  return (
    <li
      id={runDomId(run.run_id)}
      className={cx("relative scroll-mt-20", linked && "bg-brand-soft before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-brand")}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${runDomId(run.run_id)}-body`}
        onClick={() => onToggle(run.run_id)}
        className="press flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-body font-semibold text-ink">{WORKFLOW_LABEL[run.workflow]}</span>
            <RunStatus status={run.status} />
            <span className="text-label text-ink-2">{household}</span>
            <span className="num text-caption text-ink-3">{relTime(run.started_at, now)}</span>
          </span>
          <span className="num mt-1 block font-mono text-caption text-ink-3">
            {events.length
              ? `${events.length} ${events.length === 1 ? "step" : "steps"} · ${toolCalls} ${toolCalls === 1 ? "tool call" : "tool calls"}${totals.latency ? ` · ${duration(totals.latency)} model time` : ""}${tokens ? ` · ${tokens.toLocaleString()} tokens` : ""}`
              : run.status === "running" ? "Waiting for the first step…" : "Loading steps…"}
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
});

function TrailBody({ householdId }: { householdId: string }) {
  useDataScope("agents");
  const ready = useDataReady();
  const params = useSearchParams();
  const focus = params.get("run");
  const [wf, setWf] = useState<Workflow | "all">("all");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [limit, setLimit] = useState(PAGE);
  // only the family you are in: another family's coach plans and call transcripts are theirs
  const all = useRuns({ householdId });
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
  // Run counts per model provider (a run can use several). "Local tool" steps are not model calls, so they are left out.
  // The module stores `{provider, model, calls, ...}` objects; the mock engine stores bare names. Accept both.
  const providerCounts = useMemo(() => {
    const prov = new Map<string, number>();
    for (const r of all) {
      const names = new Set((r.providers as unknown[]).map((x) => (typeof x === "string" ? x : (x as { provider?: string } | null)?.provider ?? "")).filter((x) => x && x !== "local"));
      for (const p of names) {
        const name = providerName(p) || p;
        prov.set(name, (prov.get(name) ?? 0) + 1);
      }
    }
    return [...prov.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);

  // First open run: the linked one, otherwise the newest run if it is still going.
  const defaultOpenId = focus && all.some((r) => r.run_id === focus) ? focus : runs[0]?.status === "running" ? runs[0].run_id : null;

  const toggle = useCallback(
    (id: string) => setOverrides((o) => ({ ...o, [id]: !(o[id] ?? id === defaultOpenId) })),
    [defaultOpenId],
  );

  // ?run=<id>: bring that run into view once it has rendered, once per link.
  const focusReady = !!focus && ready && all.some((r) => r.run_id === focus);
  useEffect(() => {
    if (!focus || !focusReady || scrolled.current === focus) return;
    const el = document.getElementById(runDomId(focus));
    if (!el) return;
    scrolled.current = focus;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focus, focusReady]);

  const provText = providerCounts.map(([p, n]) => `${p} ${n}`).join(" · ");
  const focusIdx = focus ? runs.findIndex((r) => r.run_id === focus) : -1;
  const shown = runs.slice(0, Math.max(limit, focusIdx + 1));
  useRunTraces(shown);

  return (
    <>
      <PageHeader
        title="Agent Trail"
        sub={`Every step below was planned and run by Nemotron agents. Showing ${households.find((h) => h.id === householdId)?.name ?? "your household"} only.`}
        right={live ? <LivePill label={`${live} live now`} /> : undefined}
      />

      <p className="num mb-3 text-label text-ink-2" aria-label="Agent run totals">
        <span className="figure text-lead text-ink">{all.length}</span> {all.length === 1 ? "run" : "runs"}{provText ? <span className="text-ink-3"> · by provider: {provText}</span> : null}
      </p>

      <div className="no-scrollbar -mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Filter by workflow">
        {(["all", ...WORKFLOWS] as const).filter((w) => w === "all" || w === wf || (counts[w] ?? 0) > 0).map((w) => (
          <button
            key={w}
            type="button"
            aria-pressed={wf === w}
            onClick={() => { setWf(w); setLimit(PAGE); }}
            className={cx(
              "press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-label font-medium transition-colors",
              wf === w ? "border-transparent bg-dark text-dark-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink",
            )}
          >
            {w === "all" ? "All" : WORKFLOW_LABEL[w]}
            <span className={cx("num text-caption", wf === w ? "opacity-70" : "text-ink-3")}>{counts[w] ?? 0}</span>
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
            {shown.map((r) => (
              <RunRow
                key={r.run_id}
                run={r}
                events={byRun.get(r.run_id) ?? NO_EVENTS}
                household={nameOf(r.household_id)}
                now={now}
                open={overrides[r.run_id] ?? r.run_id === defaultOpenId}
                onToggle={toggle}
                linked={r.run_id === focus}
              />
            ))}
          </ul>
          {runs.length > shown.length ? (
            <div className="border-t border-line p-3 text-center">
              <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, runs.length - shown.length)} more ({runs.length - shown.length} left)</Button>
            </div>
          ) : null}
        </Card>
      ) : (
        <Empty title={wf === "all" ? "No agent runs yet" : `No ${WORKFLOW_LABEL[wf].toLowerCase()} runs yet`}>
          Start Table Mode or ask {PRODUCT_NAME} a question in{" "}
          <Link href={`/room/${DEMO_HOUSEHOLD_ID}`} className="font-medium text-brand-strong underline underline-offset-2">the demo household</Link>.
        </Empty>
      )}
    </>
  );
}

/** Activity log of every agent run for the household you are in. Honors `?run=<run_id>` to open and highlight one run. */
export function AgentTrail() {
  const householdId = useLastHousehold();
  return (
    <AppShell householdId={householdId} header={<h1 className="sr-only">Agent Trail</h1>}>
      <TrailBody householdId={householdId} />
    </AppShell>
  );
}
