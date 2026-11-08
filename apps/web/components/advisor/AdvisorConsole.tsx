"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { IconChevronDown, IconSend } from "@/components/icons";
import { NamePrompt } from "@/components/NamePrompt";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Card, Chip, Empty, ErrorNote, PageHeader, Panel, Skeleton, StatusDot, TableScroll, type Tone } from "@/components/ui";
import { joinRoom, postAdvisorNote } from "@/lib/data/actions";
import { useAdvisorNotes, useDataReady, useDataScope, useGoals, useHouseholds, useHouseholdSummaries, usePresenceAll, useRuns, type HouseholdSummary } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { useNow } from "@/lib/data/finance-hooks";
import { cx, metric, relTime, usd } from "@/lib/format";
import { useLastHousehold } from "@/lib/lastHousehold";
import { WORKFLOW_LABEL } from "@/lib/types";

const STATUS: Record<HouseholdSummary["status"], { tone: Tone; label: string }> = {
  good: { tone: "good", label: "Healthy" },
  watch: { tone: "watch", label: "Watch" },
  risk: { tone: "risk", label: "At risk" },
};
const NOTE_IDEAS = ["Your Visa utilization is high. Can we talk about a payoff plan?", "Nice progress this month. Keep it up!"];
const FEAS_LABEL: Record<string, string> = { on_track: "On track", stretch: "Stretch", off_track: "Off track" };

const subHead = "text-[0.72rem] font-semibold uppercase tracking-wide text-ink-3";
const COLS = 6;

function Detail({ h, author, now }: { h: HouseholdSummary; author: string; now: number }) {
  const goals = useGoals(h.id);
  const notes = useAdvisorNotes(h.id);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function post() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr(null);
    try {
      await postAdvisorNote(h.id, author, t);
      setText("");
      setSent(true);
      setTimeout(() => setSent(false), 3500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't post that note");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 border-t border-line bg-surface-2 p-4 lg:grid-cols-3">
      <section aria-label={`Health indicators for ${h.name}`}>
        <h3 className={subHead}>Health indicators</h3>
        <ul className="mt-2 space-y-1.5">
          {h.indicators.map((i) => (
            <li key={i.id} className="flex items-center gap-2 text-[0.82rem]">
              <StatusDot tone={i.status} />
              <span className="min-w-0 flex-1 truncate">{i.label}</span>
              <span className="num font-semibold">{metric(i.value, i.unit)}</span>
              <span className="sr-only">{STATUS[i.status].label}</span>
            </li>
          ))}
          {!h.indicators.length ? <li className="text-[0.82rem] text-ink-3">No indicators computed yet.</li> : null}
        </ul>
      </section>

      <section aria-label={`Open alerts and goals for ${h.name}`}>
        <h3 className={subHead}>Alerts and goals</h3>
        <ul className="mt-2 space-y-1.5">
          {h.openAlerts.length ? h.openAlerts.slice(0, 6).map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-[0.82rem] leading-snug">
              <span className="mt-1"><StatusDot tone={a.severity === "critical" ? "risk" : a.severity === "warn" ? "watch" : "info"} /></span>
              <span className="min-w-0 flex-1">{a.title}</span>
              <span className="sr-only">{a.severity}</span>
            </li>
          )) : <li className="text-[0.82rem] text-ink-3">No open alerts.</li>}
          {h.openAlerts.length > 6 ? <li className="text-[0.78rem] text-ink-3">+ {h.openAlerts.length - 6} more in their room</li> : null}
        </ul>
        <ul className="mt-3 space-y-1 border-t border-line pt-2">
          {goals.slice(0, 4).map((g) => (
            <li key={g.id} className="flex items-baseline justify-between gap-2 text-[0.8rem]">
              <span className="min-w-0 truncate">{g.title}</span>
              <span className="shrink-0 text-ink-3">{g.feasibility ? FEAS_LABEL[g.feasibility] : "Pending"}</span>
            </li>
          ))}
          {!goals.length ? <li className="text-[0.8rem] text-ink-3">No goals yet.</li> : null}
        </ul>
      </section>

      <section aria-label={`Post a note to ${h.name}`}>
        <h3 className={subHead}>Note to this family</h3>
        <form className="mt-2" onSubmit={(e) => { e.preventDefault(); void post(); }}>
          <label htmlFor={`note-${h.id}`} className="sr-only">Note for {h.name}</label>
          <textarea
            id={`note-${h.id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="Appears live in their room…"
            className="w-full resize-y rounded-md border border-line-strong bg-surface p-2.5 text-[0.88rem] text-ink outline-none placeholder:text-ink-3 focus:border-brand"
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {NOTE_IDEAS.map((n) => (
              <button key={n} type="button" onClick={() => setText(n)} title={n} className="rounded-md border border-line-strong bg-surface px-2 py-1 text-[0.74rem] text-ink-2 hover:border-brand hover:text-ink">
                {n.length > 34 ? `${n.slice(0, 32)}…` : n}
              </button>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || !text.trim()}><IconSend size={15} /> Post note</Button>
            <Link href={`/room/${h.id}`} className="text-[0.82rem] font-medium text-brand-strong hover:underline">Open their room</Link>
          </div>
          {sent ? <p role="status" className="mt-2 text-[0.8rem] font-medium text-good">Posted. It&apos;s live in their room now.</p> : null}
          {err ? <ErrorNote className="mt-2 !py-2">{err}</ErrorNote> : null}
        </form>
        {notes[0] ? <p className="mt-3 border-l-2 border-line-strong pl-2 text-[0.78rem] leading-snug text-ink-2">Last note ({relTime(notes[0].created_at, now)}): {notes[0].text}</p> : null}
      </section>
    </div>
  );
}

function ConsoleBody() {
  useDataScope("advisor");
  const ident = useLocalIdentity();
  const ready = useDataReady();
  const all = useHouseholdSummaries();
  // Private sandboxes belong to whoever made them; the console is about the seeded households.
  const unsorted = useMemo(() => all.filter((h) => !h.isSandbox), [all]);
  const everyone = usePresenceAll();
  const households = useHouseholds();
  const runs = useRuns();
  const now = useNow(30_000).getTime();
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
  const expanded = open === undefined ? summaries[0]?.id : open;

  const totals = useMemo(() => ({
    households: summaries.length,
    critical: summaries.reduce((s, h) => s + h.openAlerts.filter((a) => a.severity === "critical").length, 0),
    atRisk: summaries.filter((h) => h.status === "risk").length,
    online: everyone.length,
  }), [summaries, everyone]);

  return (
    <>
      <PageHeader
        title="Advisor Console"
        sub="Households by urgency. A note you post shows up live in that family's room."
        right={name ? (
          <span className="inline-flex items-center gap-2 text-[0.82rem] font-medium">
            <Avatar name={name} size={22} />
            {name}
          </span>
        ) : undefined}
      />

      <p className="num mb-3 text-[0.86rem] text-ink-2" aria-label="Portfolio totals">
        <b className="font-semibold text-ink">{totals.households}</b> households
        <span aria-hidden="true"> · </span>
        <b className={cx("font-semibold", totals.critical ? "text-risk" : "text-ink")}>{totals.critical}</b> critical alerts
        <span aria-hidden="true"> · </span>
        <b className={cx("font-semibold", totals.atRisk ? "text-watch" : "text-ink")}>{totals.atRisk}</b> at risk
        <span aria-hidden="true"> · </span>
        <b className="font-semibold text-ink">{totals.online}</b> people online
      </p>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <Card className="overflow-hidden">
          {!ready ? (
            <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading households">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : summaries.length ? (
            <TableScroll className="!mx-0 !px-0">
              <table className="tbl">
                <caption className="sr-only">Households, most urgent first</caption>
                <thead>
                  <tr>
                    <th scope="col" className="!pl-4">Household</th>
                    <th scope="col">Health</th>
                    <th scope="col" className="r hidden sm:table-cell">Net worth</th>
                    <th scope="col" className="r">Alerts</th>
                    <th scope="col" className="hidden md:table-cell">In room</th>
                    <th scope="col" className="w-10 !pr-3"><span className="sr-only">Details</span></th>
                  </tr>
                </thead>
                {summaries.map((h) => {
                  const s = STATUS[h.status];
                  const crit = h.openAlerts.filter((a) => a.severity === "critical").length;
                  const isOpen = expanded === h.id;
                  const toggle = () => setOpen(isOpen ? null : h.id);
                  return (
                    <tbody key={h.id} className="border-t border-line first:border-t-0">
                      <tr onClick={toggle} className={cx("cursor-pointer hover:bg-surface-2", isOpen && "bg-surface-2")}>
                        <td className="!border-b-0 !py-2.5 !pl-4">
                          <button type="button" aria-expanded={isOpen} aria-controls={`adv-${h.id}`} onClick={(e) => { e.stopPropagation(); toggle(); }} className="block max-w-[9.5rem] rounded text-left sm:max-w-[15rem]">
                            <span className="block truncate text-[0.88rem] font-semibold">{h.name}</span>
                            <span className="block truncate text-[0.76rem] text-ink-2">{h.city}, {h.state} · {h.persona}</span>
                          </button>
                        </td>
                        <td className="!border-b-0">
                          <span className="flex flex-wrap gap-1">
                            <Chip tone={s.tone}>{s.label}</Chip>
                            {crit ? <span className="num text-[0.76rem] font-semibold text-risk">{crit} critical</span> : null}
                          </span>
                        </td>
                        <td className="num r hidden !border-b-0 text-[0.84rem] font-medium sm:table-cell">{usd(h.netWorth)}</td>
                        <td className="num r !border-b-0 text-[0.84rem]"><b className={cx("font-semibold", h.openAlerts.length ? "text-ink" : "text-ink-3")}>{h.openAlerts.length}</b></td>
                        <td className="hidden !border-b-0 text-[0.84rem] md:table-cell">{h.online ? <span className="num font-medium text-good">{h.online} online</span> : <span className="text-ink-3">—</span>}</td>
                        <td className="!border-b-0 !pr-3 text-ink-3"><IconChevronDown size={16} className={cx("transition-transform", isOpen && "rotate-180")} /></td>
                      </tr>
                      {isOpen ? (
                        <tr id={`adv-${h.id}`}>
                          <td colSpan={COLS} className="!border-b-0 !p-0"><Detail h={h} author={name ?? "Advisor"} now={now} /></td>
                        </tr>
                      ) : null}
                    </tbody>
                  );
                })}
              </table>
            </TableScroll>
          ) : (
            <div className="p-4"><Empty title="No households yet">They appear once the demo data has loaded.</Empty></div>
          )}
        </Card>

        <aside aria-label="Live agent activity">
          <Panel id="advisor-activity" title="Latest agent runs">
            <ul className="space-y-2">
              {runs.slice(0, 5).map((r) => (
                <li key={r.run_id} className="flex items-center gap-2 text-[0.82rem]">
                  <span className={cx("h-2 w-2 shrink-0 rounded-full", r.status === "running" ? "anim-blink bg-brand" : r.status === "error" ? "bg-risk" : "bg-good")} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{WORKFLOW_LABEL[r.workflow]}</span>{" "}
                    <span className="text-ink-3">· {households.find((x) => x.id === r.household_id)?.name.replace("The ", "").replace(" Household", "") ?? "Sandbox"}</span>
                    <span className="sr-only">, {r.status === "running" ? "running" : r.status}</span>
                  </span>
                  <span className="num shrink-0 text-[0.74rem] text-ink-3">{relTime(r.started_at, now)}</span>
                </li>
              ))}
              {!runs.length ? <li className="text-[0.82rem] text-ink-3">No runs yet.</li> : null}
            </ul>
            <Link href="/agents" className="mt-3 inline-block text-[0.82rem] font-medium text-brand-strong hover:underline">Open Agent Trail →</Link>
          </Panel>
        </aside>
      </div>

      {ready && !name ? <NamePrompt title="Advisor sign-in" context="Your name is shown on the notes you post." advisor /> : null}
    </>
  );
}

/** Bank-internal portfolio view: every household's health, alerts and goals, with a note box per family. */
export function AdvisorConsole() {
  const householdId = useLastHousehold();
  return (
    <AppShell householdId={householdId} header={<h1 className="sr-only">Advisor Console</h1>}>
      <ConsoleBody />
    </AppShell>
  );
}
