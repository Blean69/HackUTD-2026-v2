"use client";
import { useMemo, useState } from "react";
import { IconAlert, IconBell, IconCheck, IconChevronDown, IconShield } from "@/components/icons";
import { Avatar, Button, Chip, Empty, ErrorNote, PageHeader, Panel, Skeleton, TableScroll } from "@/components/ui";
import { ackAlert } from "@/lib/data/actions";
import { useAdvisorNotes, useAlerts, useCreditProfiles, useMembers, usePresence, useRoomTables } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { cx, relTime, usd } from "@/lib/format";
import type { Alert, AlertKind, AlertSeverity } from "@/lib/types";

const first = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

// ------------------------------------------------------------------------------------------------ people

function scoreBand(score: number): { label: string; cls: string } {
  if (score >= 740) return { label: "Very good", cls: "text-good" };
  if (score >= 670) return { label: "Good", cls: "text-good" };
  if (score >= 580) return { label: "Fair", cls: "text-watch" };
  return { label: "Poor", cls: "text-risk" };
}
const utilCls = (u: number) => (u > 50 ? "text-risk" : u > 30 ? "text-watch" : "");

/** Members with their credit profile on the same row; a green dot marks who is in the room right now. */
function PeoplePanel({ householdId }: { householdId: string }) {
  const ready = useRoomTables(householdId, ["credit_profile"]);
  const members = useMembers(householdId);
  const present = usePresence(householdId);
  const profiles = useCreditProfiles(householdId);
  const rows = useMemo(() => {
    const used = new Set<string>();
    return members.map((m) => {
      const hit = present.find((p) => first(p.display_name) === first(m.name) && !used.has(p.identity));
      if (hit) used.add(hit.identity);
      return { member: m, online: !!hit, credit: profiles.find((c) => c.member_id === m.id) };
    });
  }, [members, present, profiles]);
  const income = members.reduce((s, m) => s + m.income_annual, 0);
  return (
    <Panel id="people" title="People" sub={members.length ? `${members.length} members · ${usd(income)} a year combined` : undefined} info="Credit scores and factors are synthetic.">
      {!members.length ? (
        <Empty title="No members yet">People you add to this household show up here.</Empty>
      ) : !ready ? (
        <Skeleton className="h-40" />
      ) : (
        <TableScroll>
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col" className="r hidden sm:table-cell">Income</th>
                <th scope="col" className="r">Credit score</th>
                <th scope="col" className="r">Utilization</th>
                <th scope="col" className="r hidden md:table-cell">Inquiries (12 mo)</th>
                <th scope="col" className="r hidden md:table-cell">Late (24 mo)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ member: m, online, credit }) => {
                const band = credit ? scoreBand(credit.score) : null;
                return (
                  <tr key={m.id}>
                    <td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={m.name} size={30} dot={online ? "online" : "off"} />
                        <span className="min-w-0">
                          <span className="block whitespace-nowrap font-medium">{m.name}</span>
                          <span className="block text-[0.72rem] text-ink-3"><span className="capitalize">{m.role}</span>, {m.age}{m.income_annual > 0 ? <span className="num sm:hidden"> · {usd(m.income_annual, { compact: true })}</span> : null}</span>
                        </span>
                      </span>
                    </td>
                    <td className="r num hidden whitespace-nowrap sm:table-cell">{m.income_annual > 0 ? usd(m.income_annual) : <span className="text-ink-3">n/a</span>}</td>
                    <td className="r">
                      {credit && band ? <><span className="num font-semibold">{credit.score}</span> <span className={cx("text-[0.74rem]", band.cls)}>{band.label}</span></> : <span className="text-ink-3">n/a</span>}
                    </td>
                    <td className={cx("r num", credit && utilCls(credit.utilization_pct))}>{credit ? `${Math.round(credit.utilization_pct)}%` : <span className="text-ink-3">n/a</span>}</td>
                    <td className={cx("r num hidden md:table-cell", credit && credit.hard_inquiries_12m > 3 && "text-watch")}>{credit ? credit.hard_inquiries_12m : "n/a"}</td>
                    <td className={cx("r num hidden md:table-cell", credit && credit.late_payments_24m > 0 && "text-risk")}>{credit ? credit.late_payments_24m : "n/a"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ advisor notes

function NotesPanel({ householdId }: { householdId: string }) {
  const ready = useRoomTables(householdId, ["advisor_note"]);
  const notes = useAdvisorNotes(householdId);
  return (
    <Panel id="notes" title="Advisor notes">
      {!ready ? (
        <Skeleton className="h-20" />
      ) : notes.length ? (
        <ul className="divide-y divide-line">
          {notes.slice(0, 15).map((n) => (
            <li key={n.id} className="flex gap-2.5 py-2.5 first:pt-0 last:pb-0">
              <Avatar name={n.author_name} size={28} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-[0.84rem]">
                  <span className="font-semibold">{n.author_name}</span>
                  <span className="num text-[0.74rem] text-ink-3">{relTime(n.created_at)}</span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-[0.86rem] leading-snug text-ink-2">{n.text}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No advisor notes yet">A note from your advisor shows up here live.</Empty>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ alerts

const SEV: Record<AlertSeverity, { label: string; edge: string; icon: string; text: string }> = {
  critical: { label: "Critical", edge: "border-l-risk", icon: "text-risk", text: "text-risk" },
  warn: { label: "Heads up", edge: "border-l-watch", icon: "text-watch", text: "text-watch" },
  info: { label: "FYI", edge: "border-l-info", icon: "text-info", text: "text-ink-3" },
};
const KIND: Record<AlertKind, { label: string; Icon: typeof IconAlert }> = {
  fraud: { label: "Fraud", Icon: IconShield },
  scam: { label: "Scam check", Icon: IconShield },
  data_quality: { label: "Data quality", Icon: IconAlert },
  obligation: { label: "Upcoming", Icon: IconBell },
  advisor: { label: "Advisor", Icon: IconBell },
  insight: { label: "Insight", Icon: IconBell },
};

function AlertRow({ alert, me }: { alert: Alert; me: string }) {
  const done = !!alert.acknowledged_by;
  const [open, setOpen] = useState(alert.severity === "critical" && !done);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sev = SEV[alert.severity];
  const kind = KIND[alert.kind];
  const panelId = `alert-${alert.id}`;

  async function ack() {
    setBusy(true);
    setErr(null);
    try {
      await ackAlert(alert.id, me);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't update this alert");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={cx("rounded-md border border-l-[3px] border-line bg-surface", done ? "border-l-line-strong" : sev.edge)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-start gap-2.5 px-3 py-2.5 text-left"
      >
        <kind.Icon size={17} className={cx("mt-0.5 shrink-0", done ? "text-ink-3" : sev.icon)} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-1.5 text-[0.74rem] text-ink-3">
            <span className={cx("font-semibold", done ? "text-ink-3" : sev.text)}>{done ? "Handled" : sev.label}</span>
            <span aria-hidden="true">·</span>
            <span>{kind.label}</span>
            <span aria-hidden="true">·</span>
            <span className="num">{relTime(alert.created_at)}</span>
          </span>
          <span className={cx("mt-1 block text-[0.88rem] font-semibold leading-snug", done && "text-ink-2")}>{alert.title}</span>
        </span>
        <IconChevronDown size={16} className={cx("mt-1 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={panelId} className="px-3 pb-3 pl-[2.4rem]">
          <p className="text-[0.84rem] leading-relaxed text-ink-2">{alert.detail}</p>
          <div className="mt-2.5">
            {done ? (
              <p className="inline-flex items-center gap-1.5 text-[0.8rem] text-ink-2">
                <IconCheck size={14} className="text-good" /> Acknowledged by {alert.acknowledged_by}
              </p>
            ) : (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void ack()}>
                <IconCheck size={15} /> I&apos;ve handled this
              </Button>
            )}
            {err ? <ErrorNote className="mt-1.5 !py-2">{err}</ErrorNote> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function AlertsPanel({ householdId }: { householdId: string }) {
  const alerts = useAlerts(householdId);
  const ident = useLocalIdentity();
  const me = ident.name ?? "Someone";
  const open = alerts.filter((a) => !a.acknowledged_by).length;
  return (
    <Panel
      id="alerts"
      title="Alerts"
      right={open ? <Chip tone="risk">{open} open</Chip> : alerts.length ? <Chip tone="good">All clear</Chip> : undefined}
    >
      {alerts.length ? (
        <ul className="space-y-2">{alerts.map((a) => <AlertRow key={a.id} alert={a} me={me} />)}</ul>
      ) : (
        <Empty title="No alerts">Nothing has been flagged.</Empty>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ page

export function HouseholdPage({ householdId }: { householdId: string }) {
  return (
    <div>
      <PageHeader title="Household" />
      <div className="space-y-3">
        <PeoplePanel householdId={householdId} />
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <AlertsPanel householdId={householdId} />
          <NotesPanel householdId={householdId} />
        </div>
      </div>
    </div>
  );
}
