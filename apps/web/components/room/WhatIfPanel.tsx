"use client";
import { useMemo, useState } from "react";
import { IconSend, IconSpark } from "@/components/icons";
import { Button, Card, Chip, Empty, SectionTitle, Spinner, type Tone } from "@/components/ui";
import { requestSimulation } from "@/lib/data/actions";
import { useScenarios } from "@/lib/data/hooks";
import { cx, metric, relTime } from "@/lib/format";
import { openTrace } from "@/lib/traceUi";
import type { Scenario } from "@/lib/types";
import { ForecastChart } from "./ForecastChart";

const CHIPS = ["Buy a $32k car in March", "Open a second bakery location", "Pay off the Visa", "Lose $1,000 a month of income"];
const VERDICT: Record<string, { tone: Tone; label: string }> = { fine: { tone: "good", label: "Works comfortably" }, tight: { tone: "watch", label: "Tight" }, risky: { tone: "risk", label: "Risky" } };

function ScenarioCard({ s }: { s: Scenario }) {
  const r = s.result;
  const chart = useMemo(() => {
    if (!r?.series?.length) return null;
    const points = r.series.map((p) => ({ id: `${s.id}:${p.date}`, household_id: s.household_id, date: p.date, balance: p.baseline, obligations_due: p.obligations_due ?? 0 }));
    const low = r.low_point ?? null;
    return { points, low, overlay: r.series.map((p) => ({ date: p.date, scenario: p.scenario })) };
  }, [r, s.id, s.household_id]);
  const v = r?.verdict ? VERDICT[r.verdict] : null;
  const pending = s.status === "queued" || s.status === "running";
  return (
    <Card className="anim-fade p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {pending ? <Chip tone="brand"><Spinner size={11} /> {s.status === "queued" ? "Queued" : "Agents simulating…"}</Chip> : s.status === "error" ? <Chip tone="risk">Failed</Chip> : v ? <Chip tone={v.tone}>{v.label}</Chip> : <Chip tone="good">Done</Chip>}
        <span className="text-[0.74rem] text-ink-3">{s.requested_by_name} · {relTime(s.created_at)}</span>
      </div>
      <h3 className="mt-1.5 font-display text-[1.02rem] font-semibold leading-snug">“{s.prompt}”</h3>
      {pending ? (
        <div className="mt-3 space-y-2" aria-busy="true"><div className="skeleton h-4 w-5/6" /><div className="skeleton h-4 w-2/3" /></div>
      ) : r ? (
        <>
          {r.summary ? <p className="mt-2 text-[0.9rem] leading-relaxed text-ink-2">{r.summary}</p> : null}
          {r.metrics?.length ? (
            <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {r.metrics.map((m) => {
                const worse = m.before !== undefined && (m.unit === "usd" && m.label.includes("payments") ? m.after > m.before : m.after < m.before);
                return (
                  <div key={m.label} className="rounded-xl bg-surface-2 p-2.5">
                    <dt className="text-[0.72rem] leading-tight text-ink-2">{m.label}</dt>
                    <dd className="num mt-1 flex items-baseline gap-1.5">
                      {m.before !== undefined ? <span className="text-[0.8rem] text-ink-3 line-through">{metric(m.before, m.unit)}</span> : null}
                      <span className={cx("font-display text-lg font-bold", worse ? "text-watch" : "text-good")}>{metric(m.after, m.unit)}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : null}
          {chart ? (
            <div className="mt-3 rounded-xl bg-surface-2 p-2.5">
              <ForecastChart embedded points={chart.points} low={chart.low} overlay={chart.overlay} height={180} title="Baseline vs. with this change" />
            </div>
          ) : null}
          {r.suggestion ? <p className="mt-3 flex gap-2 rounded-xl bg-brand-soft p-3 text-[0.85rem] leading-snug text-brand-strong"><IconSpark size={16} className="mt-0.5 shrink-0" />{r.suggestion}</p> : null}
        </>
      ) : null}
    </Card>
  );
}

export function WhatIfPanel({ householdId }: { householdId: string }) {
  const scenarios = useScenarios(householdId);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(p: string) {
    const q = p.trim();
    if (!q) return;
    setBusy(true);
    setErr(null);
    try {
      await requestSimulation(householdId, q);
      setPrompt("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't start the simulation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="whatif-h" className="space-y-3">
      <SectionTitle id="whatif-h" title="What if…?" sub="Describe a decision in plain English. Agents replay your next 90 days with it." right={<Button size="sm" variant="ghost" onClick={() => openTrace()}>Trace</Button>} />
      <Card className="p-4">
        <form onSubmit={(e) => { e.preventDefault(); void run(prompt); }}>
          <label htmlFor="whatif-in" className="sr-only">What-if scenario</label>
          <div className="flex gap-2">
            <input id="whatif-in" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Buy a $32k car in March" className="h-12 min-w-0 flex-1 rounded-xl border border-line-strong bg-bg px-3 text-base outline-none focus:border-brand" />
            <Button type="submit" size="md" disabled={busy || !prompt.trim()} aria-label="Run what-if"><IconSend size={18} /><span className="hidden sm:inline">Simulate</span></Button>
          </div>
        </form>
        <div className="no-scrollbar -mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1">
          {CHIPS.map((c) => (
            <button key={c} type="button" disabled={busy} onClick={() => void run(c)} className="shrink-0 rounded-full border border-line-strong bg-surface px-3.5 py-2 text-[0.84rem] font-medium text-ink hover:border-brand hover:bg-brand-soft disabled:opacity-50">
              {c}
            </button>
          ))}
        </div>
        {err ? <p role="alert" className="mt-2 text-sm text-risk">{err}</p> : null}
      </Card>
      {scenarios.length ? scenarios.map((s) => <ScenarioCard key={s.id} s={s} />) : <Empty title="No what-ifs yet">Tap a suggestion above. Results appear for everyone in the room.</Empty>}
    </section>
  );
}
