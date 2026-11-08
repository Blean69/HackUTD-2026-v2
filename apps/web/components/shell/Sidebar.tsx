"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/icons";
import { LivePill } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { useConnection } from "@/lib/data/connection";
import { useHousehold, useHuddle } from "@/lib/data/hooks";
import { cx } from "@/lib/format";
import { NAV, NAV_GROUPS } from "./nav";

/** One quiet line: where the data comes from and whether it is live. */
function ConnectionLine() {
  const conn = useConnection();
  const down = conn.kind === "spacetime" && !conn.online;
  const ok = conn.status === "ready" && !down;
  return (
    <p className="flex items-center gap-2 px-5 pb-4 text-[0.72rem] text-side-ink-2" role="status">
      <span className={cx("h-1.5 w-1.5 rounded-full", !ok ? "anim-blink bg-white/40" : conn.kind === "spacetime" ? "bg-[#3fd18a]" : "bg-[#e0b04a]")} aria-hidden="true" />
      {conn.status !== "ready" ? "Connecting" : down ? "Reconnecting" : conn.kind === "spacetime" ? "Live on SpacetimeDB" : "Offline demo data"}
    </p>
  );
}

export function Sidebar({ householdId, onNavigate, className }: { householdId: string; onNavigate?: () => void; className?: string }) {
  const path = usePathname() ?? "/";
  const huddle = useHuddle(householdId);
  const household = useHousehold(householdId);
  const live = huddle?.status === "live";
  return (
    <aside className={cx("flex h-full w-full flex-col bg-side text-side-ink", className)} aria-label="Sidebar">
      <Link href="/" onClick={onNavigate} className="on-dark flex items-center gap-2.5 px-5 pb-5 pt-5" aria-label={`${PRODUCT_NAME} home`}>
        <BrandMark size={30} />
        <span className="min-w-0 leading-tight">
          <span className="block text-[1.1rem] font-semibold tracking-tight text-white">{PRODUCT_NAME}</span>
          {household ? <span className="block truncate text-[0.78rem] text-side-ink-2">{household.name}</span> : null}
        </span>
      </Link>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="Primary">
        {NAV_GROUPS.map((g, gi) => (
          <div key={gi} className={cx(gi > 0 && "mt-5")}>
            {g.label ? <p className="mb-1 px-3 text-[0.68rem] font-semibold uppercase tracking-[0.1em] text-side-ink-2">{g.label}</p> : null}
            <ul className="space-y-0.5">
              {g.keys.map((k) => {
                const n = NAV.find((x) => x.key === k);
                if (!n) return null;
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
          </div>
        ))}
      </nav>

      <ConnectionLine />
    </aside>
  );
}
