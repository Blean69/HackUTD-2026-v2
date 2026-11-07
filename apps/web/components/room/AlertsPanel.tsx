"use client";
import { useState } from "react";
import { IconAlert, IconBell, IconCheck, IconChevronDown, IconShield } from "@/components/icons";
import { Button, Chip, SectionTitle, type Tone } from "@/components/ui";
import { ackAlert } from "@/lib/data/actions";
import { cx, relTime } from "@/lib/format";
import type { Alert, AlertKind, AlertSeverity } from "@/lib/types";

const SEV: Record<AlertSeverity, { tone: Tone; label: string; edge: string }> = {
  critical: { tone: "risk", label: "Critical", edge: "bg-risk" },
  warn: { tone: "watch", label: "Heads up", edge: "bg-watch" },
  info: { tone: "info", label: "FYI", edge: "bg-info" },
};
const KIND: Record<AlertKind, { label: string; Icon: typeof IconAlert }> = {
  fraud: { label: "Fraud", Icon: IconShield },
  scam: { label: "Scam Shield", Icon: IconShield },
  data_quality: { label: "Data quality", Icon: IconAlert },
  obligation: { label: "Upcoming", Icon: IconBell },
  advisor: { label: "Advisor", Icon: IconBell },
};

function AlertRow({ a, me }: { a: Alert; me: string }) {
  const [open, setOpen] = useState(a.severity === "critical" && !a.acknowledged_by);
  const [busy, setBusy] = useState(false);
  const sev = SEV[a.severity];
  const kind = KIND[a.kind];
  const done = !!a.acknowledged_by;
  return (
    <li className={cx("relative overflow-hidden rounded-2xl border border-line bg-surface shadow-card", done && "opacity-70")}>
      <span className={cx("absolute inset-y-0 left-0 w-1.5", done ? "bg-line-strong" : sev.edge)} aria-hidden="true" />
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-3 py-3 pl-5 pr-3 text-left">
        <kind.Icon size={18} className={cx("mt-0.5 shrink-0", done ? "text-ink-3" : a.severity === "critical" ? "text-risk" : a.severity === "warn" ? "text-watch" : "text-info")} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <Chip tone={done ? "neutral" : sev.tone}>{done ? "Handled" : sev.label}</Chip>
            <Chip>{kind.label}</Chip>
            <span className="text-[0.72rem] text-ink-3">{relTime(a.created_at)}</span>
          </span>
          <span className="mt-1 block text-[0.92rem] font-semibold leading-snug">{a.title}</span>
        </span>
        <IconChevronDown size={16} className={cx("mt-1 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="pb-3 pl-12 pr-4">
          <p className="text-[0.85rem] leading-relaxed text-ink-2">{a.detail}</p>
          <div className="mt-2.5 flex items-center gap-2">
            {done ? (
              <p className="inline-flex items-center gap-1.5 text-[0.8rem] text-ink-2"><IconCheck size={14} className="text-good" /> Acknowledged by {a.acknowledged_by}</p>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await ackAlert(a.id, me);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <IconCheck size={15} /> I&apos;ve handled this
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function AlertsPanel({ alerts, me }: { alerts: readonly Alert[]; me: string }) {
  const open = alerts.filter((a) => !a.acknowledged_by).length;
  return (
    <section aria-labelledby="alerts-h">
      <SectionTitle id="alerts-h" title="Alerts" sub={open ? `${open} need a look. Everyone in the room sees updates live.` : "All clear. Nothing needs attention."} />
      {alerts.length ? (
        <ul className="space-y-2.5">{alerts.map((a) => <AlertRow key={a.id} a={a} me={me} />)}</ul>
      ) : (
        <p className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-sm text-ink-2">No alerts for this household.</p>
      )}
    </section>
  );
}
