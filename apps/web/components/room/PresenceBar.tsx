"use client";
import { Avatar, Chip } from "@/components/ui";
import { usePresence } from "@/lib/data/hooks";

export function PresenceBar({ householdId }: { householdId: string }) {
  const people = usePresence(householdId);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3" aria-label="Who's in this room" role="group">
      <ul className="flex shrink-0 -space-x-2" aria-hidden="true">
        {people.slice(0, 6).map((p) => (
          <li key={p.identity}><Avatar name={p.display_name} size={30} ring /></li>
        ))}
      </ul>
      <p className="min-w-0 text-[0.8rem] leading-tight text-ink-2">
        <span className="font-semibold text-ink">{people.length} here now</span>
        <span className="sr-only">: </span>
        <span className="block truncate">
          {people.map((p) => (p.isMe ? "You" : p.display_name)).join(", ") || "Just you"}
        </span>
      </p>
      <span className="hidden gap-1 sm:flex">
        {people.some((p) => p.role === "advisor") ? <Chip tone="info">advisor present</Chip> : null}
      </span>
    </div>
  );
}
