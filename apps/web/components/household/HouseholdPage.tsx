"use client";
import { useMemo, useState } from "react";
import { IconAlert, IconBell, IconCheck, IconChevronDown, IconShield, IconTrend } from "@/components/icons";
import { Avatar, Button, Chip, Empty, ErrorNote, List, ListRow, PageHeader, Panel, PanelLink, Skeleton } from "@/components/ui";
import { ackAlert } from "@/lib/data/actions";
import { useCredit } from "@/lib/data/credit-hooks";
import { useAlerts, useMembers, usePresence } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { cx, relTime, usd } from "@/lib/format";
import type { Alert, AlertKind, AlertSeverity } from "@/lib/types";

const first = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
const TONE_TEXT = { good: "text-good", watch: "text-watch", risk: "text-risk" } as const;

// ------------------------------------------------------------------------------------------------ people

/** Members with their (simulated) credit score; a green dot marks who is in the room right now. */
function PeoplePanel({ householdId, className }: { householdId: string; className?: string }) {
  const members = useMembers(householdId);
  const present = usePresence(householdId);
  const credit = useCredit(householdId, { withHistory: false });
  const rows = useMemo(() => {
    const used = new Set<string>();
    return members.map((m) => {
      const hit = present.find((p) => first(p.display_name) === first(m.name) && !used.has(p.identity));
      if (hit) used.add(hit.identity);
      return { member: m, online: !!hit, credit: credit.views.find((v) => v.member_id === m.id) };
    });
  }, [members, present, credit.views]);
  const income = members.reduce((s, m) => s + m.income_annual, 0);
  const here = rows.filter((r) => r.online).length;
  return (
    <Panel
      id="people"
      title={<>People <span className="num font-normal text-ink-3">{members.length}</span></>}
      sub={members.length ? <span className="num">{usd(income)} a year combined{here ? ` · ${here} in the room now` : ""}</span> : undefined}
      className={className}
      flush
      footer={credit.views.length ? <PanelLink href={`/room/${householdId}/credit`}>Credit monitoring</PanelLink> : undefined}
    >
      {!members.length ? (
        <div className="px-4 pb-3"><Empty title="No members yet">People you add to this household show up here.</Empty></div>
      ) : (
        <List label="Household members">
          {rows.map(({ member: m, online, credit: c }) => (
            <ListRow
              key={m.id}
              leading={<Avatar name={m.name} size={34} dot={online ? "online" : "off"} />}
              title={m.name}
              sub={<><span className="capitalize">{m.role}</span>, {m.age}{m.income_annual > 0 ? <span className="num"> · {usd(m.income_annual)} a year</span> : null}</>}
              trailing={c ? <span className="figure">{c.score}</span> : !credit.ready ? <Skeleton className="h-5 w-10" /> : undefined}
              meta={c ? <span className={cx("font-medium", TONE_TEXT[c.band.tone])}>{c.band.label}</span> : undefined}
              href={c ? `/room/${householdId}/credit` : undefined}
            />
          ))}
        </List>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ alerts

const SEV: Record<AlertSeverity, { label: string; edge: string; icon: string; text: string }> = {
  critical: { label: "Critical", edge: "before:bg-risk", icon: "text-risk", text: "text-risk" },
  warn: { label: "Heads up", edge: "before:bg-watch", icon: "text-watch", text: "text-watch" },
  info: { label: "FYI", edge: "before:bg-info", icon: "text-info", text: "text-ink-3" },
};
const KIND: Record<AlertKind, { label: string; Icon: typeof IconAlert }> = {
  fraud: { label: "Fraud", Icon: IconShield },
  scam: { label: "Scam check", Icon: IconShield },
  data_quality: { label: "Data quality", Icon: IconAlert },
  obligation: { label: "Upcoming", Icon: IconBell },
  advisor: { label: "Note", Icon: IconBell },
  insight: { label: "Insight", Icon: IconBell },
  credit: { label: "Credit", Icon: IconTrend },
};

function AlertRow({ alert, me }: { alert: Alert; me: string }) {
  const done = !!alert.acknowledged_by;
  const [open, setOpen] = useState(alert.severity === "critical" && !done);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sev = SEV[alert.severity];
  const kind = KIND[alert.kind] ?? KIND.insight;
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
    <li className={cx("relative before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-r-full", done ? "before:bg-line-strong" : sev.edge)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="press flex min-h-14 w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2"
      >
        <kind.Icon size={17} className={cx("mt-0.5 shrink-0", done ? "text-ink-3" : sev.icon)} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-1.5 text-caption text-ink-3">
            <span className={cx("font-semibold", done ? "text-ink-3" : sev.text)}>{done ? "Handled" : sev.label}</span>
            <span aria-hidden="true">·</span>
            <span>{kind.label}</span>
            <span aria-hidden="true">·</span>
            <span className="num">{relTime(alert.created_at)}</span>
          </span>
          <span className={cx("mt-0.5 block text-body font-medium leading-snug", done && "text-ink-2")}>{alert.title}</span>
        </span>
        <IconChevronDown size={16} className={cx("mt-1 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={panelId} className="px-4 pb-3.5 pl-11">
          <p className="text-label leading-relaxed text-ink-2">{alert.detail}</p>
          <div className="mt-2.5">
            {done ? (
              <p className="inline-flex items-center gap-1.5 text-label text-ink-2">
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

function AlertsPanel({ householdId, className }: { householdId: string; className?: string }) {
  const alerts = useAlerts(householdId);
  const ident = useLocalIdentity();
  const me = ident.name ?? "Someone";
  const open = alerts.filter((a) => !a.acknowledged_by).length;
  return (
    <Panel
      id="alerts"
      title={<>Alerts {alerts.length ? <span className="num font-normal text-ink-3">{alerts.length}</span> : null}</>}
      right={open ? <Chip tone="risk">{open} open</Chip> : alerts.length ? <Chip tone="good">All clear</Chip> : undefined}
      className={className}
      flush
    >
      {alerts.length ? (
        <ul className="divide-y divide-line">{alerts.map((a) => <AlertRow key={a.id} alert={a} me={me} />)}</ul>
      ) : (
        <div className="px-4 pb-3"><Empty title="No alerts">Nothing has been flagged.</Empty></div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ page

export function HouseholdPage({ householdId }: { householdId: string }) {
  return (
    <>
      <PageHeader title="Household" sub="Who is in it, and what needs someone's attention." />
      <div className="grid grid-cols-12 items-start gap-3">
        <PeoplePanel householdId={householdId} className="col-span-12 lg:col-span-6 xl:col-span-5" />
        <AlertsPanel householdId={householdId} className="col-span-12 lg:col-span-6 xl:col-span-7" />
      </div>
    </>
  );
}

