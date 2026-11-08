"use client";
import Link from "next/link";
import { useMemo } from "react";
import { IconBank, IconCap, IconChevron, IconFile, IconLandmark, IconRepeat, IconShield } from "@/components/icons";
import { Chip, Empty, List, ListRow, Panel, PanelLink, Progress } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { goalProgress } from "@/lib/finance";
import { ACCOUNT_GROUPS, cx, usd } from "@/lib/format";
import type { Goal, Obligation } from "@/lib/types";

/** Accounts by type with a subtotal each; the full table lives on My Picture. */
export function AccountsCard({ fin, householdId, className }: { fin: RoomFinance; householdId: string; className?: string }) {
  const groups = useMemo(
    () =>
      ACCOUNT_GROUPS.map((g) => {
        const rows = fin.accounts.filter((a) => g.types.includes(a.type));
        const sum = rows.reduce((s, a) => s + a.balance, 0);
        return { ...g, count: rows.length, sum, plaid: rows.some((a) => a.source === "plaid") };
      }).filter((g) => g.count),
    [fin.accounts],
  );
  const picture = `/room/${householdId}/picture`;
  // A bank link brings everything in: say so once instead of tagging every row.
  const allPlaid = fin.accounts.length > 0 && fin.accounts.every((a) => a.source === "plaid");
  return (
    <Panel
      id="accounts-overview"
      title={<>Accounts <span className="num font-normal text-ink-3">{fin.accounts.length}</span></>}
      sub={allPlaid ? "Synced from Plaid Sandbox" : undefined}
      className={className}
      flush
      footer={<PanelLink href={picture}>All accounts</PanelLink>}
    >
      {groups.length ? (
        <List>
          {groups.map((g) => (
            <ListRow
              key={g.key}
              href={`${picture}#group-${g.key}`}
              title={<>{g.label}{g.count > 1 ? <span className="num ml-1.5 font-normal text-ink-3">{g.count}</span> : null}</>}
              meta={g.plaid && !allPlaid ? <Chip tone="info" title="Synced from Plaid Sandbox">Plaid</Chip> : undefined}
              trailing={<span className={cx(g.liability && "text-risk")}>{g.liability ? usd(-g.sum) : usd(g.sum)}</span>}
              className="[&>a]:min-h-11"
            />
          ))}
        </List>
      ) : (
        <div className="px-4 pb-3"><Empty title="No accounts yet">Connect a bank on My Picture.</Empty></div>
      )}
    </Panel>
  );
}

const KIND_ICON: Record<Obligation["kind"], typeof IconBank> = {
  loan: IconBank, bill: IconFile, subscription: IconRepeat, tuition: IconCap, insurance: IconShield, tax: IconLandmark,
};

export function UpcomingCard({ fin, householdId, className }: { fin: RoomFinance; householdId: string; className?: string }) {
  const rows = fin.upcoming.slice(0, 5);
  return (
    <Panel id="upcoming-obligations" title="Next bills" className={className} flush footer={<PanelLink href={`/room/${householdId}/picture?tab=bills`}>All bills</PanelLink>}>
      <List>
        {rows.map((o) => {
          const Icon = KIND_ICON[o.kind] ?? IconFile;
          return (
            <ListRow
              key={o.id}
              className="[&>div]:min-h-11"
              leading={<span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-2 text-ink-3"><Icon size={15} /></span>}
              title={o.name}
              trailing={usd(o.amount)}
              meta={<span className={cx("num", o.days <= 3 ? "font-semibold text-risk" : o.days <= 7 ? "font-medium text-watch" : "")}>{o.when}</span>}
            />
          );
        })}
        {!rows.length ? <li className="px-4 py-2 text-label text-ink-3">No recurring bills on file.</li> : null}
      </List>
    </Panel>
  );
}

const FEAS: Record<string, { text: string; cls: string }> = {
  on_track: { text: "On track", cls: "text-good" },
  stretch: { text: "Stretch", cls: "text-watch" },
  off_track: { text: "Off track", cls: "text-risk" },
  needs_details: { text: "Needs an amount", cls: "text-ink-3" },
  not_advised: { text: "Not advised", cls: "text-risk" },
};

export function GoalsCard({ goals, fin, householdId, className }: { goals: readonly Goal[]; fin: RoomFinance; householdId: string; className?: string }) {
  const shown = goals.slice(0, 5);
  const href = `/room/${householdId}/goals`;
  return (
    <Panel
      id="shared-goals"
      title={<>Goals <span className="num font-normal text-ink-3">{goals.length}</span></>}
      className={className}
      flush
      footer={<PanelLink href={href}>All goals</PanelLink>}
    >
      <ul className="divide-y divide-line">
        {shown.map((g) => {
          const prog = goalProgress(g, fin.accounts, fin.today);
          const f = g.feasibility ? FEAS[g.feasibility] : null;
          return (
            <li key={g.id}>
              <Link href={href} className="press group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-body font-medium">{g.title}</span>
                    {f ? <span className={cx("shrink-0 text-caption font-medium", f.cls)}>{f.text}</span> : <span className="shrink-0 text-caption text-ink-3">Checking</span>}
                  </span>
                  {prog ? (
                    <span className="mt-2 flex items-center gap-2.5">
                      <Progress value={prog.pct} tone={g.feasibility === "off_track" ? "risk" : g.feasibility === "stretch" ? "watch" : "brand"} label={`${g.title} progress`} className="flex-1" />
                      <span className="num shrink-0 text-caption text-ink-2">{usd(prog.saved, { compact: true })} / {usd(g.target_amount ?? 0, { compact: true })}</span>
                    </span>
                  ) : null}
                </span>
                <IconChevron size={16} className="-mr-1 mt-0.5 shrink-0 text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5" />
              </Link>
            </li>
          );
        })}
        {!shown.length ? <li className="px-4 py-2 text-label text-ink-3">No goals yet. Start Table Mode and the agents will find them.</li> : null}
      </ul>
    </Panel>
  );
}
