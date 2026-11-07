"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { IconCopy, IconUsers } from "@/components/icons";
import { NamePrompt } from "@/components/NamePrompt";
import { Shell } from "@/components/Shell";
import { TraceDock } from "@/components/trace/TraceDrawer";
import { Button, Card, Chip, Skeleton } from "@/components/ui";
import { DEMO_HOUSEHOLD_ID } from "@/lib/constants";
import { joinRoom } from "@/lib/data/actions";
import { useLocalIdentity } from "@/lib/data/identity";
import {
  useAccounts, useAdvisorNotes, useAlerts, useDataReady, useForecast, useGoals, useHealth, useHousehold, useHuddle, useNetWorth,
} from "@/lib/data/hooks";
import { cx, relTime } from "@/lib/format";
import { AccountsPanel, NetWorthCard } from "./AccountsPanel";
import { AlertsPanel } from "./AlertsPanel";
import { BankConnectCard } from "./BankConnectCard";
import { CoachPanel } from "./CoachPanel";
import { ForecastChart } from "./ForecastChart";
import { GoalCards } from "./GoalCards";
import { HealthCards } from "./HealthCards";
import { HuddlePanel } from "./HuddlePanel";
import { PresenceBar } from "./PresenceBar";
import { WhatIfPanel } from "./WhatIfPanel";

type Tab = "overview" | "huddle" | "whatif" | "coach";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "huddle", label: "Huddle" },
  { key: "whatif", label: "What-if" },
  { key: "coach", label: "Coach" },
];

function TabBar({ tab, setTab, tabs, className }: { tab: Tab; setTab: (t: Tab) => void; tabs: typeof TABS; className?: string }) {
  return (
    <div role="tablist" aria-label="Room sections" className={cx("grid gap-1 rounded-2xl border border-line bg-surface p-1 shadow-card", className)} style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          id={`tab-${t.key}`}
          aria-selected={tab === t.key}
          aria-controls={`panel-${t.key}`}
          onClick={() => setTab(t.key)}
          className={cx("h-10 rounded-xl text-[0.88rem] font-semibold transition-colors", tab === t.key ? "bg-brand text-brand-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function AdvisorNotes({ householdId }: { householdId: string }) {
  const notes = useAdvisorNotes(householdId);
  if (!notes.length) return null;
  return (
    <section aria-label="Notes from your advisor">
      <Card className="border-info/40 p-4">
        <h2 className="font-display text-base font-semibold">From your PNC advisor</h2>
        <ul className="mt-2 space-y-2">
          {notes.slice(0, 3).map((n) => (
            <li key={n.id} className="anim-fade rounded-xl bg-info-soft px-3 py-2 text-[0.88rem] leading-snug text-ink">
              <span className="font-semibold">{n.author_name}</span> <span className="text-ink-3">· {relTime(n.created_at)}</span>
              <span className="mt-0.5 block text-ink-2">{n.text}</span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function RoomSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading room">
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="h-36 w-full !rounded-2xl" />
      <div className="grid grid-cols-2 gap-2.5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 !rounded-2xl" />)}</div>
      <Skeleton className="h-64 w-full !rounded-2xl" />
    </div>
  );
}

export function RoomClient({ householdId }: { householdId: string }) {
  const ident = useLocalIdentity();
  const ready = useDataReady();
  const household = useHousehold(householdId);
  const accounts = useAccounts(householdId);
  const nw = useNetWorth(accounts);
  const health = useHealth(householdId);
  const alerts = useAlerts(householdId);
  const goals = useGoals(householdId);
  const forecast = useForecast(householdId);
  const huddle = useHuddle(householdId);
  const [tab, setTab] = useState<Tab>("overview");
  const [copied, setCopied] = useState(false);

  const name = ident.name;
  const role = ident.role;
  const found = !!household;

  // Presence: join when we know who we are and the room exists; step back to the lobby on the way out.
  useEffect(() => {
    if (!ready || !name || !found) return;
    void joinRoom(householdId, name, role);
    return () => {
      void joinRoom("", name, role);
    };
  }, [ready, name, role, found, householdId]);

  async function invite() {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: household?.name ?? "Keystone room", url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* user dismissed the share sheet */
    }
  }

  const rightTab: Tab = tab === "overview" ? "huddle" : tab;
  const isSandbox = householdId.startsWith("hh_sbx_");

  return (
    <Shell mood="me">
      {!ready || (!found && !ready) ? (
        <RoomSkeleton />
      ) : !found ? (
        <Card className="mx-auto mt-8 max-w-md p-6 text-center">
          <h1 className="font-display text-xl font-semibold">We can&apos;t find that room</h1>
          <p className="mt-1 text-sm text-ink-2">It may have been a private sandbox that was reset. The Riveras&apos; room is always open.</p>
          <Link href={`/room/${DEMO_HOUSEHOLD_ID}`} className="mt-4 inline-flex h-11 items-center rounded-xl bg-brand px-5 font-semibold text-brand-ink">Join the Riveras&apos; room</Link>
        </Card>
      ) : (
        <>
          <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display text-[1.65rem] font-bold leading-tight tracking-tight sm:text-3xl">{household.name}</h1>
                {isSandbox ? <Chip tone="accent">Private sandbox</Chip> : <Chip tone="brand"><IconUsers size={12} /> Shared live room</Chip>}
              </div>
              <p className="mt-1 max-w-2xl text-[0.86rem] leading-snug text-ink-2">{household.persona}</p>
            </div>
            <div className="flex min-w-0 items-center gap-3">
              <PresenceBar householdId={householdId} />
              <Button size="sm" variant="secondary" className="shrink-0" onClick={() => void invite()} aria-label="Invite someone to this room"><IconCopy size={15} /> {copied ? "Link copied" : "Invite"}</Button>
            </div>
          </header>

          <TabBar tab={tab} setTab={setTab} tabs={TABS} className="sticky top-[3.75rem] z-20 mb-4 lg:hidden" />

          <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
            <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" className={cx("min-w-0 space-y-6", tab !== "overview" && "hidden lg:block lg:space-y-6")}>
              <NetWorthCard nw={nw} />
              <HealthCards items={health} />
              <AdvisorNotes householdId={householdId} />
              <AlertsPanel alerts={alerts.filter((a) => a.kind !== "advisor")} me={name ?? "Someone"} />
              <ForecastChart points={forecast.points} low={forecast.low_point} />
              <AccountsPanel accounts={accounts} />
              <BankConnectCard householdId={householdId} />
            </div>

            <div className={cx("min-w-0 space-y-6", tab === "overview" && "hidden lg:block")}>
              <TabBar tab={rightTab} setTab={setTab} tabs={TABS.slice(1)} className="hidden lg:grid" />
              <div role="tabpanel" id={`panel-${rightTab}`} aria-labelledby={`tab-${rightTab}`} className="space-y-6">
                {rightTab === "huddle" ? (
                  <>
                    <HuddlePanel householdId={householdId} me={name ?? "Someone"} />
                    <GoalCards goals={goals} since={huddle?.started_at} />
                  </>
                ) : null}
                {rightTab === "whatif" ? <WhatIfPanel householdId={householdId} /> : null}
                {rightTab === "coach" ? <CoachPanel householdId={householdId} me={name ?? "Someone"} /> : null}
              </div>
            </div>
          </div>
          <TraceDock householdId={householdId} />
        </>
      )}
      {ready && !name ? <NamePrompt context={found ? `You're joining ${household?.name ?? "a room"}. Everyone here sees your name next to what you say and do.` : undefined} /> : null}
    </Shell>
  );
}
