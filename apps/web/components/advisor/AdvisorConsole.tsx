"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { IconBriefcase, IconChevronDown, IconSend } from "@/components/icons";
import { NamePrompt } from "@/components/NamePrompt";
import { Shell } from "@/components/Shell";
import { TraceDock } from "@/components/trace/TraceDrawer";
import { Button, Card, Chip, Skeleton, StatusDot, type Tone } from "@/components/ui";
import { joinRoom, postAdvisorNote } from "@/lib/data/actions";
import { useLocalIdentity } from "@/lib/data/identity";
import { useAdvisorNotes, useDataReady, useDataScope, useGoals, useHouseholds, useHouseholdSummaries, usePresenceAll, useRuns, type HouseholdSummary } from "@/lib/data/hooks";
import { cx, metric, relTime, usd } from "@/lib/format";
import { WORKFLOW_LABEL } from "@/lib/types";

const STATUS: Record<HouseholdSummary["status"], { tone: Tone; label: string }> = {
  good: { tone: "good", label: "Healthy" },
  watch: { tone: "watch", label: "Watch" },
  risk: { tone: "risk", label: "At risk" },
};
const NOTE_IDEAS = ["Your Visa utilization is high. Can we talk about a payoff plan?", "Nice progress this month. Keep it up!", "Please review the new alert with me when you have a minute."];

function Detail({ h, author }: { h: HouseholdSummary; author: string }) {
  const goals = useGoals(h.id);
  const notes = useAdvisorNotes(h.id);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  async function post() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await postAdvisorNote(h.id, author, t);
      setText("");
      setSent(true);
      setTimeout(() => setSent(false), 3500);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-4 border-t border-line bg-surface-2 p-4 lg:grid-cols-3">
      <div>
        <h3 className="text-[0.72rem] font-semibold uppercase tracking-wide text-ink-2">Health indicators</h3>
        <ul className="mt-2 space-y-1.5">
          {h.indicators.map((i) => (
            <li key={i.id} className="flex items-center gap-2 text-[0.84rem]">
              <StatusDot tone={i.status} />
              <span className="flex-1">{i.label}</span>
              <span className="num font-semibold">{metric(i.value, i.unit)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-[0.72rem] font-semibold uppercase tracking-wide text-ink-2">Open alerts &amp; goals</h3>
        <ul className="mt-2 space-y-1.5">
          {h.openAlerts.length ? h.openAlerts.slice(0, 6).map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-[0.84rem] leading-snug"><StatusDot tone={a.severity === "critical" ? "risk" : a.severity === "warn" ? "watch" : "info"} /><span>{a.title}</span></li>
          )) : <li className="text-[0.84rem] text-ink-3">No open alerts.</li>}
          {h.openAlerts.length > 6 ? <li className="text-[0.8rem] text-ink-3">+ {h.openAlerts.length - 6} more in their room</li> : null}
        </ul>
        <ul className="mt-3 space-y-1">
          {goals.slice(0, 4).map((g) => (
            <li key={g.id} className="flex items-baseline justify-between gap-2 text-[0.82rem]">
              <span className="truncate">{g.title}</span>
              <span className="shrink-0 text-ink-3">{g.feasibility ? g.feasibility.replace("_", " ") : "pending"}</span>
            </li>
          ))}
          {!goals.length ? <li className="text-[0.82rem] text-ink-3">No goals yet.</li> : null}
        </ul>
      </div>
      <div>
        <h3 className="text-[0.72rem] font-semibold uppercase tracking-wide text-ink-2">Post a note to this family</h3>
        <form className="mt-2" onSubmit={(e) => { e.preventDefault(); void post(); }}>
          <label htmlFor={`note-${h.id}`} className="sr-only">Note for {h.name}</label>
          <textarea id={`note-${h.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Appears live in their room…" className="w-full resize-y rounded-xl border border-line-strong bg-surface p-2.5 text-[0.9rem] outline-none focus:border-brand" />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {NOTE_IDEAS.map((n) => <button key={n} type="button" onClick={() => setText(n)} className="rounded-full border border-line-strong bg-surface px-2.5 py-1 text-[0.72rem] text-ink-2 hover:border-brand hover:text-ink">{n.length > 34 ? `${n.slice(0, 32)}…` : n}</button>)}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Button type="submit" size="sm" disabled={busy || !text.trim()}><IconSend size={14} /> Post note</Button>
            <Link href={`/room/${h.id}`} className="text-[0.82rem] font-medium text-brand-strong underline-offset-2 hover:underline">Open their room</Link>
          </div>
          {sent ? <p role="status" className="mt-2 text-[0.8rem] font-medium text-good">Posted. It&apos;s live in their room now.</p> : null}
        </form>
        {notes[0] ? <p className="mt-3 border-l-2 border-line-strong pl-2 text-[0.78rem] leading-snug text-ink-2">Last note ({relTime(notes[0].created_at)}): {notes[0].text}</p> : null}
      </div>
    </div>
  );
}

export function AdvisorConsole() {
  useDataScope("advisor");
  const ident = useLocalIdentity();
  const ready = useDataReady();
  const all = useHouseholdSummaries();
  // Private sandboxes belong to whoever made them; the console is about the seeded households.
  const unsorted = useMemo(() => all.filter((h) => !h.isSandbox), [all]);
  const everyone = usePresenceAll();
  const households = useHouseholds();
  const runs = useRuns();
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  const name = ident.name;

  useEffect(() => {
    if (ready && name) void joinRoom("", `${name} (advisor)`, "advisor");
  }, [ready, name]);

  // Most urgent first: critical alerts, then worst health status, then name.
  const summaries = useMemo(() => {
    const rank = { risk: 2, watch: 1, good: 0 } as const;
    const crit = (h: HouseholdSummary) => h.openAlerts.filter((x) => x.severity === "critical").length;
    return [...unsorted].sort((a, b) => crit(b) - crit(a) || rank[b.status] - rank[a.status] || a.name.localeCompare(b.name));
  }, [unsorted]);
  const riskiest = summaries[0];
  const expanded = open === undefined ? riskiest?.id : open;

  const totals = useMemo(() => ({
    households: summaries.length,
    critical: summaries.reduce((s, h) => s + h.openAlerts.filter((a) => a.severity === "critical").length, 0),
    atRisk: summaries.filter((h) => h.status === "risk").length,
    online: everyone.length,
  }), [summaries, everyone]);

  return (
    <Shell mood="advisor" maxWidth="max-w-6xl">
      <header className="mb-4">
        <div className="flex items-center gap-2 text-brand-strong"><IconBriefcase size={18} /><span className="text-[0.74rem] font-semibold uppercase tracking-[0.14em]">PNC advisor console</span></div>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight sm:text-3xl">Households</h1>
        <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">Every household&apos;s health, open alerts and goals in one place. Notes you post show up live in that family&apos;s room.</p>
      </header>

      <dl className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[["Households", totals.households, ""], ["Critical alerts", totals.critical, totals.critical ? "text-risk" : ""], ["At risk", totals.atRisk, totals.atRisk ? "text-watch" : ""], ["People online", totals.online, "text-good"]].map(([k, v, c]) => (
          <div key={String(k)} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 shadow-card">
            <dt className="text-[0.72rem] text-ink-2">{k}</dt>
            <dd className={cx("num font-display text-2xl font-bold", String(c))}>{v}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <Card className="overflow-hidden">
          {!ready ? (
            <div className="space-y-2 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : (
            <ul className="divide-y divide-line">
              {summaries.map((h) => {
                const s = STATUS[h.status];
                const crit = h.openAlerts.filter((a) => a.severity === "critical").length;
                const isOpen = expanded === h.id;
                return (
                  <li key={h.id}>
                    <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : h.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold">{h.name}</span>
                          {h.isSandbox ? <Chip tone="accent">sandbox</Chip> : null}
                          <Chip tone={s.tone}>{s.label}</Chip>
                          {crit ? <Chip tone="risk">{crit} critical</Chip> : null}
                        </span>
                        <span className="mt-0.5 block truncate text-[0.78rem] text-ink-2">{h.city}, {h.state} · {h.persona}</span>
                      </span>
                      <span className="hidden shrink-0 items-center gap-1 sm:flex" aria-label="Indicator statuses">
                        {h.indicators.map((i) => <StatusDot key={i.id} tone={i.status} />)}
                      </span>
                      <span className="hidden w-24 shrink-0 text-right sm:block">
                        <span className="num block text-sm font-semibold">{usd(h.netWorth)}</span>
                        <span className="block text-[0.7rem] text-ink-3">net worth</span>
                      </span>
                      <span className="w-14 shrink-0 text-right text-[0.78rem] text-ink-2">
                        <span className="num block"><b className="text-ink">{h.openAlerts.length}</b> alerts</span>
                        <span className="num block">{h.openGoals} goals</span>
                      </span>
                      {h.online ? <Chip tone="good" className="hidden md:inline-flex">{h.online} online</Chip> : null}
                      <IconChevronDown size={16} className={cx("shrink-0 text-ink-3 transition-transform", isOpen && "rotate-180")} />
                    </button>
                    {isOpen ? <Detail h={h} author={name ?? "Advisor"} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <aside aria-label="Live agent activity">
          <Card className="p-4">
            <h2 className="font-display text-base font-semibold">Live agent activity</h2>
            <ul className="mt-2 space-y-2">
              {runs.slice(0, 6).map((r) => (
                <li key={r.run_id} className="flex items-center gap-2 text-[0.82rem]">
                  <span className={cx("h-2 w-2 shrink-0 rounded-full", r.status === "running" ? "anim-blink bg-brand" : r.status === "error" ? "bg-risk" : "bg-good")} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate"><span className="font-medium">{WORKFLOW_LABEL[r.workflow]}</span> <span className="text-ink-3">· {households.find((x) => x.id === r.household_id)?.name.replace("The ", "").replace(" Household", "") ?? "sandbox"}</span></span>
                  <span className="shrink-0 text-[0.72rem] text-ink-3">{relTime(r.started_at)}</span>
                </li>
              ))}
              {!runs.length ? <li className="text-sm text-ink-3">No runs yet.</li> : null}
            </ul>
            <Link href="/agents" className="mt-3 inline-block text-[0.82rem] font-medium text-brand-strong underline-offset-2 hover:underline">Open the agent wall →</Link>
          </Card>
        </aside>
      </div>
      <TraceDock />
      {ready && !name ? <NamePrompt title="Advisor sign-in" context="Your name is shown on the notes you post and in the room's presence list." advisor /> : null}
    </Shell>
  );
}
