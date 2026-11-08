"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { IconPlus, IconSpark } from "@/components/icons";
import { Avatar, Button, IconButton } from "@/components/ui";
import { CallBrianButton } from "@/components/phone/CallBrianButton";
import { TalkButton } from "@/components/voice/TalkButton";
import { InviteDialog } from "./InviteDialog";
import { PRODUCT_NAME } from "@/lib/constants";
import { useHousehold, useMembers, usePresence } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { openCoach } from "@/lib/traceUi";
import { AgentActivityButton } from "./AppShell";
import { NotificationsBell } from "./NotificationsBell";

const first = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

/** Members first (presence dot when someone with that name is in the room), then any other visitors. Links to Household. */
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
    // Whoever is here now comes first, so the stack shows the room, not the roster.
    return [...list, ...guests].sort((a, b) => Number(b.online) - Number(a.online));
  }, [members, present]);
  // Three faces and a count: at 28 px the initials stay readable even on a 375 px phone.
  const shown = people.slice(0, 3);
  const online = people.filter((p) => p.online).length;
  return (
    <Link href={`/room/${householdId}/household`} className="flex items-center rounded-full" aria-label={`Household: ${people.length} people, ${online} here now`}>
      <span className="flex items-center -space-x-0.5">
        {shown.map((p) => (
          <Avatar key={p.key} name={p.name} size={28} ring="bg" dot={p.online ? "online" : undefined} />
        ))}
        {people.length > shown.length ? (
          <span className="num relative flex h-7 min-w-7 items-center justify-center rounded-full bg-surface-3 px-1.5 text-2xs font-semibold text-ink-2 ring-2 ring-bg">+{people.length - shown.length}</span>
        ) : null}
      </span>
    </Link>
  );
}

/** One line: the household's name and who is here, then (from md up) the room's actions. */
export function RoomHeader({ householdId }: { householdId: string }) {
  const household = useHousehold(householdId);
  const ident = useLocalIdentity();
  const [inviting, setInviting] = useState(false);

  return (
    <header className="flex items-center gap-3 px-4 pb-3 pt-4 sm:px-6 md:pt-5">
      <h1 className="display min-w-0 truncate text-[1.3rem] leading-tight text-ink sm:text-[1.5rem]">{household?.name ?? "Household"}</h1>
      <div className="flex shrink-0 items-center gap-1.5">
        <People householdId={householdId} />
        <IconButton label="Add people to this room" onClick={() => setInviting(true)} className="h-7 w-7 rounded-full border border-dashed border-line-strong text-ink-3 hover:border-ink-3 hover:bg-surface">
          <IconPlus size={14} />
        </IconButton>
        {inviting ? <InviteDialog householdId={householdId} name={household?.name ?? "this household"} onClose={() => setInviting(false)} /> : null}
      </div>
      <span className="flex-1" />
      {/* Phones reach these from the top bar and the tab bar instead. */}
      <div className="hidden shrink-0 items-center gap-2 md:flex">
        <Button variant="secondary" onClick={openCoach}>
          <IconSpark size={16} className="text-brand-strong" /> Ask {PRODUCT_NAME}
        </Button>
        <TalkButton variant="header" />
        <CallBrianButton variant="header" />
        <span className="mx-0.5 h-5 w-px bg-line-strong" aria-hidden="true" />
        <AgentActivityButton householdId={householdId} bordered />
        <NotificationsBell householdId={householdId} me={ident.name ?? "Someone"} />
      </div>
    </header>
  );
}
