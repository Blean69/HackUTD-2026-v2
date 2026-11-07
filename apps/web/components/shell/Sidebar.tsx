"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { BrandMark } from "@/components/icons";
import { Avatar, LivePill } from "@/components/ui";
import { CHALLENGE_NOTE, PRODUCT_NAME } from "@/lib/constants";
import { useConnection } from "@/lib/data/connection";
import { useHuddle, useMembers, usePresence } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { cx } from "@/lib/format";
import { NAV } from "./nav";

const first = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

/** The people block: household members with a live dot when someone with that name is in the room, then other visitors. */
function HouseholdBlock({ householdId }: { householdId: string }) {
  const members = useMembers(householdId);
  const present = usePresence(householdId);
  const ident = useLocalIdentity();
  const rows = useMemo(() => {
    const used = new Set<string>();
    const list = members.map((m) => {
      const hit = present.find((p) => first(p.display_name) === first(m.name) && !used.has(p.identity));
      if (hit) used.add(hit.identity);
      return { key: m.id, name: m.name, online: !!hit, me: !!hit?.isMe || (!!ident.name && first(ident.name) === first(m.name)) };
    });
    const guests = present.filter((p) => !used.has(p.identity)).map((p) => ({ key: p.identity, name: p.display_name, online: true, me: p.isMe }));
    return [...list, ...guests];
  }, [members, present, ident.name]);
  if (!rows.length) return null;
  return (
    <div className="mt-4 border-t border-side-line px-3 pt-3">
      <p className="px-2 text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-side-ink-2">Household</p>
      <ul className="mt-1.5 space-y-0.5" aria-label="Household members">
        {rows.slice(0, 9).map((r) => (
          <li key={r.key} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <Avatar name={r.name} size={26} />
            <span className="min-w-0 flex-1 truncate text-[0.84rem] text-side-ink">
              {r.name.split(" ")[0]}
              {r.me ? <span className="text-side-ink-2"> (You)</span> : null}
            </span>
            <span className={cx("h-2 w-2 shrink-0 rounded-full", r.online ? "bg-[#3fd18a]" : "bg-white/20")} role="img" aria-label={r.online ? "Online" : "Offline"} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Sidebar({ householdId, onNavigate, className }: { householdId: string; onNavigate?: () => void; className?: string }) {
  const path = usePathname() ?? "/";
  const huddle = useHuddle(householdId);
  const conn = useConnection();
  const live = huddle?.status === "live";
  const down = conn.kind === "spacetime" && !conn.online;
  return (
    <aside className={cx("flex h-full w-full flex-col bg-side text-side-ink", className)} aria-label="Sidebar">
      <Link href="/" onClick={onNavigate} className="on-dark flex items-center gap-2.5 px-5 pb-4 pt-5" aria-label={`${PRODUCT_NAME} home`}>
        <BrandMark size={34} />
        <span className="leading-tight">
          <span className="block text-[1.15rem] font-semibold tracking-tight text-white">{PRODUCT_NAME}</span>
          <span className="block text-[0.8rem] text-side-ink-2">Household</span>
        </span>
      </Link>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="Primary">
        <ul className="space-y-0.5">
          {NAV.map((n) => {
            const active = n.match(path, householdId);
            return (
              <li key={n.key}>
                <Link
                  href={n.href(householdId)}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "on-dark flex h-10 items-center gap-3 rounded-md px-3 text-[0.9rem] font-medium transition-colors",
                    active ? "bg-side-2 text-white" : "text-side-ink hover:bg-white/5",
                  )}
                >
                  <n.Icon size={19} />
                  <span className="flex-1 truncate">{n.label}</span>
                  {n.live && live ? <LivePill dark /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
        <HouseholdBlock householdId={householdId} />
      </nav>

      <div className="px-3 pb-3">
        <div className="rounded-lg border border-side-line p-3">
          <p className="text-[0.76rem] leading-snug text-side-ink">{CHALLENGE_NOTE}</p>
          <p className="mt-2 flex items-center gap-1.5 text-[0.7rem] text-side-ink-2">
            <span className={cx("h-1.5 w-1.5 rounded-full", conn.status !== "ready" || down ? "anim-blink bg-white/40" : conn.kind === "spacetime" ? "bg-[#3fd18a]" : "bg-[#e0b04a]")} aria-hidden="true" />
            {conn.status !== "ready" ? "Connecting" : down ? "Reconnecting" : conn.kind === "spacetime" ? "Live on SpacetimeDB" : "Offline demo data"}
          </p>
        </div>
      </div>
    </aside>
  );
}
