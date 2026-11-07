"use client";
import { useMemo, useState } from "react";
import { IconAlert, IconBell, IconCheck, IconChevronDown, IconShield } from "@/components/icons";
import { Avatar, Button, Chip, Empty, PageHeader, Panel, Progress, TableScroll, type Tone } from "@/components/ui";
import { ackAlert } from "@/lib/data/actions";
import { useAdvisorNotes, useAlerts, useCreditProfiles, useMembers, usePresence } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { cx, relTime, usd } from "@/lib/format";
import type { Alert, AlertKind, AlertSeverity, CreditProfile, Member, PresenceRole } from "@/lib/types";

const first = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const PRESENCE_ROLE: Record<PresenceRole, { tone: Tone; label: string }> = {
  family: { tone: "brand", label: "Family" },
  advisor: { tone: "info", label: "Advisor" },
  guest: { tone: "neutral", label: "Guest" },
};

// ------------------------------------------------------------------------------------------------ members

function MembersPanel({ householdId }: { householdId: string }) {
  const members = useMembers(householdId);
  const present = usePresence(householdId);
  const rows = useMemo(() => {
    const used = new Set<string>();
    return members.map((m) => {
      const hit = present.find((p) => first(p.display_name) === first(m.name) && !used.has(p.identity));
      if (hit) used.add(hit.identity);
      return { member: m, online: !!hit };
    });
  }, [members, present]);
  const income = members.reduce((s, m) => s + m.income_annual, 0);
  return (
    <Panel
      id="members"
      title="Members"
      sub={members.length ? `${members.length} ${members.length === 1 ? "person" : "people"} · ${usd(income)} combined annual income` : undefined}
    >
      {rows.length ? (
        <TableScroll>
          <table className="tbl min-w-[22rem]">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col" className="r">Age</th>
                <th scope="col" className="r">Annual income</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ member: m, online }) => (
                <tr key={m.id}>
                  <td>
                    <span className="flex items-center gap-2.5">
                      <Avatar name={m.name} size={30} dot={online ? "online" : "off"} />
                      <span className="min-w-0">
                        <span className="block whitespace-nowrap font-medium">{m.name}</span>
                        <span className="block text-[0.72rem] text-ink-3">{online ? "Here now" : "Not here"}</span>
                      </span>
                    </span>
                  </td>
                  <td><Chip>{cap(m.role)}</Chip></td>
                  <td className="r num">{m.age}</td>
                  <td className="r num whitespace-nowrap">{m.income_annual > 0 ? usd(m.income_annual) : <span className="text-ink-3">n/a</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : (
        <Empty title="No members yet">People you add to this household show up here.</Empty>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ here now

function HereNowPanel({ householdId }: { householdId: string }) {
  const people = usePresence(householdId);
  return (
    <Panel id="here-now" title="Here now" sub={people.length ? `${people.length} in this room right now` : undefined}>
      {people.length ? (
        <ul className="divide-y divide-line" aria-label="People in this room">
          {people.map((p) => {
            const role = PRESENCE_ROLE[p.role];
            return (
              <li key={p.identity} className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
                <Avatar name={p.display_name} size={28} dot="online" />
                <span className="min-w-0 flex-1 truncate text-[0.9rem] font-medium">{p.display_name}</span>
                {p.isMe ? <Chip tone="brand">you</Chip> : null}
                <Chip tone={role.tone}>{role.label}</Chip>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty title="Nobody is here right now">People who open this household appear here live.</Empty>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ credit

function scoreBand(score: number): { label: string; tone: Tone } {
  if (score >= 800) return { label: "Exceptional", tone: "good" };
  if (score >= 740) return { label: "Very good", tone: "good" };
  if (score >= 670) return { label: "Good", tone: "good" };
  if (score >= 580) return { label: "Fair", tone: "watch" };
  return { label: "Poor", tone: "risk" };
}
const utilTone = (u: number): Tone => (u > 50 ? "risk" : u > 30 ? "watch" : "good");
const TEXT: Record<string, string> = { good: "text-good", watch: "text-watch", risk: "text-risk", neutral: "text-ink" };

function Fact({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div>
      <dt className="text-[0.72rem] text-ink-3">{label}</dt>
      <dd className={cx("num text-[0.9rem] font-semibold", TEXT[tone] ?? "text-ink")}>{value}</dd>
    </div>
  );
}

function CreditCard({ profile, member }: { profile: CreditProfile; member?: Member }) {
  const band = scoreBand(profile.score);
  const name = member?.name ?? "Member";
  const range = Math.max(0, Math.min(100, ((profile.score - 300) / 550) * 100));
  return (
    <li className="rounded-md border border-line p-3">
      <div className="flex items-center gap-2.5">
        <Avatar name={name} size={28} />
        <p className="min-w-0 flex-1 truncate text-[0.9rem] font-medium">{name}</p>
        <p className="num text-[1.25rem] font-semibold leading-none" aria-label={`Credit score ${profile.score}`}>{profile.score}</p>
        <Chip tone={band.tone}>{band.label}</Chip>
      </div>
      <Progress value={range} tone={band.tone} label={`${name} credit score on a 300 to 850 scale`} className="mt-2.5" />
      <dl className="mt-3 grid grid-cols-3 gap-2">
        <Fact label="Utilization" value={`${Math.round(profile.utilization_pct)}%`} tone={utilTone(profile.utilization_pct)} />
        <Fact label="Hard inquiries (12 mo)" value={String(profile.hard_inquiries_12m)} tone={profile.hard_inquiries_12m > 3 ? "watch" : "neutral"} />
        <Fact label="Late payments (24 mo)" value={String(profile.late_payments_24m)} tone={profile.late_payments_24m > 1 ? "risk" : profile.late_payments_24m === 1 ? "watch" : "good"} />
      </dl>
    </li>
  );
}

function CreditPanel({ householdId }: { householdId: string }) {
  const profiles = useCreditProfiles(householdId);
  const members = useMembers(householdId);
  const sorted = useMemo(() => [...profiles].sort((a, b) => b.score - a.score), [profiles]);
  return (
    <Panel id="credit" title="Credit profiles" sub="Per member, on a 300 to 850 scale" info="Scores and factors are synthetic.">
      {sorted.length ? (
        <ul className="space-y-2.5">
          {sorted.map((p) => <CreditCard key={p.member_id} profile={p} member={members.find((m) => m.id === p.member_id)} />)}
        </ul>
      ) : (
        <Empty title="No credit profiles">Credit data appears here once it is available for a member.</Empty>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ advisor notes

function NotesPanel({ householdId }: { householdId: string }) {
  const notes = useAdvisorNotes(householdId);
  return (
    <Panel id="notes" title="Advisor notes" sub="Shared with everyone in the household">
      {notes.length ? (
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
        <Empty title="No advisor notes yet">When an advisor leaves a note for this household, it shows up here.</Empty>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ alerts

const SEV: Record<AlertSeverity, { tone: Tone; label: string; edge: string; icon: string }> = {
  critical: { tone: "risk", label: "Critical", edge: "border-l-risk", icon: "text-risk" },
  warn: { tone: "watch", label: "Heads up", edge: "border-l-watch", icon: "text-watch" },
  info: { tone: "info", label: "FYI", edge: "border-l-info", icon: "text-info" },
};
const KIND: Record<AlertKind, { label: string; Icon: typeof IconAlert }> = {
  fraud: { label: "Fraud", Icon: IconShield },
  scam: { label: "Scam check", Icon: IconShield },
  data_quality: { label: "Data quality", Icon: IconAlert },
  obligation: { label: "Upcoming", Icon: IconBell },
  advisor: { label: "Advisor", Icon: IconBell },
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
          <span className="flex flex-wrap items-center gap-1.5">
            <Chip tone={done ? "neutral" : sev.tone}>{done ? "Handled" : sev.label}</Chip>
            <Chip>{kind.label}</Chip>
            <span className="num text-[0.74rem] text-ink-3">{relTime(alert.created_at)}</span>
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
            {err ? <p role="alert" className="mt-1.5 text-[0.8rem] text-risk">{err}</p> : null}
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
      sub={alerts.length ? (open ? `${open} need a look. Everyone in the household sees updates live.` : "All clear. Nothing needs attention.") : undefined}
      right={open ? <Chip tone="risk">{open} open</Chip> : alerts.length ? <Chip tone="good">All clear</Chip> : undefined}
    >
      {alerts.length ? (
        <ul className="space-y-2">{alerts.map((a) => <AlertRow key={a.id} alert={a} me={me} />)}</ul>
      ) : (
        <Empty title="No alerts">Nothing has been flagged for this household.</Empty>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ page

export function HouseholdPage({ householdId }: { householdId: string }) {
  return (
    <div>
      <PageHeader title="Household" sub="Who is in the household, who is here now, credit health, advisor notes and alerts" />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <MembersPanel householdId={householdId} />
          <HereNowPanel householdId={householdId} />
          <CreditPanel householdId={householdId} />
        </div>
        <div className="min-w-0 space-y-4">
          <AlertsPanel householdId={householdId} />
          <NotesPanel householdId={householdId} />
        </div>
      </div>
    </div>
  );
}
