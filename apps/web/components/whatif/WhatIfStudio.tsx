"use client";
import { useMemo, useState } from "react";
import { IconAlert, IconArrowRight, IconCheck, IconSend, IconSpark } from "@/components/icons";
import { ScenarioChart } from "@/components/charts/lazy";
import { Button, Chip, Empty, ErrorNote, inputCls, PageHeader, Panel, Skeleton, Spinner, type Tone } from "@/components/ui";
import { requestSimulation } from "@/lib/data/actions";
import { useRoomTables, useRuns, useScenarios } from "@/lib/data/hooks";
import { cx, metric, relTime } from "@/lib/format";
import { openTrace } from "@/lib/traceUi";
import type { AgentRun, Scenario } from "@/lib/types";

const CHIPS = ["Buy a $32k car in March", "Open a second bakery location", "Pay off the Visa", "Lose $1,000 a month of income"];

const VERDICT: Record<NonNullable<NonNullable<Scenario["result"]>["verdict"]>, { tone: Tone; label: string; banner: string }> = {
  fine: { tone: "good", label: "Works comfortably", banner: "border-transparent bg-good-soft text-good" },
  tight: { tone: "watch", label: "Tight", banner: "border-transparent bg-watch-soft text-watch" },
  risky: { tone: "risk", label: "Risky", banner: "border-transparent bg-risk-soft text-risk" },
};

const isPending = (s: Scenario) => s.status === "queued" || s.status === "running";

/** The what_if run that answered this scenario: the earliest run that started right after it was requested. */
function runFor(s: Scenario, runs: readonly AgentRun[]): AgentRun | undefined {
  const t0 = new Date(s.created_at).getTime() - 5_000;
  let best: AgentRun | undefined;
  let bestT = Infinity;
  for (const r of runs) {
    const t = new Date(r.started_at).getTime();
    if (t >= t0 && t - t0 < 10 * 60_000 && t < bestT) {
      best = r;
      bestT = t;
    }
  }
  return best;
}

function StatusChip({ s }: { s: Scenario }) {
  if (isPending(s)) return <Chip tone="brand"><Spinner size={11} />{s.status === "queued" ? "Queued" : "Agents simulating…"}</Chip>;
  if (s.status === "error") return <Chip tone="risk">Failed</Chip>;
  const v = s.result?.verdict ? VERDICT[s.result.verdict] : null;
  return v ? <Chip tone={v.tone}>{v.label}</Chip> : <Chip tone="good">Done</Chip>;
}

/** Quiet one-word status for list rows; the full chip is reserved for the open result. */
function StatusText({ s }: { s: Scenario }) {
  if (isPending(s)) return <span className="inline-flex items-center gap-1 text-brand-strong"><Spinner size={10} />{s.status === "queued" ? "Queued" : "Simulating"}</span>;
  if (s.status === "error") return <span className="text-risk">Failed</span>;
  const v = s.result?.verdict ? VERDICT[s.result.verdict] : null;
  return <span className={v ? (v.tone === "good" ? "text-good" : v.tone === "watch" ? "text-watch" : "text-risk") : "text-good"}>{v ? v.label : "Done"}</span>;
}

function ResultSkeleton({ status }: { status: Scenario["status"] }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <p className="flex items-center gap-2 text-[0.88rem] font-medium text-ink-2">
        <Spinner size={15} /> {status === "queued" ? "Queued. Waiting for an agent…" : "Simulating your next 90 days…"}
      </p>
      <Skeleton className="mt-3 h-14" />
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
    </div>
  );
}

function Result({ s, run }: { s: Scenario; run?: AgentRun }) {
  const r = s.result;
  const v = r?.verdict ? VERDICT[r.verdict] : null;
  const pending = isPending(s);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusChip s={s} />
        <span className="text-[0.76rem] text-ink-3">{s.requested_by_name} · {relTime(s.created_at)}</span>
      </div>
      <h3 className="mt-1.5 text-[1.05rem] font-semibold leading-snug">“{s.prompt}”</h3>

      {pending ? (
        <div className="mt-3"><ResultSkeleton status={s.status} /></div>
      ) : s.status === "error" ? (
        <ErrorNote className="mt-3">The agents couldn&apos;t finish this one. Try rephrasing it.</ErrorNote>
      ) : r ? (
        <>
          {v ? (
            <div className={cx("mt-3 flex items-start gap-2.5 rounded-md border px-3 py-2.5", v.banner)} role="status">
              <span className="mt-0.5 shrink-0" aria-hidden="true">{r.verdict === "fine" ? <IconCheck size={18} /> : <IconAlert size={18} />}</span>
              <div className="min-w-0">
                <p className="text-[0.95rem] font-semibold leading-tight">{v.label}</p>
                {r.summary ? <p className="mt-0.5 text-[0.86rem] leading-snug text-ink">{r.summary}</p> : null}
              </div>
            </div>
          ) : r.summary ? (
            <p className="mt-3 text-[0.9rem] leading-relaxed text-ink-2">{r.summary}</p>
          ) : null}

          {r.metrics?.length ? (
            <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {r.metrics.map((m) => {
                const changed = m.before !== undefined && m.after !== m.before;
                const worse = changed && m.before !== undefined && (m.label.toLowerCase().includes("payments") ? m.after > m.before : m.after < m.before);
                return (
                  <div key={m.label} className="rounded-md bg-surface-2 px-3 py-2.5">
                    <dt className="text-[0.76rem] leading-tight text-ink-3">{m.label}</dt>
                    <dd className="num mt-1 flex flex-wrap items-center gap-x-1.5">
                      {m.before !== undefined ? (
                        <>
                          <span className="text-[0.84rem] text-ink-3">{metric(m.before, m.unit)}</span>
                          <span className="sr-only">changes to</span>
                          <IconArrowRight size={13} className="text-ink-3" />
                        </>
                      ) : null}
                      <span className={cx("text-[1.2rem] font-semibold leading-tight", !changed ? "text-ink" : worse ? "text-watch" : "text-good")}>{metric(m.after, m.unit)}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : null}

          {r.series?.length ? (
            <div className="mt-4">
              <h4 className="mb-2 text-[0.8rem] font-semibold text-ink-2">Cash balance, with and without this change</h4>
              <ScenarioChart series={r.series} lowPoint={r.low_point} verdict={r.verdict} />
            </div>
          ) : null}

          {r.suggestion ? (
            <div className="mt-3 flex items-start gap-2.5 rounded-md bg-brand-soft p-3 text-brand-strong">
              <IconSpark size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-[0.76rem] font-semibold">Suggestion</p>
                <p className="mt-0.5 text-[0.88rem] leading-snug">{r.suggestion}</p>
              </div>
            </div>
          ) : null}

          {!r.summary && !r.metrics?.length && !r.series?.length && !r.suggestion ? (
            <div className="mt-3"><Empty title="No details came back">Run it again to retry.</Empty></div>
          ) : null}

          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={() => openTrace(run?.run_id)}>
              How the agents got this <IconArrowRight size={13} />
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** What-If Studio: describe a decision in plain English, agents replay the next 90 days, and the room sees the result. */
export function WhatIfStudio({ householdId }: { householdId: string }) {
  const ready = useRoomTables(householdId, ["scenario"]);
  const scenarios = useScenarios(householdId);
  const runs = useRuns({ householdId, workflow: "what_if" });
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Newest scenario is selected until someone picks another one.
  const selected = scenarios.find((s) => s.id === selectedId) ?? scenarios[0];
  const run = useMemo(() => (selected ? runFor(selected, runs) : undefined), [selected, runs]);

  async function submit(p: string) {
    const q = p.trim();
    if (!q || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await requestSimulation(householdId, q);
      setPrompt("");
      setSelectedId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't start the simulation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="What-If Studio" sub="Describe a decision. The agents replay your next 90 days with it." />

      <Panel id="whatif-ask" title="What if we…">
        <form onSubmit={(e) => { e.preventDefault(); void submit(prompt); }}>
          <label htmlFor="whatif-in" className="sr-only">What-if scenario</label>
          <div className="flex gap-2">
            <input
              id="whatif-in"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Buy a $32k car in March"
              autoComplete="off"
              className={cx(inputCls, "min-w-0 flex-1")}
            />
            <Button type="submit" disabled={busy || !prompt.trim()}>
              {busy ? <Spinner size={15} /> : <IconSend size={16} />}
              <span className="sr-only sm:not-sr-only">Simulate</span>
            </Button>
          </div>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Scenario suggestions">
          {CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              disabled={busy}
              onClick={() => void submit(c)}
              className="min-h-9 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[0.8rem] font-medium text-ink-2 transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink disabled:opacity-50"
            >
              {c}
            </button>
          ))}
        </div>
        {err ? <ErrorNote className="mt-2">{err}</ErrorNote> : null}
      </Panel>

      {!ready ? (
        <Skeleton className="mt-3 h-64 !rounded-lg" />
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <Panel id="whatif-result" title="Result">
            {selected ? (
              <Result s={selected} run={run} />
            ) : (
              <Empty title="No what-ifs yet">Tap a suggestion above. The agents will show the effect on cash, runway and payments.</Empty>
            )}
          </Panel>

          {scenarios.length > 1 ? (
            <Panel id="whatif-history" title="Earlier what-ifs">
              <ul className="-my-1 divide-y divide-line" aria-label="Scenario history, newest first">
                {scenarios.slice(0, 6).map((s) => {
                  const on = s.id === selected?.id;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(s.id)}
                        aria-current={on ? "true" : undefined}
                        className={cx("-mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-2.5 text-left transition-colors", on ? "bg-brand-soft" : "hover:bg-surface-2")}
                      >
                        <span className="line-clamp-2 text-[0.86rem] font-medium leading-snug">{s.prompt}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[0.76rem] text-ink-3">
                          <StatusText s={s} />
                          <span>{s.requested_by_name} · {relTime(s.created_at)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ) : null}
        </div>
      )}
    </>
  );
}
