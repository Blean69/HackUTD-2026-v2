"use client";
import { useConnection } from "@/lib/data/connection";
import { cx } from "@/lib/format";

/** Tells the team (and curious judges) whether they are on live SpacetimeDB or the offline demo engine. */
export function ConnectionBadge({ className }: { className?: string }) {
  const c = useConnection();
  const live = c.kind === "spacetime";
  const down = live && !c.online;
  const label = c.status !== "ready" ? "Connecting" : down ? "Reconnecting" : live ? "Live" : "Demo data";
  const title = c.status !== "ready" ? "Connecting…" : down ? `Lost the connection to SpacetimeDB, retrying. ${c.detail}`.trim() : live ? "Connected to SpacetimeDB: changes sync live across every phone" : `Offline demo engine. ${c.detail}`.trim();
  return (
    <span
      title={title}
      className={cx("inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[0.72rem] font-medium text-ink-2", className)}
    >
      <span className={cx("h-2 w-2 rounded-full", c.status !== "ready" || down ? "bg-ink-3 anim-blink" : live ? "bg-good" : "bg-accent")} aria-hidden="true" />
      <span>{label}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}
