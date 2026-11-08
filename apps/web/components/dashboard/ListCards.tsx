"use client";
import Link from "next/link";
import { useMemo } from "react";
import { IconBank, IconCap, IconChevron, IconFile, IconLandmark, IconRepeat, IconShield } from "@/components/icons";
import { Chip, Empty, Panel, Progress } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { goalProgress } from "@/lib/finance";
import { ACCOUNT_GROUPS, cx, usd } from "@/lib/format";
import type { Goal, Obligation } from "@/lib/types";
import { ViewAll } from "./AnalysisCards";

/** A row that goes somewhere: hover fill and a chevron say so. Plain readouts elsewhere have neither. */
const rowLink = "-mx-2 flex items-center gap-2.5 rounded-md px-2 py-2 hover:bg-surface-2";

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
      title={<>Accounts <span className="font-normal text-ink-3">({fin.accounts.length})</span></>}
      sub={allPlaid ? "Synced from Plaid Sandbox" : undefined}
      className={className}
      right={<ViewAll href={picture}>All accounts</ViewAll>}
    >
      {groups.length ? (
        <ul className="-my-1">
          {groups.map((g) => (
            <li key={g.key}>
              <Link href={`${picture}#group-${g.key}`} className={rowLink}>
                <span className="min-w-0 flex-1 truncate text-[0.88rem] font-medium">
                  {g.label}
                  {g.count > 1 ? <span className="num ml-1.5 font-normal text-ink-3">{g.count}</span> : null}
                </span>
                {g.plaid && !allPlaid ? <Chip tone="info" title="Synced from Plaid Sandbox">Plaid</Chip> : null}
                <span className={cx("num text-[0.88rem] font-semibold", g.liability && "text-risk")}>{g.liability ? usd(-g.sum) : usd(g.sum)}</span>
                <IconChevron size={14} className="text-ink-3" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No accounts yet">Connect a bank on My Picture.</Empty>
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
    <Panel id="upcoming-obligations" title="Next bills" className={className} right={<ViewAll href={`/room/${householdId}/picture?tab=bills`}>All bills</ViewAll>}>
      <ul className="divide-y divide-line">
        {rows.map((o) => {
          const Icon = KIND_ICON[o.kind] ?? IconFile;
          return (
            <li key={o.id} className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
              <span className="text-ink-3"><Icon size={17} /></span>
              <span className="min-w-0 flex-1 truncate text-[0.86rem] font-medium">{o.name}</span>
              <span className="num shrink-0 text-[0.84rem] text-ink-2">{usd(o.amount)}</span>
              <span className={cx("num w-[4.6rem] shrink-0 text-right text-[0.8rem]", o.days <= 3 ? "font-semibold text-risk" : o.days <= 7 ? "font-medium text-watch" : "text-ink-3")}>{o.when}</span>
            </li>
          );
        })}
        {!rows.length ? <li className="text-[0.84rem] text-ink-3">No recurring bills on file.</li> : null}
      </ul>
    </Panel>
  );
}

const FEAS: Record<string, { text: string; cls: string }> = {
  on_track: { text: "On track", cls: "text-good" },
  stretch: { text: "Stretch", cls: "text-watch" },
  off_track: { text: "Off track", cls: "text-risk" },
};

export function GoalsCard({ goals, fin, householdId, className }: { goals: readonly Goal[]; fin: RoomFinance; householdId: string; className?: string }) {
  const shown = goals.slice(0, 4);
  const href = `/room/${householdId}/goals`;
  return (
    <Panel id="shared-goals" title={<>Goals <span className="font-normal text-ink-3">({goals.length})</span></>} className={className} right={<ViewAll href={href}>All goals</ViewAll>}>
      <ul className="-my-1">
        {shown.map((g) => {
          const prog = goalProgress(g, fin.accounts, fin.today);
          const f = g.feasibility ? FEAS[g.feasibility] : null;
          return (
            <li key={g.id}>
              <Link href={href} className={cx(rowLink, "items-start")}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[0.88rem] font-medium">{g.title}</span>
                    {f ? <span className={cx("shrink-0 text-[0.76rem] font-medium", f.cls)}>{f.text}</span> : <span className="shrink-0 text-[0.76rem] text-ink-3">Checking</span>}
                  </span>
                  {prog ? (
                    <span className="mt-1.5 flex items-center gap-2">
                      <Progress value={prog.pct} tone={g.feasibility === "off_track" ? "risk" : g.feasibility === "stretch" ? "watch" : "brand"} label={`${g.title} progress`} className="flex-1" />
                      <span className="num shrink-0 text-[0.76rem] text-ink-2">{usd(prog.saved, { compact: true })} / {usd(g.target_amount ?? 0, { compact: true })}</span>
                    </span>
                  ) : null}
                </span>
                <IconChevron size={14} className="mt-1 shrink-0 text-ink-3" />
              </Link>
            </li>
          );
        })}
        {!shown.length ? <li className="py-1 text-[0.84rem] text-ink-3">No goals yet. Start Table Mode and the agents will find them.</li> : null}
      </ul>
    </Panel>
  );
}
