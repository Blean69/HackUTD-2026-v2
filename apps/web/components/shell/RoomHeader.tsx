"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { IconBroadcast, IconCalendar, IconChevronDown, IconPlus, IconUsers } from "@/components/icons";
import { Avatar, Chip, IconButton, selectCls } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { useAccounts, useHousehold, useHuddle, useHealth, useMembers, usePresence } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { RANGE_OPTIONS, lastUpdated, type RangeKey } from "@/lib/finance";
import { cx, relTime } from "@/lib/format";
import { setRange, useRange } from "@/lib/rangeUi";
import { AgentActivityButton } from "./AppShell";
import { NotificationsBell } from "./NotificationsBell";

const first = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

/** Members first (green dot when someone with that name is in the room), then any other visitors. */
function People({ householdId }: { householdId: string }) {
  const members = useMembers(householdId);
  const present = usePresence(householdId);
  const people = useMemo(() => {
    const used = new Set<string>();
    const list = members.filter((m) => m.role !== "child" || present.some((p) => first(p.display_name) === first(m.name))).map((m) => {
      const hit = present.find((p) => first(p.display_name) === first(m.name) && !used.has(p.identity));
      if (hit) used.add(hit.identity);
      return { key: m.id, name: m.name, online: !!hit };
    });
    const guests = present.filter((p) => !used.has(p.identity)).map((p) => ({ key: p.identity, name: p.display_name, online: true }));
    return [...list, ...guests];
  }, [members, present]);
  const shown = people.slice(0, 5);
  const online = people.filter((p) => p.online).length;
  return (
    <ul className="flex items-center -space-x-1.5" aria-label={`${online} online now`}>
      {shown.map((p) => (
        <li key={p.key} title={`${p.name}${p.online ? " (online)" : ""}`}>
          <Avatar name={p.name} size={34} ring dot={p.online ? "online" : "off"} />
          <span className="sr-only">{p.name}, {p.online ? "online" : "offline"}</span>
        </li>
      ))}
      {people.length > shown.length ? (
        <li className="z-0 flex h-[34px] w-[34px] items-center justify-center rounded-full bg-surface-2 text-[0.72rem] font-semibold text-ink-2 ring-2 ring-surface">+{people.length - shown.length}</li>
      ) : null}
    </ul>
  );
}

export function RoomHeader({ householdId }: { householdId: string }) {
  const path = usePathname() ?? "";
  const household = useHousehold(householdId);
  const members = useMembers(householdId);
  const accounts = useAccounts(householdId);
  const health = useHealth(householdId);
  const huddle = useHuddle(householdId);
  const ident = useLocalIdentity();
  const { range } = useRange();
  const [copied, setCopied] = useState(false);
  const live = huddle?.status === "live";
  const isSandbox = householdId.startsWith("hh_sbx_");
  const showRange = path === `/room/${householdId}` || path.endsWith("/analytics");
  const updated = lastUpdated(health, household?.created_at);

  async function invite() {
    const url = window.location.origin + `/room/${householdId}`;
    try {
      if (navigator.share) await navigator.share({ title: household?.name ?? `${PRODUCT_NAME} room`, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* the share sheet was dismissed */
    }
  }

  return (
    <header className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 pb-1 pt-4 sm:px-6 md:pt-5">
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[1.4rem] font-semibold leading-tight tracking-tight sm:text-[1.6rem]">{household?.name ?? "Household"}</h1>
          <span className="text-ink-3" aria-hidden="true"><IconUsers size={20} /></span>
          {isSandbox ? <Chip tone="accent">Private copy</Chip> : null}
        </div>
        <p className="mt-0.5 text-[0.82rem] text-ink-2">
          <span className="num">{members.length}</span> members · Shared goals · <span className="num">{accounts.length}</span> accounts
          {updated ? <> · Last updated <span className="num">{relTime(updated)}</span></> : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
        <div className="flex items-center gap-2">
          <People householdId={householdId} />
          <IconButton label={copied ? "Link copied" : "Invite someone to this room"} onClick={() => void invite()} className="h-[34px] w-[34px] rounded-full border border-line-strong bg-surface">
            <IconPlus size={16} />
          </IconButton>
          {copied ? <span role="status" className="text-[0.72rem] font-medium text-good">Link copied</span> : null}
        </div>

        {showRange ? (
          <label className="relative hidden items-center sm:inline-flex">
            <span className="sr-only">Date range</span>
            <IconCalendar size={16} className="pointer-events-none absolute left-2.5 text-ink-2" />
            <select value={range} onChange={(e) => setRange(e.target.value as RangeKey)} className={cx(selectCls, "h-10 appearance-none pl-8 pr-8")}>
              {RANGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <IconChevronDown size={14} className="pointer-events-none absolute right-2.5 text-ink-2" />
          </label>
        ) : null}

        <Link
          href={`/room/${householdId}/table`}
          className="on-dark inline-flex h-10 items-center gap-2 rounded-md bg-dark px-3.5 text-[0.88rem] font-semibold text-white hover:bg-[var(--dark-hover)]"
        >
          <IconBroadcast size={17} />
          Table Mode
          {live ? <span className="anim-blink h-1.5 w-1.5 rounded-full bg-[#3fd18a]" aria-label="live now" /> : null}
        </Link>
        <span className="hidden items-center gap-2.5 md:flex">
          <AgentActivityButton householdId={householdId} />
          <NotificationsBell householdId={householdId} me={ident.name ?? "Someone"} />
        </span>
      </div>
    </header>
  );
}
