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
import { ThemeToggle } from "./ThemeToggle";

/** One quiet line: whether the data is live. */
function ConnectionLine() {
  const conn = useConnection();
  const down = conn.kind === "spacetime" && !conn.online;
  const ok = conn.status === "ready" && !down;
  return (
    <p className="flex min-w-0 items-center gap-2 text-caption text-ink-3" role="status">
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", !ok ? "anim-blink bg-ink-3" : conn.kind === "spacetime" ? "bg-online" : "bg-watch")} aria-hidden="true" />
      <span className="truncate">{conn.status !== "ready" ? "Connecting" : down ? "Reconnecting" : conn.kind === "spacetime" ? "Live" : "Offline demo data"}</span>
    </p>
  );
}

/**
 * The sidebar: flush with the canvas and separated by a hairline, so the content is the brightest layer. The active item
 * is a raised surface with an accent icon; groups are labelled with small caps.
 */
export function Sidebar({ householdId, onNavigate, className }: { householdId: string; onNavigate?: () => void; className?: string }) {
  const path = usePathname() ?? "/";
  const huddle = useHuddle(householdId);
  const household = useHousehold(householdId);
  const live = huddle?.status === "live";
  return (
    <aside className={cx("side-green flex h-full w-full flex-col border-r border-line bg-side text-ink-2", className)} aria-label="Sidebar">
      <Link href={householdId ? `/room/${householdId}` : "/"} onClick={onNavigate} className="flex items-center gap-2.5 px-4 pb-5 pt-5" aria-label="Dashboard">
        <BrandMark size={28} />
        <span className="min-w-0 leading-tight">
          <span className="display block text-[1.05rem] text-ink">{PRODUCT_NAME}</span>
          {household ? <span className="block truncate text-caption text-ink-3">{household.name}</span> : null}
        </span>
      </Link>

      <nav className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2.5 pb-3" aria-label="Primary">
        {NAV_GROUPS.map((g, gi) => (
          <div key={gi} className={cx(gi > 0 && "mt-5")}>
            {g.label ? <p className="eyebrow mb-1.5 px-2.5">{g.label}</p> : null}
            <ul className="space-y-px">
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
                        "group flex h-9 items-center gap-2.5 rounded-md px-2.5 text-label font-medium transition-colors",
                        active ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-surface-3/70 hover:text-ink",
                      )}
                    >
                      <span className={cx("shrink-0 transition-colors", active ? "text-brand-strong" : "text-ink-3 group-hover:text-ink-2")}>
                        <n.Icon size={18} />
                      </span>
                      <span className="flex-1 truncate">{n.label}</span>
                      {n.live && live ? <LivePill /> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
        <ConnectionLine />
        <ThemeToggle />
      </div>
    </aside>
  );
}
